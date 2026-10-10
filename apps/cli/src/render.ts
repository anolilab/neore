/**
 * Output: the streaming renderer, tables, and colour that switches itself off.
 *
 * Human output goes to stdout; progress, reasoning and errors to stderr, so
 * `neore chat "…" > answer.md` captures exactly the answer. `--json` replaces
 * all of it with machine-readable stdout (NDJSON for streams).
 */
import type { StreamEvent } from "./client";
import { ApiError } from "./client";

export interface Writer {
    isTTY?: boolean;
    write: (chunk: string) => unknown;
}

export interface Io {
    env: NodeJS.ProcessEnv;
    stderr: Writer;
    stdout: Writer;
}

/** `NO_COLOR` (any value) and non-TTY output disable colour; `FORCE_COLOR` forces it. */
export const shouldUseColor = (writer: Writer, env: NodeJS.ProcessEnv): boolean => {
    if (env["NO_COLOR"] !== undefined && env["NO_COLOR"] !== "") {
        return false;
    }

    if (env["FORCE_COLOR"] !== undefined && env["FORCE_COLOR"] !== "0") {
        return true;
    }

    return writer.isTTY === true;
};

export const paint = (isEnabled: boolean) => {
    const wrap = (open: number, close: number) => (text: string) => (isEnabled ? `\u{1B}[${String(open)}m${text}\u{1B}[${String(close)}m` : text);

    return { bold: wrap(1, 22), cyan: wrap(36, 39), dim: wrap(2, 22), green: wrap(32, 39), red: wrap(31, 39), yellow: wrap(33, 39) };
};

export interface RenderedStream {
    reasoning: string;
    status: string;
    text: string;
}

/**
 * Render a reply stream as it arrives.
 *
 * Text goes to stdout unmodified (it is Markdown the user may pipe); reasoning
 * goes to stderr, dimmed, only with `showReasoning`. An `error` event throws an
 * `ApiError` AFTER the partial text was written, so the user keeps what arrived.
 * A stream that ends with neither `done` nor `error` was cut off — also an error.
 */
export const renderStream = async (
    events: AsyncIterable<StreamEvent>,
    io: Io,
    options: { json?: boolean; showReasoning?: boolean } = {},
): Promise<RenderedStream> => {
    const colors = paint(shouldUseColor(io.stderr, io.env));
    let text = "";
    let reasoning = "";
    let isInReasoning = false;
    let terminal: StreamEvent | undefined;

    for await (const event of events) {
        if (options.json) {
            io.stdout.write(`${JSON.stringify(event)}\n`);
        }

        switch (event.type) {
            case "done":
            case "error": {
                terminal = event;
                break;
            }
            case "reasoning": {
                reasoning += event.text ?? "";

                if (options.showReasoning && !options.json) {
                    io.stderr.write(colors.dim(event.text ?? ""));
                    isInReasoning = true;
                }

                break;
            }
            case "speaker": {
                if (!options.json) {
                    io.stdout.write(`${text ? "\n\n" : ""}${colors.bold(`[${event.name ?? "assistant"}]`)}\n`);
                }

                break;
            }
            case "text": {
                if (isInReasoning) {
                    io.stderr.write("\n");
                    isInReasoning = false;
                }

                text += event.text ?? "";

                if (!options.json) {
                    io.stdout.write(event.text ?? "");
                }

                break;
            }
            default: {
                break;
            }
        }

        if (terminal) {
            break;
        }
    }

    if (text && !options.json && !text.endsWith("\n")) {
        io.stdout.write("\n");
    }

    if (!terminal) {
        throw new ApiError({
            code: "stream_interrupted",
            message: "The stream ended before the reply finished. The full reply will be in the thread.",
            status: 0,
        });
    }

    if (terminal.type === "error") {
        throw new ApiError({ code: terminal.error?.code ?? "generation_failed", message: terminal.error?.message ?? "The generation failed.", status: 0 });
    }

    return { reasoning, status: terminal.status ?? "done", text };
};

/** Left-aligned columns, the last column unpadded; cells are single-lined and truncated. */
export const formatTable = (rows: ReadonlyArray<ReadonlyArray<string>>, maxCell = 60): string => {
    if (rows.length === 0) {
        return "";
    }

    const cells = rows.map((row) =>
        row.map((cell) => {
            const flat = cell.replaceAll(/\s+/gu, " ").trim();

            return flat.length > maxCell ? `${flat.slice(0, maxCell - 1)}…` : flat;
        }),
    );
    const widths = cells[0]!.map((_, column) => Math.max(...cells.map((row) => row[column]?.length ?? 0)));

    return `${cells.map((row) => row.map((cell, column) => (column === row.length - 1 ? cell : cell.padEnd(widths[column]!))).join("  ")).join("\n")}\n`;
};

export const formatDate = (epochMs: number | null | undefined): string => (epochMs ? new Date(epochMs).toISOString().slice(0, 16).replace("T", " ") : "-");

export const printJson = (io: Io, value: unknown): void => {
    io.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
};
