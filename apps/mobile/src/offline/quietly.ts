/**
 * Runs work whose failure nobody can act on, such as a cache save or a refresh on reconnect. The screen has what it
 * shows already; a failed extra must not take it down.
 */
export const settleQuietly = (work: (() => Promise<unknown>) | Promise<unknown> | undefined): void => {
    const run = async () => {
        try {
            await (typeof work === "function" ? work() : work);
        } catch {
            // Deliberately dropped: see above.
        }
    };

    run();
};
