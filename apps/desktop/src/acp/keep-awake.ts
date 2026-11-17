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

/** How often an output update checks the inhibitor the platform holds. */
const VERIFY_MS = 5000;

/** A readable reason for a failed call, whatever the blocker threw: the log must never fail a turn. */
const reasonOf = (error: unknown): string => {
    if (error instanceof Error) {
        return error.message;
    }

    try {
        return String(error);
    } catch {
        return "unknown error";
    }
};

export class SleepLock {
    /** The sources that have a turn running now. A set, so a report that repeats changes nothing. */
    private readonly running = new Set<object>();

    private blockerId: number | undefined;

    /** The pending retry after a failed call, and until when a report may not ask the platform again. */
    private retry: ReturnType<typeof setTimeout> | undefined;

    private retryAt = 0;

    /** The state the last failed call was made for: during the pause, the platform is not asked again for that state. */
    private failedWanted = false;

    /** Until when an output update does not check the inhibitor again. */
    private verifyAt = 0;

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

        const wanted = this.running.size > 0;

        // During the pause after a failed call, the same state is not asked of the platform again: the retry timer does
        // that. A reversed state goes through at once, so a turn that ends is never kept awake by a pending start.
        if (Date.now() < this.retryAt && wanted === this.failedWanted) {
            return;
        }

        // An output update repeats the state. It checks the inhibitor at most once per `VERIFY_MS`, so a streamed update does
        // not ask the platform each time; the check takes back an inhibitor the platform dropped during the turn.
        if (!changed) {
            if (Date.now() < this.verifyAt) {
                return;
            }

            this.verifyAt = Date.now() + VERIFY_MS;

            const held = this.stillHeld(wanted);

            if (held === wanted) {
                return;
            }
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
            this.fail(error, wanted);
        }
    }

    /** Whether the inhibitor the lock holds is still started. A platform error is logged and retried, and reads as held. */
    private stillHeld(wanted: boolean): boolean {
        if (this.blockerId === undefined) {
            return false;
        }

        try {
            return this.blocker.isStarted(this.blockerId);
        } catch (error) {
            this.fail(error, wanted);

            return wanted;
        }
    }

    /** Logs a failed platform call, and holds further calls for the same state until the retry. */
    private fail(error: unknown, wanted: boolean): void {
        const reason = reasonOf(error);

        this.log?.(`[keep-awake] could not ${wanted ? "hold" : "release"} the sleep lock: ${reason}`);
        this.failedWanted = wanted;
        this.retryLater();
    }

    private retryLater(): void {
        this.cancelRetry();
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
