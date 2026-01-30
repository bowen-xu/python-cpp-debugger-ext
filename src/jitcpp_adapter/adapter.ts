import * as net from "net";
import * as vscode from "vscode";
import { createProxyServer } from "./proxy";


export class JitcppDebugAdapterDescriptorFactory
    implements vscode.DebugAdapterDescriptorFactory, vscode.Disposable {
    // Output channel visible in VS Code's Output panel.
    private readonly output = vscode.window.createOutputChannel("JITCPP Debug");
    private readonly servers = new Set<net.Server>();

    async createDebugAdapterDescriptor(
        session: vscode.DebugSession,
    ): Promise<vscode.DebugAdapterDescriptor> {
        // Create a local TCP server; VS Code connects to it as the debug adapter.
        const { server, port } = await createProxyServer(
            session.configuration,
            this.output,
        );
        this.servers.add(server);
        server.on("close", () => this.servers.delete(server));
        return new vscode.DebugAdapterServer(port, "127.0.0.1");
    }

    dispose(): void {
        // Shutdown all running servers and the output channel.
        for (const server of this.servers) {
            server.close();
        }
        this.servers.clear();
        this.output.dispose();
    }
}
