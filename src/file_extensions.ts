import * as path from "path";

export const DEFAULT_PYTHON_FILE_EXTENSIONS = [".py"];
export const DEFAULT_CPP_FILE_EXTENSIONS = [
    ".cpp",
    ".cc",
    ".cxx",
    ".hpp",
    ".hh",
    ".hxx",
    ".h",
];

export function normalizeExtensionList(
    extensions: unknown,
    defaults: string[],
): string[] {
    const normalized = new Set<string>();

    const addExtension = (value: string): void => {
        const trimmed = value.trim().toLowerCase();
        if (!trimmed) {
            return;
        }
        const withDot = trimmed.startsWith(".") ? trimmed : `.${trimmed}`;
        normalized.add(withDot);
    };

    for (const extension of defaults) {
        addExtension(extension);
    }

    if (Array.isArray(extensions)) {
        for (const extension of extensions) {
            if (typeof extension === "string") {
                addExtension(extension);
            }
        }
    }

    return Array.from(normalized.values());
}

export function extractExtensionsFromAssociations(
    associations: Record<string, string> | undefined,
    languages: string[],
): string[] {
    if (!associations) {
        return [];
    }

    const languageSet = new Set(languages.map((language) => language.toLowerCase()));
    const extensions = new Set<string>();

    for (const [pattern, language] of Object.entries(associations)) {
        if (!languageSet.has(language.toLowerCase())) {
            continue;
        }

        const extension = extractExtensionFromPattern(pattern);
        if (extension) {
            extensions.add(extension.toLowerCase());
        }
    }

    return Array.from(extensions.values());
}

function extractExtensionFromPattern(pattern: string): string | undefined {
    const trimmed = pattern.trim();
    if (!trimmed) {
        return undefined;
    }

    if (trimmed.startsWith("*.") && trimmed.length > 2) {
        return `.${trimmed.slice(2)}`;
    }

    if (trimmed.startsWith(".")) {
        return trimmed;
    }

    const ext = path.extname(trimmed);
    return ext || undefined;
}
