import type { ComponentType } from "react";
import { lazy } from "react";

/** How many times a failed load of a shell chunk is retried. */
const SHELL_CHUNK_RETRIES = 3;

/**
 * Runs `load` until it resolves, retrying a rejection 1, 2 and 4 seconds later (`baseDelay` doubles), and rejects with
 * the last error. For a `lazy()` factory: React caches a rejected factory, so the retries must happen inside it.
 */
export const retryChunk = async <T,>(load: () => Promise<T>, retries = SHELL_CHUNK_RETRIES, baseDelay = 1000): Promise<T> => {
    for (let attempt = 0; ; attempt += 1) {
        try {
            return await load();
        } catch (error) {
            if (attempt >= retries) {
                throw error;
            }

            await new Promise<void>((resolve) => {
                setTimeout(resolve, baseDelay * 2 ** attempt);
            });
        }
    }
};

const Nothing = (): null => null;

/**
 * `lazy()` for a shell chunk: a failed load is retried, and a chunk that never loads renders nothing, so the app runs
 * without it rather than falling to the root error boundary. No error boundary needed: the factory never rejects.
 */
export const lazyShellChunk = (load: () => Promise<{ default: ComponentType }>, retries?: number, baseDelay?: number): ComponentType =>
    lazy(
        async () =>
            await retryChunk(load, retries, baseDelay).catch(() => {
                return { default: Nothing };
            }),
    );
