/**
 * Pure reading of a device tool call's input and output for the chat row:
 * what `shell_run` ran and how it ended, and a compact summary of the `fs_*`
 * tools. The tool output is `{ ok, output, exitCode?, truncated?, error? }`
 * (`backend/lunora/chat/lib/device-tools.ts`); the device merges stdout and
 * stderr into the one `output` string, so they cannot be shown apart.
 */

/** The device's own output cap, `MAX_OUTPUT_BYTES` in packages/device-core. */
export const DEVICE_OUTPUT_CAP_LABEL = "64 KB";

export interface ShellView {
    command: string | undefined;
    cwd: string | undefined;
    error: string | undefined;
    exitCode: number | undefined;
    output: string;
    truncated: boolean;
}

export interface FsRow {
    label: "bytes" | "entries" | "path" | "size" | "type";
    value: string;
}

export interface FsView {
    /** Plain text to show under the rows (file content, or the write confirmation). */
    body: string | undefined;
    rows: FsRow[];
    truncated: boolean;
}

interface JsonObject {
    [key: string]: unknown;
}

const asRecord = (value: unknown): JsonObject | undefined =>
    typeof value === "object" && value !== null && !Array.isArray(value) ? (value as JsonObject) : undefined;

const asString = (value: unknown): string | undefined => (typeof value === "string" ? value : undefined);

const parseJson = (text: string): unknown => {
    try {
        return JSON.parse(text);
    } catch {
        return undefined;
    }
};

/** A tool input arrives as an object, or as its JSON text. */
const readInput = (input: unknown): JsonObject | undefined => asRecord(typeof input === "string" ? parseJson(input) : input);

export const isShellTool = (toolName: string): boolean => toolName === "shell_run";

export const isFsTool = (toolName: string): boolean => toolName.startsWith("fs_");

export const readShell = (input: unknown, output: unknown): ShellView => {
    const args = readInput(input);
    const result = asRecord(output);
    const exitCode = result?.exitCode;

    return {
        command: asString(args?.command),
        cwd: asString(args?.cwd),
        error: asString(result?.error),
        exitCode: typeof exitCode === "number" && Number.isFinite(exitCode) ? exitCode : undefined,
        output: asString(result?.output) ?? (typeof output === "string" ? output : ""),
        truncated: result?.truncated === true,
    };
};

const BINARY = /^\[binary file, (\d+) bytes\]$/;
const WROTE = /^wrote (\d+) bytes to (.+)$/s;

const formatBytes = (bytes: number): string => {
    if (bytes < 1024) {
        return `${String(bytes)} B`;
    }

    return bytes < 1024 * 1024 ? `${(bytes / 1024).toFixed(1)} KB` : `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
};

const listView = (listing: JsonObject): FsView | undefined => {
    if (!Array.isArray(listing.entries)) {
        return undefined;
    }

    const names = listing.entries.map((entry) => {
        const row = asRecord(entry);
        const name = asString(row?.name) ?? "?";

        return row?.type === "dir" || row?.type === "directory" ? `${name}/` : name;
    });
    const rows: FsRow[] = [];
    const path = asString(listing.path);

    if (path !== undefined) {
        rows.push({ label: "path", value: path });
    }

    rows.push({ label: "entries", value: String(names.length) });

    return { body: names.join("\n"), rows, truncated: listing.truncated === true };
};

/** Null when the output is not a shape this knows, so the caller shows the raw JSON. */
export const readFs = (toolName: string, input: unknown, output: unknown): FsView | null => {
    const result = asRecord(output);

    if (!result || result.ok !== true || typeof result.output !== "string") {
        return null;
    }

    const text = result.output;

    if (toolName === "fs_list") {
        const listing = asRecord(parseJson(text));

        return listing ? (listView(listing) ?? null) : null;
    }

    const truncated = result.truncated === true;

    if (toolName === "fs_write") {
        const wrote = WROTE.exec(text);

        if (!wrote) {
            return null;
        }

        return {
            body: undefined,
            rows: [
                { label: "path", value: wrote[2] ?? "" },
                { label: "bytes", value: formatBytes(Number(wrote[1])) },
            ],
            truncated,
        };
    }

    if (toolName === "fs_read") {
        const path = asString(readInput(input)?.path);
        const binary = BINARY.exec(text);
        const rows: FsRow[] = path === undefined ? [] : [{ label: "path", value: path }];

        if (binary) {
            return {
                body: undefined,
                rows: [...rows, { label: "type", value: "binary" }, { label: "size", value: formatBytes(Number(binary[1])) }],
                truncated,
            };
        }

        return { body: text, rows: [...rows, { label: "size", value: formatBytes(new TextEncoder().encode(text).length) }], truncated };
    }

    return null;
};
