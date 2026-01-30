// Command + environment to launch an adapter process.
export type DebugAdapterCommand = {
    command: string;
    args: string[];
    env: NodeJS.ProcessEnv;
    label: string;
};

// Minimal DAP request shape (fields we use in this adapter).
export type DapRequest = {
    seq: number;
    type: "request";
    command: string;
    arguments?: Record<string, unknown>;
};

// Minimal DAP response shape.
export type DapResponse = {
    seq: number;
    type: "response";
    request_seq: number;
    command: string;
    success: boolean;
    message?: string;
    body?: Record<string, unknown>;
};

// Minimal DAP event shape.
export type DapEvent = {
    seq: number;
    type: "event";
    event: string;
    body?: Record<string, unknown>;
};

export type DapMessage = DapRequest | DapResponse | DapEvent;

// We split a single setBreakpoints into parts, then merge responses.
export type PendingSetBreakpoints = {
    originalSeq: number;
    source: Record<string, unknown>;
    breakpoints: Array<{ line: number }>;
    results: Array<Record<string, unknown> | undefined>;
    remaining: number;
    success: boolean;
    message?: string;
};

// A partial response for a subset of breakpoints.
export type PendingSetBreakpointsPart = {
    originalSeq: number;
    indices: number[];
    originalLines: number[];
};

