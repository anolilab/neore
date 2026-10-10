import type { SandboxOutputFile, SandboxOutputs, SkippedSandboxFile } from "../types/sandbox";

/** Tool parts whose output may carry sandbox files. Only these: another tool's `files` field means something else. */
export const SANDBOX_FILE_TOOL_TYPES: ReadonlySet<string> = new Set(["tool-codeExecution", "tool-shellExecution"]);

const SKIP_REASONS: ReadonlySet<string> = new Set(["failed", "too-large", "too-many", "total-too-large", "unsupported-type"]);

/** The fields this module reads, each still unchecked. */
interface Unchecked {
    files?: unknown;
    mediaType?: unknown;
    name?: unknown;
    reason?: unknown;
    size?: unknown;
    skippedFiles?: unknown;
    url?: unknown;
}

const asObject = (value: unknown): Unchecked | null => (typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Unchecked) : null);

const isOutputFile = (value: unknown): value is SandboxOutputFile => {
    const file = asObject(value);

    return typeof file?.name === "string" && typeof file.mediaType === "string" && typeof file.size === "number" && typeof file.url === "string";
};

const isSkippedFile = (value: unknown): value is SkippedSandboxFile => {
    const file = asObject(value);

    return typeof file?.name === "string" && typeof file.reason === "string" && SKIP_REASONS.has(file.reason);
};

/** The sandbox files in a tool output, or `null` when it names none. Malformed entries are dropped. */
export const sandboxOutputsOf = (output: unknown): SandboxOutputs | null => {
    const fields = asObject(output);

    if (!fields) {
        return null;
    }

    const files = Array.isArray(fields.files) ? fields.files.filter((file) => isOutputFile(file)) : [];
    const skippedFiles = Array.isArray(fields.skippedFiles) ? fields.skippedFiles.filter((file) => isSkippedFile(file)) : [];

    return files.length > 0 || skippedFiles.length > 0 ? { files, skippedFiles } : null;
};
