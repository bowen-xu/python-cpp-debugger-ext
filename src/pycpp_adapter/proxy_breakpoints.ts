import * as path from "path";
import * as utils from "./utils";
import {
    DapMessage,
    DapRequest,
    DapResponse,
    PendingSetBreakpoints,
    PendingSetBreakpointsPart,
} from "./data_types";
import { BreakpointState, DebugpyState, LldbState, SessionState } from "./proxy_types";

export type BreakpointContext = {
    session: SessionState;
    breakpointState: BreakpointState;
    debugpyState: DebugpyState;
    lldbState: LldbState;
    pythonFileExtensions: Set<string>;
    cppFileExtensions: Set<string>;
    sendToClient: (message: DapMessage) => void;
    forwardClientRequestToDebugpy: (request: DapRequest) => void;
    forwardClientRequestToLldb: (request: DapRequest) => void;
};

// Handle setBreakpoints by routing Python vs C++ files to the right adapter.
// Steps:
// 1) Resolve the source path and decide which adapter owns it.
// 2) Dispatch the request to debugpy or LLDB.
// 3) Merge results back to VS Code.
export function handleSetBreakpoints(
    context: BreakpointContext,
    request: DapRequest,
): void {
    // Route by file extension instead of JIT source mapping.
    const args = request.arguments ?? {};
    const source = args.source as Record<string, unknown> | undefined;
    // Normalize file:// URIs so extension checks match real paths.
    const pathValue = utils.normalizeSourcePath(source?.path as string | undefined);
    const breakpoints = (args.breakpoints as Array<{ line: number }>) ?? [];

    if (!pathValue) {
        // No usable source info; fall back to debugpy.
        forwardToDebugpyIf(context, request, true);
        return;
    }

    const sourceType = classifySourcePath(context, pathValue);
    if (forwardToDebugpyIf(context, request, sourceType !== "cpp")) {
        return;
    }

    // Build an aggregate response to send back to VS Code later.
    const lldbUsable = Boolean(context.lldbState.connection && context.lldbState.available);
    const normalizedSource = source ?? {};
    const pending: PendingSetBreakpoints = {
        originalSeq: request.seq,
        source: normalizedSource,
        breakpoints,
        results: new Array(breakpoints.length),
        remaining: 0,
        success: true,
    };
    context.breakpointState.pendingSetBreakpoints.set(request.seq, pending);

    const lldbBreakpoints = breakpoints.map((bp, index) => ({
        index,
        originalLine: bp.line,
    }));

    if (!lldbUsable) {
        // No LLDB available -> return unverified breakpoints for C++ lines.
        for (const bp of lldbBreakpoints) {
            pending.results[bp.index] = {
                verified: false,
                line: bp.originalLine,
                source: normalizedSource,
                message: "LLDB adapter unavailable for C++ breakpoint.",
            };
        }
        sendMergedResponse(context, pending);
        return;
    }

    const lldbConn = context.lldbState.connection;
    if (!lldbConn) {
        // LLDB disappeared between the availability check and dispatch.
        return;
    }

    if (!context.lldbState.sessionStarted) {
        // LLDB not attached yet -> cache breakpoints for later refresh.
        cacheJitBreakpoints(context, pathValue, lldbBreakpoints);
        for (const bp of lldbBreakpoints) {
            pending.results[bp.index] = {
                verified: false,
                line: bp.originalLine,
                source: normalizedSource,
                message: "LLDB not attached yet; breakpoint pending.",
            };
        }
        sendMergedResponse(context, pending);
        return;
    }

    // Send C++ breakpoints to LLDB using the C++ file path.
    cacheJitBreakpoints(context, pathValue, lldbBreakpoints);
    const lldbRequest: DapRequest = {
        seq: context.lldbState.seq++,
        type: "request",
        command: "setBreakpoints",
        arguments: {
            source: {
                path: pathValue,
            },
            breakpoints: lldbBreakpoints.map((bp) => ({
                line: bp.originalLine,
            })),
        },
    };

    context.lldbState.pendingSetBreakpoints.set(lldbRequest.seq, {
        originalSeq: request.seq,
        indices: lldbBreakpoints.map((bp) => bp.index),
        originalLines: lldbBreakpoints.map((bp) => bp.originalLine),
    });
    pending.remaining += 1;
    lldbConn.send(lldbRequest);
}

// Handle breakpointLocations by routing Python vs C++ files.
// Steps:
// 1) Resolve the source path and classify it.
// 2) Forward to the owning adapter, or pin the line if LLDB is missing.
export function handleBreakpointLocations(
    context: BreakpointContext,
    request: DapRequest,
): void {
    const args = request.arguments ?? {};
    const source = args.source as Record<string, unknown> | undefined;
    const pathValue = utils.normalizeSourcePath(source?.path as string | undefined);
    const line = args.line as number | undefined;

    if (!pathValue || !line) {
        // No usable path/line -> let debugpy decide.
        forwardToDebugpyIf(context, request, true);
        return;
    }

    const sourceType = classifySourcePath(context, pathValue);
    if (sourceType !== "cpp") {
        forwardToDebugpyIf(context, request, true);
        return;
    }

    if (context.lldbState.connection && context.lldbState.available) {
        context.forwardClientRequestToLldb(request);
        return;
    }

    const response: DapResponse = {
        seq: context.session.clientSeq++,
        type: "response",
        request_seq: request.seq,
        command: "breakpointLocations",
        success: true,
        body: {
            breakpoints: [{ line }],
        },
    };
    context.sendToClient(response);
}

// Merge a partial setBreakpoints response into the aggregated result set.
// Steps:
// 1) Locate the original pending request.
// 2) Copy adapter results into original indices.
// 3) Emit merged response when all parts return.
export function applySetBreakpointsResponse(
    context: BreakpointContext,
    part: PendingSetBreakpointsPart,
    message: DapResponse,
): void {
    // Merge each adapter's response back into the original order.
    const pending = context.breakpointState.pendingSetBreakpoints.get(part.originalSeq);
    if (!pending) {
        return;
    }

    if (!message.success) {
        pending.success = false;
        if (message.message) {
            pending.message = message.message;
        }
    }

    const responseBreakpoints =
        (message.body?.breakpoints as Array<Record<string, unknown>>) ?? [];
    for (let i = 0; i < part.indices.length; i += 1) {
        const originalIndex = part.indices[i];
        const originalLine = part.originalLines[i];
        const adapterBreakpoint = responseBreakpoints[i] ?? { verified: false };
        pending.results[originalIndex] = {
            ...adapterBreakpoint,
            line: originalLine,
            source: pending.source,
        };
    }

    pending.remaining -= 1;
    sendMergedResponse(context, pending);
}

// Refresh cached JIT breakpoints after LLDB attaches.
// Steps:
// 1) Iterate cached files and line lists.
// 2) Re-send setBreakpoints to LLDB and track refresh responses.
export function refreshLldbBreakpoints(context: BreakpointContext): void {
    // Re-apply cached JIT breakpoints after LLDB attaches.
    if (!context.lldbState.connection || !context.lldbState.available) {
        return;
    }

    for (const [sourcePath, lines] of context.breakpointState.jitBreakpointCache.entries()) {
        const request: DapRequest = {
            seq: context.lldbState.seq++,
            type: "request",
            command: "setBreakpoints",
            arguments: {
                source: {
                    path: sourcePath,
                },
                breakpoints: lines.map((line) => ({ line })),
            },
        };
        context.lldbState.pendingRefresh.set(request.seq, { sourcePath, lines });
        context.lldbState.connection.send(request);
    }
}

// Build and send a merged setBreakpoints response to VS Code.
// Steps:
// 1) Wait until all adapter parts have responded.
// 2) Fill missing entries with unverified placeholders.
// 3) Emit a single response to the client.
function sendMergedResponse(context: BreakpointContext, pending: PendingSetBreakpoints): void {
    // Wait until all partial responses arrive, then return one merged result.
    if (pending.remaining > 0) {
        return;
    }

    const body = {
        breakpoints: pending.results.map((bp, index) => {
            if (!bp) {
                return {
                    verified: false,
                    line: pending.breakpoints[index].line,
                    message: "No response from adapter for breakpoint.",
                };
            }
            return bp;
        }),
    };

    const response: DapResponse = {
        seq: context.session.clientSeq++,
        type: "response",
        request_seq: pending.originalSeq,
        command: "setBreakpoints",
        success: pending.success,
        message: pending.message,
        body,
    };
    context.breakpointState.pendingSetBreakpoints.delete(pending.originalSeq);
    context.sendToClient(response);
}

// Cache C++ breakpoint lines so they can be re-applied after LLDB attach.
// Steps:
// 1) Replace the per-file cache with the latest lines.
// 2) Store the de-duplicated list back into the cache.
function cacheJitBreakpoints(
    context: BreakpointContext,
    sourcePath: string,
    breakpoints: Array<{ originalLine: number }>,
): void {
    // Keep a de-duplicated list of C++ breakpoint lines per file.
    const unique = new Set<number>();
    for (const bp of breakpoints) {
        unique.add(bp.originalLine);
    }
    context.breakpointState.jitBreakpointCache.set(sourcePath, Array.from(unique.values()));
}

function classifySourcePath(
    context: BreakpointContext,
    pathValue: string,
): "cpp" | "python" | "unknown" {
    const extension = path.extname(pathValue).toLowerCase();
    if (extension && context.cppFileExtensions.has(extension)) {
        return "cpp";
    }
    if (extension && context.pythonFileExtensions.has(extension)) {
        return "python";
    }
    return "unknown";
}

function forwardToDebugpyIf(
    context: BreakpointContext,
    request: DapRequest,
    condition: boolean,
): boolean {
    if (!condition) {
        return false;
    }
    context.forwardClientRequestToDebugpy(request);
    return true;
}
