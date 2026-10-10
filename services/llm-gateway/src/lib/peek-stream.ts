/**
 * Stream warm-up helper.
 *
 * Awaits the first item of an async iterator (or rejects on timeout/empty/error)
 * before the caller commits to a streaming response. Lets the gateway return a
 * structured JSON failure for fall-back routing instead of a half-written SSE
 * stream when the chosen model doesn't respond.
 */

export type PeekResult<T> =
    | { elapsedMs: number; first: T; ok: true; rest: AsyncIterator<T> }
    | { elapsedMs: number; ok: false; reason: "timeout" }
    | { elapsedMs: number; ok: false; reason: "empty" }
    | { elapsedMs: number; error: unknown; ok: false; reason: "error" };

export const DEFAULT_PEEK_TIMEOUT_MS = 15_000;

/**
 * Pull the first item from an async iterator with a deadline.
 *
 * On success: returns `{ ok: true, first, rest }` where `rest` continues the
 * original iterator. On timeout/empty/error: returns a tagged failure so the
 * caller can synthesize a fall-back response without writing partial output.
 *
 * The underlying iterator's `return()` is called on failure to give the
 * provider a chance to release sockets / cancel in-flight requests.
 */
export const peekStream = async <T>(iter: AsyncIterator<T>, timeoutMs: number = DEFAULT_PEEK_TIMEOUT_MS): Promise<PeekResult<T>> => {
    const startedAt = Date.now();
    let timer: ReturnType<typeof setTimeout> | undefined;

    const timeout = new Promise<{ kind: "timeout" }>((resolve) => {
        timer = setTimeout(resolve, timeoutMs, { kind: "timeout" });
    });

    try {
        const winner = await Promise.race([
            iter.next().then((r) => {
                return { kind: "next" as const, r };
            }),
            timeout,
        ]);

        if (timer !== undefined) {
            clearTimeout(timer);
        }

        if (winner.kind === "timeout") {
            // Best-effort cancel — providers should release the connection.
            iter.return?.(undefined)?.catch(() => undefined);

            return { elapsedMs: Date.now() - startedAt, ok: false, reason: "timeout" };
        }

        if (winner.r.done) {
            return { elapsedMs: Date.now() - startedAt, ok: false, reason: "empty" };
        }

        return { elapsedMs: Date.now() - startedAt, first: winner.r.value, ok: true, rest: iter };
    } catch (error) {
        if (timer !== undefined) {
            clearTimeout(timer);
        }

        iter.return?.(undefined)?.catch(() => undefined);

        return { elapsedMs: Date.now() - startedAt, error, ok: false, reason: "error" };
    }
};
