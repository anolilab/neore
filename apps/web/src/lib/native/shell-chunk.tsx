import type { ReactNode } from "react";
import { Component } from "react";

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

/** Renders nothing once its children throw: a shell chunk that never loads costs its listeners, not the whole app. */
export class SilentBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
    public static getDerivedStateFromError(): { failed: boolean } {
        return { failed: true };
    }

    public override state = { failed: false };

    public override render(): ReactNode {
        const { failed } = this.state;
        const { children } = this.props;

        return failed ? null : children;
    }
}
