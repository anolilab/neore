/** What a crash report may carry: the error's name and its stack frames, never its message. */
interface CrashReport {
    name: string;
    stack?: string;
}

/**
 * The built-in error names. `name` is plain text an app can set to anything, so only
 * these are sent as they are; any other name becomes `Error`.
 */
const KNOWN_ERROR_NAMES: ReadonlySet<string> = new Set([
    "AggregateError",
    "Error",
    "EvalError",
    "RangeError",
    "ReferenceError",
    "SyntaxError",
    "TypeError",
    "URIError",
]);

/**
 * Reduces a thrown value to the fields a crash report may send. The message is
 * left out because it can quote thread text, and the first stack line repeats
 * it, so only the `at` frames are kept.
 */
export const toCrashReport = (error: unknown): CrashReport => {
    if (!(error instanceof Error)) {
        return { name: "NonError" };
    }

    const name = KNOWN_ERROR_NAMES.has(error.name) ? error.name : "Error";
    const frames = (error.stack ?? "")
        .split("\n")
        .filter((line) => line.trimStart().startsWith("at "))
        .join("\n");

    return frames.length > 0 ? { name, stack: frames } : { name };
};
