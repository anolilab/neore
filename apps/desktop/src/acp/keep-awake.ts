/**
 * Keeps the computer awake while a host agent turn runs on it, so the system does not sleep in the middle of a turn.
 *
 * One OS sleep inhibitor is held while at least one source (a manager, one per computer or per SSH server) reports a
 * running turn. It is released when the last source reports none, and on quit. Losing the lock never fails a turn:
 * a blocker that throws is logged, and the lock asks again after a pause (`RETRY_MS`), on its own timer and on any
 * report that comes after the pause.
 */

/** The part of Electron's `powerSaveBlocker` the lock uses; a fake stands in for it in tests. */
export interface SleepBlocker {
    isStarted: (id: number) => boolean;
    start: () => number;
    stop: (id: number) => void;
}

/** How long a failed start or stop waits before the platform is asked again. */
const RETRY_MS = 5000;

export class SleepLock {
    /** The sources that have a turn running now. A set, so a report that repeats changes nothing. */
    private readonly running = new Set<object>();

    private blockerId: number | undefined;

    /** The pending retry after a failed call, and until when a report may not ask the platform again. */
    private retry: ReturnType<typeof setTimeout> | undefined;

    private retryAt = 0;

    public constructor(
        private readonly blocker: SleepBlocker,
        private readonly log?: (message: string) => void,
        private readonly retryMs: number = RETRY_MS,
    ) {}

    /** Records whether `source` has a turn running, and holds or releases the inhibitor to match. */
    public report(source: object, running: boolean): void {
        const changed = this.running.has(source) !== running;

        if (changed) {
            if (running) {
                this.running.add(source);
            } else {
                this.running.delete(source);
            }
        }

        // An output update repeats the state: it asks the platform only when the lock does not match the turns, and
        // not during the pause after a failed call (the retry timer does that).
        const wanted = this.running.size > 0;

        if (!changed && (this.blockerId !== undefined) === wanted) {
            return;
        }

        if (!changed && Date.now() < this.retryAt) {
            return;
        }

        this.sync();
    }

    /** Forgets every source and releases the inhibitor. Called at quit, when the turns are being killed. */
    public release(): void {
        this.running.clear();
        this.sync();
    }

    private sync(): void {
        this.cancelRetry();

        const wanted = this.running.size > 0;

        try {
            if (wanted) {
                if (this.blockerId === undefined || !this.blocker.isStarted(this.blockerId)) {
                    this.blockerId = this.blocker.start();
                }

                return;
            }

            // The id stays until the stop is confirmed, so a stop that throws is retried.
            if (this.blockerId !== undefined) {
                if (this.blocker.isStarted(this.blockerId)) {
                    this.blocker.stop(this.blockerId);
                }

                this.blockerId = undefined;
            }
        } catch (error) {
            this.log?.(`[keep-awake] could not ${wanted ? "hold" : "release"} the sleep lock: ${(error as Error).message}`);
            this.retryLater();
        }
    }

    private retryLater(): void {
        this.retryAt = Date.now() + this.retryMs;
        this.retry = setTimeout(() => {
            this.retry = undefined;
            this.sync();
        }, this.retryMs);
        // A pending retry never keeps the app running on its own.
        this.retry.unref();
    }

    private cancelRetry(): void {
        if (this.retry !== undefined) {
            clearTimeout(this.retry);
        }

        this.retry = undefined;
        this.retryAt = 0;
    }
}
