import * as utils from "./utils";
import { PendingSetBreakpoints, PendingSetBreakpointsPart } from "./data_types";

export type DebugpyState = {
    seq: number;
    connection: utils.DapConnection;
    pendingSetBreakpoints: Map<number, PendingSetBreakpointsPart>;
    pendingSyntheticConfigDone: Set<number>;
    pendingClientRequests: Map<number, { clientSeq: number; command: string }>;
};

export type LldbState = {
    seq: number;
    connection?: utils.DapConnection;
    available: boolean;
    attachRequested: boolean;
    sessionStarted: boolean;
    pendingSetBreakpoints: Map<number, PendingSetBreakpointsPart>;
    pendingRequests: Map<number, string>;
    pendingClientRequests: Map<number, { clientSeq: number; command: string }>;
    pendingRefresh: Map<number, { sourcePath: string; lines: number[] }>;
    pendingConfigDone: Set<number>;
};

export type BreakpointState = {
    pendingSetBreakpoints: Map<number, PendingSetBreakpoints>;
    jitBreakpointCache: Map<string, number[]>;
    entryLineBreakpoints: Map<string, boolean>;
};

export type SessionState = {
    clientSeq: number;
    activeAdapter: "debugpy" | "lldb";
    shutdownRequested: boolean;
    shutdownDebugpyAck: boolean;
    shutdownLldbAck: boolean;
    shutdownDebugpyExited: boolean;
    shutdownTerminateDebuggee: boolean;
    shutdownRequest?: import("./data_types").DapRequest;
    shutdownLldbTimer?: NodeJS.Timeout;
    shutdownDebugpyTimer?: NodeJS.Timeout;
    debuggeePid?: number;
    clientClosed: boolean;
    shutdownDebugpyDispatched: boolean;
    terminatedEventSeen: boolean;
    exitedEventSeen: boolean;
    awaitingDisconnect: boolean;
    disconnectTimer?: NodeJS.Timeout;
    // configurationDone gating: track when to send debugpy configurationDone
    clientConfigurationDone: boolean;
    pendingSetBreakpointsRequests: number;
    cppBreakpointsPresent: boolean;
    lldbAttachCompleted: boolean;
    debugpyConfigurationDoneSent: boolean;
    // Forced entry stop and auto-continue coordination
    forcedStopOnEntry: boolean;
    pendingAutoContinue: boolean;
    autoContinueThreadId?: number;
    // Entry line breakpoint detection (line 1 in non-C++ sources)
    hasEntryLineBreakpoint: boolean;
};
