/**
 * Stores a generated clip, retrying a failed store a bounded number of times. The clip is paid for by the time it is
 * stored, so a store that keeps failing is reported (`onGiveUp`) and rethrown: the run fails, and nothing is billed for
 * a clip the member never gets. Storing the same bytes again is safe: the store keys its files by a hash of the bytes.
 */
export const retryClipStore = async <T>(
    store: () => Promise<T>,
    {
        attempts,
        onGiveUp,
        pauseMs = (attempt) => 200 * attempt,
    }: { attempts: number; onGiveUp: (error: unknown) => void; pauseMs?: (attempt: number) => number },
): Promise<T> => {
    let lastError: unknown;

    for (let attempt = 1; attempt <= attempts; attempt += 1) {
        try {
            return await store();
        } catch (error) {
            lastError = error;

            if (attempt < attempts) {
                // A retry only follows a failed store, so the attempts must run in order.
                await new Promise<void>((resolve) => {
                    setTimeout(resolve, pauseMs(attempt));
                });
            }
        }
    }

    onGiveUp(lastError);

    throw lastError;
};
