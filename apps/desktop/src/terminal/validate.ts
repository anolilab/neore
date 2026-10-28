/**
 * Type and size checks on what the terminal window sends, before it reaches the host. The shell
 * is the user's own, so these keep a malformed or runaway value out of the pseudo-terminal rather
 * than judge what is typed.
 */

export const MAX_COLUMNS = 1000;
export const MAX_ROWS = 1000;
/** One write to the shell. A paste above this is refused, not cut. */
export const MAX_INPUT_CHARS = 1024 * 1024;
/** One copy to the clipboard. */
export const MAX_COPY_CHARS = 1024 * 1024;

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

const dimension = (value: unknown, name: string, max: number): number => {
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1 || value > max) {
        throw new Error(`terminal: ${name} is invalid`);
    }

    return value;
};

export const readSize = (value: unknown): { cols: number; rows: number } => {
    if (!isRecord(value)) {
        throw new Error("terminal: size is invalid");
    }

    return { cols: dimension(value.cols, "cols", MAX_COLUMNS), rows: dimension(value.rows, "rows", MAX_ROWS) };
};

export const readInput = (value: unknown): string => {
    if (typeof value !== "string" || value.length === 0 || value.length > MAX_INPUT_CHARS) {
        throw new Error("terminal: input is invalid");
    }

    return value;
};

export const readCopy = (value: unknown): string => {
    if (typeof value !== "string" || value.length > MAX_COPY_CHARS) {
        throw new Error("terminal: text is invalid");
    }

    return value;
};

export const readAck = (value: unknown): number => {
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0 || value > MAX_INPUT_CHARS * 64) {
        throw new Error("terminal: ack is invalid");
    }

    return value;
};
