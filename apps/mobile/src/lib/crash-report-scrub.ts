/** What a crash report may carry: the error's name and its stack frames, never its message. */
interface CrashReport {
    name: string;
    stack?: string;
}

/**
 * Reduces a thrown value to the fields a crash report may send. The message is
 * left out because it can quote thread text, and the first stack line repeats
 * it, so only the `at` frames are kept.
 */
export const toCrashReport = (error: unknown): CrashReport => {
    if (!(error instanceof Error)) {
        return { name: "NonError" };
    }

    const name = error.name || "Error";
    const frames = (error.stack ?? "")
        .split("\n")
        .filter((line) => line.trimStart().startsWith("at "))
        .join("\n");

    return frames.length > 0 ? { name, stack: frames } : { name };
};
