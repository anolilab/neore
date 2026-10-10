/**
 * The jobs queue's dispatch, with one quick retry for a TRANSPORT failure.
 *
 * A handler that throws gets its batch retried by `@lunora/queue`, which waits
 * out the consumer's `retry_delay` (5s) plus the next batch window. A dispatch
 * that never reached the origin — a dropped loopback connection, which local
 * dev raises as "Network connection lost." — cost a chat reply 20-40s that way (the first delivery of the agent
 * run failed in transit; the redelivery ran in 150ms).
 *
 * So a failure that is not the function's own answer — no Lunora error code,
 * or a 5xx without the function's error envelope — is retried once, at once.
 * That is safe because every queue target claims its work before doing any
 * (`lib/job-queue.ts`), so a dispatch that did land and only lost its reply is
 * a no-op the second time. The function's own error goes back to the queue
 * unchanged. Either way it is logged.
 */

/** Delay before the one immediate retry of a transport failure. */
export const TRANSPORT_RETRY_DELAY_MS = 250;

/**
 * `@lunora/queue`'s message for a response that carried no Lunora error
 * envelope — the origin never answered as the function; something in between
 * did (local dev's proxy answers a dropped connection with a bare 500).
 */
const NO_ENVELOPE = /function dispatch failed \(5\d\d\)/;

/**
 * Whether `error` came from the transport rather than from the dispatched
 * function: a rejected fetch (no `code`), or a 5xx whose body was not the
 * function's own error.
 */
export const isTransportFailure = (error: unknown): boolean => {
    if (typeof error !== "object" || error === null || typeof (error as { code?: unknown }).code !== "string") {
        return true;
    }

    return error instanceof Error && NO_ENVELOPE.test(error.message);
};

const describe = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/** `run()` once more, after `delayMs`, when its first failure was a transport failure; `what` names it in the logs. */
export const withTransportRetry = async (run: () => Promise<unknown>, what: string, delayMs: number = TRANSPORT_RETRY_DELAY_MS): Promise<void> => {
    try {
        await run();

        return;
    } catch (error) {
        if (!isTransportFailure(error)) {
            console.error(`[jobs] ${what} failed: ${describe(error)}`);

            throw error;
        }

        console.warn(`[jobs] ${what} dispatch failed in transit, retrying once: ${describe(error)}`);
    }

    await new Promise((resolve) => {
        setTimeout(resolve, delayMs);
    });

    try {
        await run();
    } catch (error) {
        console.error(`[jobs] ${what} failed: ${describe(error)}`);

        throw error;
    }
};
