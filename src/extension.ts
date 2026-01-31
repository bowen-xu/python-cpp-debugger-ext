import * as vscode from "vscode";
import { PycppDebugAdapterDescriptorFactory as PycppDebugAdapterDescriptorFactory } from "./pycpp_adapter/adapter";
import { PycppDebugConfigurationProvider as PycppDebugConfigurationProvider } from "./pycpp_provider";

export function activate(context: vscode.ExtensionContext): void {
	// This runs when the extension is activated by VS Code.
	// We register:
	// 1) a debug configuration provider (fills defaults and validates config)
	// 2) a debug adapter factory (our DAP bridge between VS Code and debugpy/LLDB)
	const provider = new PycppDebugConfigurationProvider(context);
	const descriptorFactory = new PycppDebugAdapterDescriptorFactory();
	context.subscriptions.push(
		vscode.debug.registerDebugConfigurationProvider("pycpp-debug", provider),
		vscode.debug.registerDebugAdapterDescriptorFactory("pycpp-debug", descriptorFactory),
		descriptorFactory, // add the factory to subscriptions, so that it gets disposed on extension deactivation
	);
}

export function deactivate(): void { } // nothing to clean up, but VS Code expects this function to exist
