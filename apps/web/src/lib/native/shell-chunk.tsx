import type { ComponentType, JSX } from "react";
import { lazy, useCallback, useEffect, useState } from "react";

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

type Reload = { reload: () => void };

/** What a chunk that never loaded renders: nothing, until the window is back online, when it asks for a new load. */
const WaitForOnline = ({ reload }: Reload): null => {
    useEffect(() => {
        globalThis.addEventListener("online", reload, { once: true });

        return () => {
            globalThis.removeEventListener("online", reload);
        };
    }, [reload]);

    return null;
};

/**
 * `lazy()` for a shell chunk: a failed load is retried, and a chunk that never loads renders nothing, so the app runs
 * without it rather than falling to the root error boundary. No error boundary needed: the factory never rejects.
 * React caches a lazy component's result, so the next `online` event swaps in a fresh `lazy()` that loads again.
 */
export const lazyShellChunk = (load: () => Promise<{ default: ComponentType }>, retries?: number, baseDelay?: number): ComponentType => {
    const attempt = (): ComponentType<Reload> =>
        lazy(
            async (): Promise<{ default: ComponentType<Reload> }> =>
                await retryChunk(load, retries, baseDelay)
                    // The loaded chunk takes no props: `reload` is only for `WaitForOnline`.
                    .then(({ default: Loaded }) => {
                        return { default: (): JSX.Element => <Loaded /> };
                    })
                    .catch(() => {
                        return { default: WaitForOnline };
                    }),
        );
    // Shared by every mount, so a chunk loads once, and a reload from one mount serves the next.
    let current = attempt();

    const ShellChunk = (): JSX.Element => {
        const [Chunk, setChunk] = useState(() => current);
        const reload = useCallback((): void => {
            current = attempt();
            setChunk(() => current);
        }, []);

        return <Chunk reload={reload} />;
    };

    return ShellChunk;
};
