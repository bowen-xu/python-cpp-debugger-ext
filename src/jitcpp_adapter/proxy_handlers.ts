import * as vscode from "vscode";
import {
    DapMessage,
    DapRequest,
    DapResponse,
    DapEvent,
} from "./data_types";
import {
    BreakpointContext,
    applySetBreakpointsResponse,
    handleBreakpointLocations,
    handleSetBreakpoints,
    refreshLldbBreakpoints,
} from "./proxy_breakpoints";
import { DebugpyState, LldbState, SessionState } from "./proxy_types";
import { ShutdownManager } from "./proxy_shutdown";

export type HandlerContext = {
    session: SessionState;
    debugpyState: DebugpyState;
    lldbState: LldbState;
    breakpointContext: BreakpointContext;
    shutdownManager: ShutdownManager;
    config: vscode.DebugConfiguration;
    output: vscode.OutputChannel;
    sendToClient: (message: DapMessage) => void;
};

export type ProxyHandlers = {
    handleClientMessage: (message: DapMessage) => void;
    handleDebugpyMessage: (message: DapMessage) => void;
    handleLldbMessage: (message: DapMessage) => void;
};

// Forward a client request to LLDB with a new sequence id.
// Steps:
// 1) Guard if LLDB isn't connected.
// 2) Re-sequence and record client mapping.
// 3) Send to LLDB.
export function forwardClientRequestToLldb(
    request: DapRequest,
    lldbState: LldbState,
): void {
    // Forward a request and remember how to map the response back to VS Code.
    if (!lldbState.connection) {
        return;
    }
    const lldbRequest: DapRequest = {
        ...request,
        seq: lldbState.seq++,
    };
    lldbState.pendingClientRequests.set(lldbRequest.seq, {
        clientSeq: request.seq,
        command: request.command,
    });
    lldbState.connection.send(lldbRequest);
}

// Forward a client request to debugpy with a new sequence id.
// Steps:
// 1) Re-sequence and record client mapping.
// 2) Send to debugpy.
export function forwardClientRequestToDebugpy(
    request: DapRequest,
    debugpyState: DebugpyState,
    responseCommand?: string,
): void {
    const debugpyRequest: DapRequest = {
        ...request,
        seq: debugpyState.seq++,
    };
    debugpyState.pendingClientRequests.set(debugpyRequest.seq, {
        clientSeq: request.seq,
        command: responseCommand ?? request.command,
    });
    debugpyState.connection.send(debugpyRequest);
}

// Create bound handlers for client/debugpy/lldb messages.
// Steps:
// 1) Build a client handler that routes commands.
// 2) Build a debugpy handler that merges responses and emits events.
// 3) Build an LLDB handler that merges responses and refreshes state.
export function createHandlers(context: HandlerContext): ProxyHandlers {
    // Handle messages from the VS Code client.
    const handleClientMessage = (message: DapMessage): void => {
        if (message.type !== "request") {
            return;
        }

        if (message.command === "disconnect" || message.command === "terminate") {
            context.output.appendLine(
                `[client] ${message.command} seq=${message.seq} args=${JSON.stringify(message.arguments ?? {})}`,
            );
        }

        switch (message.command) {
            case "initialize": {
                // Let both adapters initialize and report their capabilities.
                forwardClientRequestToDebugpy(message, context.debugpyState);
                if (context.lldbState.connection) {
                    // LLDB needs its own sequence space and request tracking.
                    const lldbRequest: DapRequest = {
                        ...message,
                        seq: context.lldbState.seq++,
                    };
                    context.lldbState.pendingRequests.set(lldbRequest.seq, message.command);
                    context.lldbState.connection.send(lldbRequest);
                }
                return;
            }
            case "breakpointLocations": {
                // Keep JIT breakpoints stable; do not let debugpy move them.
                handleBreakpointLocations(context.breakpointContext, message);
                return;
            }
            case "launch":
            case "attach": {
                // Start the Python debug session via debugpy.
                forwardClientRequestToDebugpy(message, context.debugpyState);
                // debugpy requires configurationDone during launch/attach.
                const configDone: DapRequest = {
                    seq: context.debugpyState.seq++,
                    type: "request",
                    command: "configurationDone",
                };
                context.debugpyState.pendingSyntheticConfigDone.add(configDone.seq);
                context.debugpyState.connection.send(configDone);
                return;
            }
            case "setBreakpoints": {
                // Split breakpoints between debugpy and LLDB.
                handleSetBreakpoints(context.breakpointContext, message);
                return;
            }
            case "configurationDone": {
                // We already sent configurationDone to debugpy.
                const response: DapResponse = {
                    seq: context.session.clientSeq++,
                    type: "response",
                    request_seq: message.seq,
                    command: "configurationDone",
                    success: true,
                };
                context.sendToClient(response);
                return;
            }
            case "disconnect":
            case "terminate": {
                // Termination is coordinated across adapters to avoid double-kill.
                context.shutdownManager.handleTerminateRequest(message);
                return;
            }
            default:
                if (
                    shouldRouteToLldb(message.command, context.session.activeAdapter) &&
                    context.lldbState.connection &&
                    context.lldbState.available
                ) {
                    // When native code is stopped, route stepping/stack/eval to LLDB.
                    forwardClientRequestToLldb(message, context.lldbState);
                }
                else {
                    // Otherwise, route to debugpy.
                    forwardClientRequestToDebugpy(message, context.debugpyState);
                }
                return;
        }
    };

    // Handle messages coming from debugpy.
    const handleDebugpyMessage = (message: DapMessage): void => {
        // Messages coming from debugpy (Python debugger).
        if (message.type === "response" && message.command === "setBreakpoints") {
            const pending = context.debugpyState.pendingSetBreakpoints.get(message.request_seq);
            if (pending) {
                // Merge partial breakpoint results back into original order.
                context.debugpyState.pendingSetBreakpoints.delete(message.request_seq);
                applySetBreakpointsResponse(context.breakpointContext, pending, message);
                return;
            }
        }

        if (
            message.type === "response" &&
            message.command === "configurationDone" &&
            context.debugpyState.pendingSyntheticConfigDone.has(message.request_seq)
        ) {
            // Ignore the synthetic configurationDone response.
            context.debugpyState.pendingSyntheticConfigDone.delete(message.request_seq);
            return;
        }

        if (message.type === "response") {
            const clientPending =
                context.debugpyState.pendingClientRequests.get(message.request_seq);
            if (clientPending) {
                // Map debugpy response back to the original client request.
                context.debugpyState.pendingClientRequests.delete(message.request_seq);
                context.sendToClient(
                    mapAdapterResponseToClient(context, message, clientPending),
                );
                if (
                    clientPending.command === "disconnect" ||
                    clientPending.command === "terminate"
                ) {
                    context.shutdownManager.handleDebugpyTerminateResponse(
                        clientPending.command,
                        message,
                    );
                }
                return;
            }
        }

        if (message.type === "event" && message.event === "process") {
            // Attach LLDB after debugpy reports the process id.
            handleDebugpyProcessEvent(context, message);
        }

        if (message.type === "event" && message.event === "stopped") {
            // Python stopped -> route stepping to debugpy.
            context.session.activeAdapter = "debugpy";
        }

        if (message.type === "event" && message.event === "terminated") {
            context.session.terminatedEventSeen = true;
        }

        if (message.type === "event" && message.event === "exited") {
            context.session.exitedEventSeen = true;
        }

        context.sendToClient(message);
    };

    // Handle messages coming from LLDB.
    const handleLldbMessage = (message: DapMessage): void => {
        if (context.session.shutdownRequested && message.type === "event") {
            // Suppress LLDB events during shutdown to avoid noisy UI updates.
            return;
        }
        // Messages coming from LLDB (native debugger).
        if (message.type === "response") {
            const pending = context.lldbState.pendingSetBreakpoints.get(message.request_seq);
            if (pending) {
                // Merge partial breakpoint results back into original order.
                context.lldbState.pendingSetBreakpoints.delete(message.request_seq);
                applySetBreakpointsResponse(context.breakpointContext, pending, message);
                return;
            }

            if (context.lldbState.pendingRequests.has(message.request_seq)) {
                const pendingCommand =
                    context.lldbState.pendingRequests.get(message.request_seq);
                context.lldbState.pendingRequests.delete(message.request_seq);
                if (!message.success) {
                    context.output.appendLine(
                        `LLDB request ${message.command} failed: ${message.message ?? "unknown error"}`,
                    );
                } else if (message.command === "attach") {
                    // Once attached, refresh cached JIT breakpoints.
                    refreshLldbBreakpoints(context.breakpointContext);
                }
                if (pendingCommand === "disconnect" || pendingCommand === "terminate") {
                    context.shutdownManager.handleLldbTerminateResponse(
                        pendingCommand,
                        message,
                    );
                }
                return;
            }

            const clientPending =
                context.lldbState.pendingClientRequests.get(message.request_seq);
            if (clientPending) {
                // Map LLDB response back to the original client request.
                context.lldbState.pendingClientRequests.delete(message.request_seq);
                context.sendToClient(
                    mapAdapterResponseToClient(context, message, clientPending),
                );
                return;
            }

            if (context.lldbState.pendingConfigDone.has(message.request_seq)) {
                // Ignore the synthetic configurationDone response.
                context.lldbState.pendingConfigDone.delete(message.request_seq);
                return;
            }

            const refresh = context.lldbState.pendingRefresh.get(message.request_seq);
            if (refresh) {
                context.lldbState.pendingRefresh.delete(message.request_seq);
                const responseBreakpoints =
                    (message.body?.breakpoints as Array<Record<string, unknown>>) ?? [];
                if (responseBreakpoints.length > 0) {
                    // Let VS Code update breakpoint state (verified/unverified).
                    for (const bp of responseBreakpoints) {
                        const event: DapEvent = {
                            seq: context.session.clientSeq++,
                            type: "event",
                            event: "breakpoint",
                            body: {
                                reason: "changed",
                                breakpoint: {
                                    ...bp,
                                    source: {
                                        path: refresh.sourcePath,
                                    },
                                },
                            },
                        };
                        context.sendToClient(event);
                    }
                } else {
                    // If LLDB returns nothing, mark them as unverified.
                    for (const line of refresh.lines) {
                        const event: DapEvent = {
                            seq: context.session.clientSeq++,
                            type: "event",
                            event: "breakpoint",
                            body: {
                                reason: "changed",
                                breakpoint: {
                                    verified: false,
                                    line,
                                    source: {
                                        path: refresh.sourcePath,
                                    },
                                },
                            },
                        };
                        context.sendToClient(event);
                    }
                }
                return;
            }
        }

        if (message.type === "event" && message.event === "stopped") {
            // Native stopped -> route stepping to LLDB.
            context.session.activeAdapter = "lldb";
        }

        context.sendToClient(message);
    };

    return {
        handleClientMessage,
        handleDebugpyMessage,
        handleLldbMessage,
    };
}

function mapAdapterResponseToClient(
    context: HandlerContext,
    message: DapResponse,
    clientPending: { clientSeq: number; command: string },
): DapResponse {
    return {
        ...message,
        seq: context.session.clientSeq++,
        request_seq: clientPending.clientSeq,
        command: clientPending.command,
    };
}

// Attach LLDB to the debugpy process when debugpy reports the PID.
// Steps:
// 1) Validate attach eligibility and avoid duplicate attach.
// 2) Send attach request to LLDB.
// 3) Send configurationDone to complete the attach sequence.
function handleDebugpyProcessEvent(
    context: HandlerContext,
    message: DapMessage,
): void {
    // debugpy tells us the Python PID; use it to attach LLDB.
    const shouldAttach = context.config.lldbAttachToPythonProcess !== false;
    const pid = (message as DapEvent).body?.systemProcessId as number | undefined;
    if (
        shouldAttach &&
        pid &&
        context.lldbState.connection &&
        context.lldbState.available &&
        !context.lldbState.attachRequested
    ) {
        context.session.debuggeePid = pid;
        context.lldbState.attachRequested = true; // make sure we only attach once
        const attachRequest: DapRequest = {
            seq: context.lldbState.seq++,
            type: "request",
            command: "attach",
            arguments: {
                pid,
            },
        };
        context.lldbState.sessionStarted = true;  // mark LLDB as attached
        context.lldbState.pendingRequests.set(attachRequest.seq, attachRequest.command);
        context.lldbState.connection.send(attachRequest);
        // LLDB expects configurationDone after attach.
        const configDoneRequest: DapRequest = {
            seq: context.lldbState.seq++,
            type: "request",
            command: "configurationDone",
        };
        context.lldbState.pendingConfigDone.add(configDoneRequest.seq);
        context.lldbState.connection.send(configDoneRequest);
        context.output.appendLine(`LLDB attach requested for pid ${pid}.`);
    }
}

// Decide whether a command should route to LLDB based on the active adapter.
// Steps:
// 1) Only route when LLDB is active.
// 2) Limit to stack/variables/step control commands.
function shouldRouteToLldb(
    command: string,
    activeAdapter: "debugpy" | "lldb",
): boolean {
    if (activeAdapter !== "lldb") {
        return false;
    }

    // These requests are used while stopped (stack/variables/step/eval).
    return (
        command === "stackTrace" ||
        command === "scopes" ||
        command === "variables" ||
        command === "evaluate" ||
        command === "setVariable" ||
        command === "threads" ||
        command === "continue" ||
        command === "next" ||
        command === "stepIn" ||
        command === "stepOut" ||
        command === "pause" ||
        command === "terminateThreads" ||
        command === "restartFrame"
    );
}
