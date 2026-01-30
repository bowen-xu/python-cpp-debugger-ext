import * as vscode from "vscode";
import * as net from "net";
import * as utils from "./utils";
import {
    DEFAULT_CPP_FILE_EXTENSIONS,
    DEFAULT_PYTHON_FILE_EXTENSIONS,
    normalizeExtensionList,
} from "../file_extensions";
import { DapMessage, PendingSetBreakpointsPart } from "./data_types";
import { BreakpointState, DebugpyState, LldbState, SessionState } from "./proxy_types";
import { BreakpointContext } from "./proxy_breakpoints";
import { ShutdownManager } from "./proxy_shutdown";
import {
    createHandlers,
    forwardClientRequestToDebugpy,
    forwardClientRequestToLldb,
    ProxyHandlers,
} from "./proxy_handlers";


// Create a one-shot TCP server and return its bound port.
// Steps:
// 1) Start a local server that accepts a single VS Code connection.
// 2) Resolve the ephemeral port once listening.
export async function createProxyServer(
    config: vscode.DebugConfiguration,
    output: vscode.OutputChannel,
): Promise<{ server: net.Server; port: number }> {
    // Accept exactly one connection from VS Code, then hand off to proxy logic.
    const server = net.createServer((socket) => {
        server.close();
        createProxySession(socket, config, output);
    });

    const port = await new Promise<number>((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", () => {
            const address = server.address();
            if (!address || typeof address === "string") {
                reject(new Error("Failed to acquire a TCP port for PYCPP adapter."));
                return;
            }
            resolve(address.port);
        });
    });

    return { server, port };
}

// Build a proxy session that wires VS Code, debugpy, and LLDB together.
// Steps:
// 1) Spawn adapter processes and initialize session state.
// 2) Create DAP connections and handler context.
// 3) Delegate message handling to specialized modules.
function createProxySession(
    socket: net.Socket,
    config: vscode.DebugConfiguration,
    output: vscode.OutputChannel,
): void {
    // Start both adapters: debugpy for Python and LLDB for C++.
    const debugpy = utils.spawnDebugpyAdapter(config, output); // process for debugpy
    const lldb = utils.spawnLldbAdapter(config, output); // process for LLDB (may be undefined)

    const pythonFileExtensions = new Set(
        normalizeExtensionList(
            config.pythonFileExtensions,
            DEFAULT_PYTHON_FILE_EXTENSIONS,
        ),
    );
    const cppFileExtensions = new Set(
        normalizeExtensionList(config.cppFileExtensions, DEFAULT_CPP_FILE_EXTENSIONS),
    );

    const session: SessionState = {
        clientSeq: 1,
        activeAdapter: "debugpy",
        shutdownRequested: false,
        shutdownDebugpyAck: false,
        shutdownLldbAck: false,
        shutdownDebugpyExited: false,
        shutdownTerminateDebuggee: true,
        clientClosed: false,
        shutdownDebugpyDispatched: false,
        terminatedEventSeen: false,
        exitedEventSeen: false,
        awaitingDisconnect: false,
    };

    const breakpointState: BreakpointState = {
        pendingSetBreakpoints: new Map(),
        jitBreakpointCache: new Map<string, number[]>(),
    };

    // Handlers are initialized after contexts are created.
    let handlers: ProxyHandlers = {
        handleClientMessage: () => {},
        handleDebugpyMessage: () => {},
        handleLldbMessage: () => {},
    };

    // Connection to VS Code (the DAP client).
    const client = new utils.DapConnection(
        socket, // passed in from VS Code
        socket,
        (message) => handlers.handleClientMessage(message),
        (error) => output.appendLine(`PYCPP client error: ${error.message}`),
    );

    // Connection to debugpy (Python debugger adapter).
    const debugpyConnection = new utils.DapConnection(
        debugpy.stdout,
        debugpy.stdin,
        (message) => handlers.handleDebugpyMessage(message),
        (error) => output.appendLine(`debugpy adapter error: ${error.message}`),
    );

    const debugpyState: DebugpyState = {
        seq: 1,
        connection: debugpyConnection,
        pendingSetBreakpoints: new Map<number, PendingSetBreakpointsPart>(),
        pendingSyntheticConfigDone: new Set<number>(),
        pendingClientRequests: new Map<number, { clientSeq: number; command: string }>(),
    };

    const lldbState: LldbState = {
        seq: 1,
        available: lldb !== undefined,
        attachRequested: false,
        sessionStarted: false,
        pendingSetBreakpoints: new Map<number, PendingSetBreakpointsPart>(),
        pendingRequests: new Map<number, string>(),
        pendingClientRequests: new Map<number, { clientSeq: number; command: string }>(),
        pendingRefresh: new Map<number, { sourcePath: string; lines: number[] }>(),
        pendingConfigDone: new Set<number>(),
    };

    // Connection to LLDB adapter (native debugger).
    if (lldb) {
        lldbState.connection = new utils.DapConnection(
            lldb.stdout,
            lldb.stdin,
            (message) => handlers.handleLldbMessage(message),
            (error) => output.appendLine(`lldb adapter error: ${error.message}`),
        );
    }

    debugpy.stderr.on("data", (data) => {
        output.appendLine(`[debugpy] ${data.toString()}`);
    });

    const shutdownManager = new ShutdownManager({
        session,
        debugpyState,
        lldbState,
        lldbProcess: lldb,
        socket,
        output,
        sendToClient,
        forwardClientRequestToDebugpy: (request, responseCommand) =>
            forwardClientRequestToDebugpy(request, debugpyState, responseCommand),
    });

    const breakpointContext: BreakpointContext = {
        session,
        breakpointState,
        debugpyState,
        lldbState,
        pythonFileExtensions,
        cppFileExtensions,
        sendToClient,
        forwardClientRequestToDebugpy: (request) => forwardClientRequestToDebugpy(request, debugpyState),
        forwardClientRequestToLldb: (request) => forwardClientRequestToLldb(request, lldbState),
    };

    // Bind handlers only after contexts and managers are available.
    handlers = createHandlers({
        session,
        debugpyState,
        lldbState,
        breakpointContext,
        shutdownManager,
        config,
        output,
        sendToClient,
    });

    debugpy.on("exit", (code, signal) => {
        output.appendLine(
            `debugpy adapter exited (code=${code ?? "null"}, signal=${signal ?? "null"}).`,
        );
        shutdownManager.onDebugpyExit();
    });

    if (lldb) {
        lldb.stderr.on("data", (data) => {
            output.appendLine(`[lldb] ${data.toString()}`);
        });

        lldb.on("exit", (code, signal) => {
            output.appendLine(
                `lldb adapter exited (code=${code ?? "null"}, signal=${signal ?? "null"}).`,
            );
            lldbState.available = false;
        });
    }

    socket.on("close", () => {
        output.appendLine("PYCPP socket closed.");
        session.clientClosed = true;
        if (!debugpy.killed) {
            debugpy.kill();
        }
        if (lldb && !lldb.killed) {
            lldb.kill();
        }
    });

    socket.on("error", (error) => {
        output.appendLine(`PYCPP socket error: ${error.message}`);
        session.clientClosed = true;
        if (!debugpy.killed) {
            debugpy.kill();
        }
        if (lldb && !lldb.killed) {
            lldb.kill();
        }
    });

    // Send a message to VS Code unless the client socket is already closed.
    // Steps:
    // 1) Guard against closed session.
    // 2) Forward the message to the DAP client stream.
    function sendToClient(message: DapMessage): void {
        if (session.clientClosed) {
            return;
        }
        client.send(message);
    }
}
