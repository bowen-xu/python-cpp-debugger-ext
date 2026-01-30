import * as net from "net";
import * as vscode from "vscode";
import * as childProcess from "child_process";
import { DapEvent, DapRequest, DapResponse } from "./data_types";
import { DebugpyState, LldbState, SessionState } from "./proxy_types";

export type ShutdownContext = {
    session: SessionState;
    debugpyState: DebugpyState;
    lldbState: LldbState;
    lldbProcess?: childProcess.ChildProcessWithoutNullStreams;
    socket: net.Socket;
    output: vscode.OutputChannel;
    sendToClient: (message: DapResponse | DapEvent) => void;
    forwardClientRequestToDebugpy: (
        request: DapRequest,
        responseCommand?: string,
    ) => void;
};

// Coordinates terminate/disconnect across debugpy and lldb, and closes the client socket safely.
export class ShutdownManager {
    constructor(private readonly context: ShutdownContext) {}

    // Handle terminate/disconnect requests from VS Code.
    // Steps:
    // 1) If shutdown already in progress, either close on disconnect or ack the request.
    // 2) Otherwise mark shutdown state and detach LLDB first.
    // 3) After LLDB detach (or timeout), dispatch debugpy shutdown.
    handleTerminateRequest(message: DapRequest): void {
        const { session, output } = this.context;
        if (session.shutdownRequested) {
            if (message.command === "disconnect" && session.awaitingDisconnect) {
                output.appendLine("[proxy] disconnect received after terminate; closing session.");
                if (session.disconnectTimer) {
                    // Cancel the pending disconnect timeout because we got a real disconnect.
                    clearTimeout(session.disconnectTimer);
                    session.disconnectTimer = undefined;
                }
                const response: DapResponse = {
                    seq: session.clientSeq++,
                    type: "response",
                    request_seq: message.seq,
                    command: message.command,
                    success: true,
                };
                this.context.sendToClient(response);
                this.closeClientSocketNow();
                return;
            }
            output.appendLine(
                `[proxy] ${message.command} seq=${message.seq} ignored (shutdown in progress).`,
            );
            const response: DapResponse = {
                seq: session.clientSeq++,
                type: "response",
                request_seq: message.seq,
                command: message.command,
                success: true,
                message: "Shutdown already in progress.",
            };
            this.context.sendToClient(response);
            return;
        }

        // Initialize shutdown state for a fresh termination sequence.
        session.shutdownRequested = true;
        session.shutdownDebugpyAck = false;
        session.shutdownDebugpyExited = false;
        session.shutdownTerminateDebuggee = this.resolveTerminateDebuggee(message);
        session.shutdownRequest = message;
        session.shutdownDebugpyDispatched = false;
        output.appendLine(
            `[proxy] shutdown start cmd=${message.command} terminateDebuggee=${session.shutdownTerminateDebuggee}`,
        );
        if (session.shutdownLldbTimer) {
            // Clean up any previous LLDB shutdown timer.
            clearTimeout(session.shutdownLldbTimer);
            session.shutdownLldbTimer = undefined;
        }
        if (session.shutdownDebugpyTimer) {
            // Clean up any previous debugpy shutdown timer.
            clearTimeout(session.shutdownDebugpyTimer);
            session.shutdownDebugpyTimer = undefined;
        }

        if (this.context.lldbState.connection && this.context.lldbState.sessionStarted) {
            // Detach LLDB first so the debuggee is no longer traced.
            session.shutdownLldbAck = false;
            const lldbRequest = this.withTerminateDebuggee(
                { ...message, command: "disconnect" },
                false,
            );
            const lldbForward: DapRequest = {
                ...lldbRequest,
                seq: this.context.lldbState.seq++,
            };
            output.appendLine(
                `[proxy] -> lldb disconnect seq=${lldbForward.seq} terminateDebuggee=false`,
            );
            this.context.lldbState.pendingRequests.set(
                lldbForward.seq,
                lldbForward.command,
            );
            this.context.lldbState.connection.send(lldbForward);

            session.shutdownLldbTimer = setTimeout(() => {
                output.appendLine("[proxy] lldb detach timeout; forcing debugpy shutdown.");
                // LLDB did not respond; proceed with debugpy shutdown anyway.
                session.shutdownLldbAck = true;
                this.dispatchDebugpyShutdown();
                if (this.context.lldbProcess && !this.context.lldbProcess.killed) {
                    this.context.lldbProcess.kill();
                }
                this.maybeCloseClientSocket();
            }, 500);
        } else {
            // No LLDB session to detach.
            session.shutdownLldbAck = true;
        }

        if (!this.context.lldbState.connection || !this.context.lldbState.sessionStarted) {
            // Debugpy shutdown can proceed immediately when LLDB is not attached.
            this.dispatchDebugpyShutdown();
        }
    }

    // Record debugpy terminate/disconnect response and move toward socket close.
    // Steps:
    // 1) Mark debugpy as acknowledged.
    // 2) Clear pending timer.
    // 3) Attempt shutdown completion.
    handleDebugpyTerminateResponse(command: string, message: DapResponse): void {
        if (command !== "disconnect" && command !== "terminate") {
            return;
        }
        const { session, output } = this.context;
        output.appendLine(
            `[debugpy] ${command} response success=${message.success} message=${message.message ?? "none"}`,
        );
        session.shutdownDebugpyAck = true;
        if (session.shutdownDebugpyTimer) {
            // We got a response; no need to keep the timeout.
            clearTimeout(session.shutdownDebugpyTimer);
            session.shutdownDebugpyTimer = undefined;
        }
        this.maybeCloseClientSocket();
    }

    // Record LLDB terminate/disconnect response and move toward socket close.
    // Steps:
    // 1) Mark LLDB as acknowledged.
    // 2) Clear pending timer.
    // 3) Dispatch debugpy shutdown if it hasn't started.
    handleLldbTerminateResponse(command: string, message: DapResponse): void {
        if (command !== "disconnect" && command !== "terminate") {
            return;
        }
        const { session, output } = this.context;
        output.appendLine(
            `[lldb] ${command} response success=${message.success} message=${message.message ?? "none"}`,
        );
        session.shutdownLldbAck = true;
        if (session.shutdownLldbTimer) {
            // LLDB answered; cancel timeout.
            clearTimeout(session.shutdownLldbTimer);
            session.shutdownLldbTimer = undefined;
        }
        if (session.shutdownRequested && !session.shutdownDebugpyDispatched) {
            // LLDB is detached; start debugpy shutdown if not already done.
            this.dispatchDebugpyShutdown();
        }
        this.maybeCloseClientSocket();
    }

    // Handle debugpy process exit notification.
    // Steps:
    // 1) Mark debugpy as exited and cancel its timer.
    // 2) If shutdown is active, attempt to close the client socket.
    onDebugpyExit(): void {
        const { session } = this.context;
        session.shutdownDebugpyExited = true;
        if (session.shutdownDebugpyTimer) {
            // Timer is irrelevant once debugpy exits.
            clearTimeout(session.shutdownDebugpyTimer);
            session.shutdownDebugpyTimer = undefined;
        }
        if (session.shutdownRequested) {
            this.maybeCloseClientSocket();
            return;
        }
        this.closeClientSocketNow();
    }

    // Decide when it is safe to close the client socket.
    // Steps:
    // 1) Ensure debugpy and lldb shutdown acknowledgements are complete.
    // 2) Send exit/terminated events if needed.
    // 3) Wait for client disconnect or timeout.
    maybeCloseClientSocket(): void {
        const { session, output } = this.context;
        if (!session.shutdownRequested) {
            return;
        }

        const debugpyDone = session.shutdownDebugpyAck || session.shutdownDebugpyExited;
        if (!debugpyDone) {
            return;
        }

        if (!session.shutdownLldbAck) {
            return;
        }

        // Ensure VS Code receives the expected termination events.
        this.sendExitEventsIfNeeded();

        if (session.awaitingDisconnect) {
            // Already waiting for a disconnect request.
            return;
        }

        output.appendLine("[proxy] shutdown complete; awaiting disconnect.");
        session.awaitingDisconnect = true;
        session.disconnectTimer = setTimeout(() => {
            output.appendLine("[proxy] disconnect timeout; closing client socket.");
            this.closeClientSocketNow();
        }, 1500);
    }

    // Emit exited/terminated events if they were not observed from debugpy.
    // Steps:
    // 1) Send exited with exitCode=0 if missing.
    // 2) Send terminated if missing.
    private sendExitEventsIfNeeded(): void {
        const { session } = this.context;
        if (!session.exitedEventSeen) {
            const exitedEvent: DapEvent = {
                seq: session.clientSeq++,
                type: "event",
                event: "exited",
                body: {
                    exitCode: 0,
                },
            };
            this.context.sendToClient(exitedEvent);
            session.exitedEventSeen = true;
        }

        if (!session.terminatedEventSeen) {
            const terminatedEvent: DapEvent = {
                seq: session.clientSeq++,
                type: "event",
                event: "terminated",
            };
            this.context.sendToClient(terminatedEvent);
            session.terminatedEventSeen = true;
        }
    }

    // Close the client socket and clear timers safely.
    // Steps:
    // 1) Guard against double-close.
    // 2) Clear any outstanding disconnect timer.
    // 3) End the socket.
    private closeClientSocketNow(): void {
        const { session, socket } = this.context;
        if (session.clientClosed) {
            return;
        }
        session.clientClosed = true;
        if (session.disconnectTimer) {
            // Stop the disconnect timeout once we're closing.
            clearTimeout(session.disconnectTimer);
            session.disconnectTimer = undefined;
        }
        socket.end();
    }

    // Dispatch debugpy shutdown (terminate or disconnect mapped from terminate).
    // Steps:
    // 1) Guard against duplicate dispatch.
    // 2) Send disconnect to debugpy if the client requested terminate.
    // 3) Arm a timeout as a final safety net.
    private dispatchDebugpyShutdown(): void {
        const { session, debugpyState, output } = this.context;
        if (!session.shutdownRequest) {
            return;
        }
        if (session.shutdownDebugpyDispatched) {
            return;
        }
        session.shutdownDebugpyDispatched = true;
        const debugpyRequest = this.withTerminateDebuggee(
            session.shutdownRequest,
            session.shutdownTerminateDebuggee,
        );
        if (session.shutdownRequest.command === "terminate") {
            output.appendLine(
                `[proxy] -> debugpy disconnect(seq=${debugpyState.seq}) mapped from terminate terminateDebuggee=${session.shutdownTerminateDebuggee}`,
            );
            this.context.forwardClientRequestToDebugpy(
                { ...debugpyRequest, command: "disconnect" },
                "terminate",
            );
        } else {
            output.appendLine(
                `[proxy] -> debugpy ${session.shutdownRequest.command} seq=${debugpyState.seq} terminateDebuggee=${session.shutdownTerminateDebuggee}`,
            );
            this.context.forwardClientRequestToDebugpy(debugpyRequest);
        }

        session.shutdownDebugpyTimer = setTimeout(() => {
            if (session.shutdownDebugpyAck || session.shutdownDebugpyExited) {
                return;
            }
            output.appendLine("[proxy] debugpy terminate timeout; forcing shutdown.");
            if (session.shutdownTerminateDebuggee && session.debuggeePid) {
                try {
                    process.kill(session.debuggeePid, "SIGKILL");
                } catch (error) {
                    output.appendLine(
                        `Failed to kill debuggee pid ${session.debuggeePid}: ${String(error)}`,
                    );
                }
            }
            session.shutdownDebugpyAck = true;
            this.maybeCloseClientSocket();
        }, 5000);
    }

    // Clone a request and enforce terminateDebuggee on its arguments.
    // Steps:
    // 1) Copy existing arguments.
    // 2) Overlay terminateDebuggee.
    private withTerminateDebuggee(
        request: DapRequest,
        terminateDebuggee: boolean,
    ): DapRequest {
        const argumentsValue = request.arguments ?? {};
        return {
            ...request,
            arguments: {
                ...argumentsValue,
                terminateDebuggee,
            },
        };
    }

    // Resolve terminateDebuggee flag, defaulting to true when unset.
    // Steps:
    // 1) Check request arguments.
    // 2) Fall back to true for compatibility.
    private resolveTerminateDebuggee(request: DapRequest): boolean {
        const terminateValue = request.arguments?.terminateDebuggee;
        if (typeof terminateValue === "boolean") {
            return terminateValue;
        }
        return true;
    }
}
