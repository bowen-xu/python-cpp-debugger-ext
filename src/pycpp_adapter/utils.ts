import * as childProcess from "child_process";
import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";
import * as conf from "../config";
import { DebugAdapterCommand, DapMessage } from "./data_types";


// A tiny DAP frame parser/writer (Content-Length + JSON). 
//      Explain:
//      The Debug Adapter Protocol (DAP) uses a simple framing mechanism to send messages over a stream.
//      Each message is prefixed with a header that specifies the content length, followed by the JSON payload.
//      This class handles reading from a stream, parsing the DAP messages, 
//      and sending messages with the correct framing.
export class DapConnection {
    private buffer = Buffer.alloc(0);
    private contentLength: number | null = null;

    constructor(
        private readonly input: NodeJS.ReadableStream,
        private readonly output: NodeJS.WritableStream,
        private readonly onMessage: (message: DapMessage) => void,
        private readonly onError: (error: Error) => void,
    ) {
        // Accumulate bytes until a full DAP message is available.
        this.input.on("data", (chunk) => this.handleData(chunk));
        this.input.on("error", (error) => this.onError(error));
    }

    send(message: DapMessage): void {
        // DAP framing: Content-Length header + JSON body.
        const payload = JSON.stringify(message);
        const header = `Content-Length: ${Buffer.byteLength(payload, "utf8")}\r\n\r\n`;
        this.output.write(header);
        this.output.write(payload);
    }

    private handleData(chunk: Buffer): void {
        this.buffer = Buffer.concat([this.buffer, chunk]);

        while (true) {
            if (this.contentLength === null) {
                // Look for the end of the header.
                const headerEnd = this.buffer.indexOf("\r\n\r\n");
                if (headerEnd === -1) {
                    return;
                }
                const header = this.buffer.subarray(0, headerEnd).toString("utf8");
                const match = /Content-Length:\s*(\d+)/i.exec(header);
                if (!match) {
                    this.onError(new Error("Invalid DAP header: missing Content-Length."));
                    return;
                }
                this.contentLength = Number(match[1]);
                this.buffer = this.buffer.subarray(headerEnd + 4);
            }

            if (this.contentLength !== null && this.buffer.length >= this.contentLength) {
                // We have a complete JSON payload.
                const body = this.buffer.subarray(0, this.contentLength).toString("utf8");
                this.buffer = this.buffer.subarray(this.contentLength);
                this.contentLength = null;
                try {
                    const message = JSON.parse(body) as DapMessage;
                    this.onMessage(message);
                } catch (error) {
                    this.onError(error instanceof Error ? error : new Error(String(error)));
                }
                continue;
            }

            return;
        }
    }
}

export function normalizeSourcePath(pathValue: string | undefined): string | undefined {
    // Convert a file:// URI to a local path if needed.
    if (!pathValue) {
        return undefined;
    }

    if (pathValue.startsWith("file://")) {
        try {
            return vscode.Uri.parse(pathValue).fsPath;
        } catch {
            return pathValue;
        }
    }

    return pathValue;
}

export function spawnDebugpyAdapter(
    config: vscode.DebugConfiguration,
    output: vscode.OutputChannel,
): childProcess.ChildProcessWithoutNullStreams {
    // Start debugpy.adapter.
    const command = buildDebugpyCommand(config);
    output.appendLine(`Starting debugpy adapter: ${command.label}`);
    const adapter = childProcess.spawn(command.command, command.args, {
        env: command.env,
        stdio: "pipe",
    }); // TODO: `python -m debugpy.adapter` might be invalid. Need to handle that -- exit the session with an error message?
    return adapter;
}

export function spawnLldbAdapter(
    config: vscode.DebugConfiguration,
    output: vscode.OutputChannel,
): childProcess.ChildProcessWithoutNullStreams | undefined {
    // Start CodeLLDB or lldb-dap.
    const command = buildLldbCommand(config, output);
    if (!command) {
        output.appendLine("LLDB adapter not available; JIT breakpoints will be ignored.");
        return undefined;
    }
    output.appendLine(`Starting LLDB adapter: ${command.label}`);
    const adapter = childProcess.spawn(command.command, command.args, {
        env: command.env,
        stdio: "pipe",
    });
    return adapter;
}

function buildDebugpyCommand(config: vscode.DebugConfiguration): DebugAdapterCommand {
    // Prefer a user-provided adapter path. Otherwise use bundled debugpy.
    const pythonPath = config.pythonPath ?? "python";
    const env: NodeJS.ProcessEnv = { ...process.env, ...config.env };

    const adapterPath = config.debugpyAdapterPath as string | undefined;
    if (adapterPath && fs.existsSync(adapterPath)) {
        const stat = fs.statSync(adapterPath);
        if (stat.isDirectory()) {
            const mainPath = path.join(adapterPath, "__main__.py");
            if (fs.existsSync(mainPath)) {
                return {
                    command: pythonPath,
                    args: [mainPath],
                    env,
                    label: `${pythonPath} ${mainPath}`,
                };
            }
        }

        if (path.extname(adapterPath) === ".py") {
            return {
                command: pythonPath,
                args: [adapterPath],
                env,
                label: `${pythonPath} ${adapterPath}`,
            };
        }

        return {
            command: adapterPath,
            args: [],
            env,
            label: adapterPath,
        };
    }

    const pythonExtension = vscode.extensions.getExtension(
        conf.PYTHON_DEBUG_EXTENSION_ID,
    );
    if (pythonExtension) {
        // Use debugpy bundled inside the Python Debugger extension.
        const bundledPath = findBundledDebugpyPath(pythonExtension.extensionPath);
        if (bundledPath) {
            env.PYTHONPATH = env.PYTHONPATH
                ? `${bundledPath}${path.delimiter}${env.PYTHONPATH}`
                : bundledPath;
        }
    }

    return {
        command: pythonPath,
        args: ["-m", "debugpy.adapter"],
        env,
        label: `${pythonPath} -m debugpy.adapter`,
    };
}

function buildLldbCommand(
    config: vscode.DebugConfiguration,
    output: vscode.OutputChannel,
): DebugAdapterCommand | undefined {
    // Prefer adapter path, then CodeLLDB extension, then lldb-dap in PATH.
    const env: NodeJS.ProcessEnv = { ...process.env, ...config.env };
    const adapterPath = config.lldbAdapterPath as string | undefined;
    if (adapterPath && fs.existsSync(adapterPath)) {
        return {
            command: adapterPath,
            args: [],
            env,
            label: adapterPath,
        };
    }

    const lldbExtension = vscode.extensions.getExtension(conf.LLDB_EXTENSION_ID);
    if (lldbExtension) {
        // CodeLLDB packages its adapter under "adapter/".
        const candidate = findBundledLldbAdapterPath(lldbExtension.extensionPath);
        if (candidate) {
            return {
                command: candidate,
                args: [],
                env,
                label: candidate,
            };
        }
    }

    if (commandExists("lldb-dap")) {
        return {
            command: "lldb-dap",
            args: [],
            env,
            label: "lldb-dap",
        };
    }

    output.appendLine(
        "LLDB adapter not found. Install CodeLLDB or set lldbAdapterPath.",
    );
    return undefined;
}

function findBundledDebugpyPath(extensionPath: string): string | undefined {
    // debugpy package paths vary across versions; check known layouts.
    const candidates = [
        path.join(extensionPath, "bundled", "libs"),
        path.join(extensionPath, "pythonFiles", "lib", "python"),
        path.join(extensionPath, "pythonFiles", "lib"),
    ];
    for (const candidate of candidates) {
        if (fs.existsSync(path.join(candidate, "debugpy"))) {
            return candidate;
        }
    }
    return undefined;
}

function findBundledLldbAdapterPath(extensionPath: string): string | undefined {
    // CodeLLDB adapter binaries are named codelldb (platform-specific suffix on Windows).
    const candidates = [
        path.join(extensionPath, "adapter", "codelldb"),
        path.join(extensionPath, "adapter", "codelldb.exe"),
        path.join(extensionPath, "adapter", "codelldb.cmd"),
    ];
    for (const candidate of candidates) {
        if (fs.existsSync(candidate)) {
            return candidate;
        }
    }
    return undefined;
}

function commandExists(command: string): boolean {
    // Quick PATH check for a binary name.
    const paths = (process.env.PATH ?? "").split(path.delimiter);
    for (const entry of paths) {
        const candidate = path.join(entry, command);
        if (fs.existsSync(candidate)) {
            return true;
        }
    }
    return false;
}
