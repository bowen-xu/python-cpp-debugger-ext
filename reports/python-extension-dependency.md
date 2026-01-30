# Python Extension Dependency

We depend on the VS Code Python extension API facade to resolve the active interpreter
path (e.g., conda envs). This keeps `jitcpp-debug` aligned with the interpreter
selected in VS Code.

Implementation notes:
- The npm package `@vscode/python-extension` provides typed access to the public
  Python extension API.
- The VS Code extension `ms-python.python` is listed in `extensionDependencies`
  so it is available at runtime.
- In `src/jitcpp_provider.ts`, we call:
  - `PythonExtension.api()` to get the API
  - `environments.getActiveEnvironmentPath(...)` to read the user-selected env
  - `environments.resolveEnvironment(...)` to get the executable path
- The resolved interpreter path is injected into `config.pythonPath` when missing.
