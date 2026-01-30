import * as vscode from "vscode";
import { JitcppDebugAdapterDescriptorFactory } from "./jitcpp_adapter/adapter";
import { JitcppDebugConfigurationProvider } from "./jitcpp_provider";

export function activate(context: vscode.ExtensionContext): void {
	// This runs when the extension is activated by VS Code.
	// We register:
	// 1) a debug configuration provider (fills defaults and validates config)
	// 2) a debug adapter factory (our DAP bridge between VS Code and debugpy/LLDB)
	const provider = new JitcppDebugConfigurationProvider();
	const descriptorFactory = new JitcppDebugAdapterDescriptorFactory();
	context.subscriptions.push(
		vscode.debug.registerDebugConfigurationProvider("jitcpp-debug", provider),
		vscode.debug.registerDebugAdapterDescriptorFactory("jitcpp-debug", descriptorFactory),
		descriptorFactory, // add the factory to subscriptions, so that it gets disposed on extension deactivation
	);
}

export function deactivate(): void { } // nothing to clean up, but VS Code expects this function to exist
