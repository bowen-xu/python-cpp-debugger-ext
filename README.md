# Python C++ Mixed Debugger

![demo_breakpoints](imgs/demo_breakpoints.gif)

## Goal

Provide a single VS Code debug session that can step and break in both:
- native Python code, and
- C++ code stored in separate source files alongside your Python project.

## How It Works

The `pycpp-debug` adapter is a thin DAP bridge:
- It launches the Python debugger (debugpy) to run the Python program.
- It launches an LLDB DAP adapter and attaches it to the same Python process.
- When you set breakpoints, it routes them:
  - Python files -> debugpy
  - C/C++ files -> LLDB

Routing is based on file extensions. The adapter defaults to `.py` for Python and common C/C++ extensions, and also respects VS Code's `files.associations` overrides.

## Requirements

- VS Code Python Debugger extension (ms-python.debugpy)
- VS Code Python extension (ms-python.python) for interpreter selection
- A Python interpreter in PATH (or configure `pythonPath`)
- CodeLLDB (vadimcn.vscode-lldb) or `lldb-dap` in PATH

## Usage

Add a `pycpp-debug` launch config. The adapter forwards to debugpy and routes JIT breakpoints to LLDB.

```json
{
    "name": "PYCPP: Mixed Debugger",
    "type": "pycpp-debug",
    "request": "launch",
    "program": "${file}",
    "cwd": "${workspaceFolder}",
    "args": [],
    "env": {}
}
```

### Optional adapter paths

Use these when your environment is non-standard (custom Python, debugpy adapter, or LLDB adapter path):

```json
{
  "type": "pycpp-debug",
  "request": "launch",
  "program": "${file}",
  "pythonPath": "python3",
  "debugpyAdapterPath": "/path/to/debugpy.adapter",
  "lldbAdapterPath": "/path/to/codelldb"
}
```

### Interpreter selection

If `pythonPath` is not set, the adapter uses the active interpreter selected by the VS Code Python extension. Use `pythonPath` to override it explicitly.

### Optional file extension overrides

By default, the adapter routes `.py` to debugpy and common C/C++ extensions to LLDB. You can override these lists explicitly:

```json
{
  "type": "pycpp-debug",
  "request": "launch",
  "program": "${file}",
  "pythonFileExtensions": [".py"],
  "cppFileExtensions": [".cpp", ".hpp"]
}
```

## Notes

- The UI shows a single `pycpp-debug` session; Python events come from debugpy.
- Breakpoints are routed by file extension; customize via `files.associations` or the launch config overrides.


## License

Copyright (C) 2026 Bowen Xu

This project is licensed under the GNU General Public License v3.0.