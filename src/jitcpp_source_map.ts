import * as fs from "fs";
import * as vscode from "vscode";

export type JitcppBlock = {
    // Absolute path to the Python file that contains the JIT block.
    pythonPath: string;
    // 1-based line range in the Python file that corresponds to the JIT C++ string.
    startLine: number;
    endLine: number;
};

type CachedBlocks = {
    // File modification time, used to invalidate the cache.
    mtimeMs: number;
    blocks: JitcppBlock[];
};

export class JitcppSourceMap {
    private readonly cache = new Map<string, CachedBlocks>();

    constructor(
        // Output channel for small diagnostics (not required for functionality).
        private readonly output: vscode.OutputChannel,
    ) { }

    getBlocks(pythonPath: string): JitcppBlock[] {
        // Read-and-parse the file only when it changes.
        if (!fs.existsSync(pythonPath)) {
            return [];
        }

        const stat = fs.statSync(pythonPath);
        const cached = this.cache.get(pythonPath);
        if (cached && cached.mtimeMs === stat.mtimeMs) {
            return cached.blocks;
        }

        const content = fs.readFileSync(pythonPath, "utf8");
        const blocks = this.extractBlocks(pythonPath, content);
        this.cache.set(pythonPath, { mtimeMs: stat.mtimeMs, blocks });
        return blocks;
    }

    private extractBlocks(pythonPath: string, content: string): JitcppBlock[] {
        // Very simple pattern-based parser:
        // - find a line with "@jitcpp"
        // - search forward for "return '''...'''" or "return \"\"\"...\"\"\""
        const lines = content.split(/\r?\n/);
        const blocks: JitcppBlock[] = [];
        for (let i = 0; i < lines.length; i += 1) {
            if (!/^\s*@jitcpp\b/.test(lines[i])) {
                continue;
            }

            const block = this.findReturnStringBlock(lines, i + 1);
            if (!block) {
                continue;
            }

            const { startLine, endLine, cppLines } = block;
            blocks.push({
                pythonPath,
                startLine,
                endLine,
            });
            this.writeCppBlock(pythonPath, startLine, cppLines);

            i = endLine - 1;
        }

        return blocks;
    }

    private findReturnStringBlock(
        lines: string[],
        startIndex: number,
    ): { startLine: number; endLine: number; cppLines: string[] } | undefined {
        // Searches for a return statement that directly returns a triple-quoted string.
        // This is intentionally simple and does not handle every Python edge case.
        for (let i = startIndex; i < lines.length; i += 1) {
            const line = lines[i];
            const match = line.match(/return\s*(?:(?:[rRuU][rRuU]?)\s*)?(\"\"\"|''')/);
            if (!match) {
                continue;
            }

            const quote = match[1];
            const quoteIndex = line.indexOf(quote, match.index);
            if (quoteIndex === -1) {
                return undefined;
            }

            const afterQuote = line.slice(quoteIndex + quote.length);
            const closingIndex = afterQuote.indexOf(quote);
            if (closingIndex !== -1) {
                // Entire string is on one line: return """..."""
                const inlineContent = afterQuote.slice(0, closingIndex);
                const startLine = i + 1;
                const endLine = i + 1;
                return {
                    startLine,
                    endLine,
                    cppLines: inlineContent ? [inlineContent] : [],
                };
            }

            const cppLines: string[] = [];
            let startLine = i + 2;
            if (afterQuote.length > 0) {
                // String content starts on the same line as the opening quote.
                cppLines.push(afterQuote);
                startLine = i + 1;
            }
            for (let j = i + 1; j < lines.length; j += 1) {
                const segment = lines[j];
                const endIndex = segment.indexOf(quote);
                if (endIndex !== -1) {
                    if (endIndex > 0) {
                        // Append the last content line before the closing quote.
                        cppLines.push(segment.slice(0, endIndex));
                    }
                    const endLine = j;
                    return { startLine, endLine, cppLines };
                }
                // Regular content line inside the triple-quoted string.
                cppLines.push(segment);
            }
        }

        return undefined;
    }

    private writeCppBlock(
        pythonPath: string,
        startLine: number,
        cppLines: string[],
    ): void {
        // Diagnostic hint to show that we detected a JIT block.
        this.output.appendLine(
            `Detected JIT C++ block at ${pythonPath}:${startLine} (${cppLines.length} lines).`,
        );
    }
}
