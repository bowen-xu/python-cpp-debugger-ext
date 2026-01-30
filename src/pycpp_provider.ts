import { PythonExtension } from "@vscode/python-extension";
import * as vscode from "vscode";
import * as conf from "./config";
import {
    DEFAULT_CPP_FILE_EXTENSIONS,
    DEFAULT_PYTHON_FILE_EXTENSIONS,
    extractExtensionsFromAssociations,
    normalizeExtensionList,
} from "./file_extensions";

export class PycppDebugConfigurationProvider
    implements vscode.DebugConfigurationProvider {
    provideDebugConfigurations(): vscode.DebugConfiguration[] {
        // Provide a default launch configuration when the user clicks
        // "Add Configuration..." in VS Code.
        return [
            {
                name: "PYCPP: Mixed Debugger",
                type: "pycpp-debug",
                request: "launch",
                program: "${file}",
                cwd: "${workspaceFolder}",
                args: [],
                env: {},
                console: "integratedTerminal",
            },
        ];
    }

    async resolveDebugConfiguration(
        folder: vscode.WorkspaceFolder | undefined,
        config: vscode.DebugConfiguration,
    ): Promise<vscode.DebugConfiguration | null | undefined> {
        // Only handle our own debug type.
        if (config.type !== "pycpp-debug") {
            return config;
        }

        // We depend on the Python Debugger extension because we forward to debugpy.
        const pythonExtension = vscode.extensions.getExtension(
            conf.PYTHON_DEBUG_EXTENSION_ID,
        );
        if (!pythonExtension) {
            void vscode.window.showErrorMessage(
                "PYCPP mixed debugger requires the Python Debugger extension (ms-python.debugpy).",
            );
            return null;
        }

        // Fill in reasonable defaults so beginners can press F5 quickly.
        if (!config.request) {
            config.request = "launch";
        }

        if (!config.name) {
            config.name = "PYCPP: Mixed Debugger";
        }

        if (!config.cwd && folder?.uri.fsPath) {
            config.cwd = "${workspaceFolder}";
        }

        if (!config.program && folder?.uri.fsPath) {
            config.program = "${file}";
        }

        if (!config.console) {
            config.console = "integratedTerminal";
        }

        if (!config.pythonPath) {
            const interpreterPath = await resolveInterpreterPath(folder?.uri);
            if (interpreterPath) {
                config.pythonPath = interpreterPath;
            }
        }

        const fileExtensions = resolveFileExtensions();
        if (!config.pythonFileExtensions) {
            config.pythonFileExtensions = fileExtensions.python;
        }
        if (!config.cppFileExtensions) {
            config.cppFileExtensions = fileExtensions.cpp;
        }

        // Return the config to VS Code. The actual DAP work happens in the
        // debug adapter (see pycpp_adapter.ts).
        return config;
    }
}

function resolveFileExtensions(): { python: string[]; cpp: string[] } {
    const associations = vscode.workspace
        .getConfiguration("files")
        .get<Record<string, string>>("associations");
    const pythonFromAssociations = extractExtensionsFromAssociations(associations, ["python"]);
    const cppFromAssociations = extractExtensionsFromAssociations(associations, [
        "cpp",
        "c",
        "cuda-cpp",
        "objective-c",
        "objective-cpp",
    ]);

    return {
        python: normalizeExtensionList(
            pythonFromAssociations,
            DEFAULT_PYTHON_FILE_EXTENSIONS,
        ),
        cpp: normalizeExtensionList(cppFromAssociations, DEFAULT_CPP_FILE_EXTENSIONS),
    };
}

async function resolveInterpreterPath(
    resource: vscode.Uri | undefined,
): Promise<string | undefined> {
    try {
        const pythonExtension = vscode.extensions.getExtension(conf.PYTHON_EXTENSION_ID);
        if (!pythonExtension) {
            return undefined;
        }

        const api = await PythonExtension.api();
        const environmentPath = api.environments.getActiveEnvironmentPath(resource);
        if (!environmentPath) {
            return undefined;
        }

        const resolved = await api.environments.resolveEnvironment(environmentPath);
        return resolved?.executable.uri?.fsPath ?? environmentPath.path;
    } catch {
        return undefined;
    }
}
