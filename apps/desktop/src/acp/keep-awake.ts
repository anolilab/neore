/**
 * Keeps the computer awake while a host agent turn runs on it, so the system does not sleep in the middle of a turn.
 *
 * One OS sleep inhibitor is held while at least one source (a manager, one per computer or per SSH server) reports a
 * running turn. It is released when the last source reports none, and on quit. Losing the lock never fails a turn:
 * a blocker that throws is logged and the turn goes on without it.
 */

/** The part of Electron's `powerSaveBlocker` the lock uses; a fake stands in for it in tests. */
export interface SleepBlocker {
    isStarted: (id: number) => boolean;
    start: () => number;
    stop: (id: number) => void;
}

export class SleepLock {
    /** The sources that have a turn running now. A set, so a report that repeats changes nothing. */
    private readonly running = new Set<object>();

    private blockerId: number | undefined;

    public constructor(
        private readonly blocker: SleepBlocker,
        private readonly log?: (message: string) => void,
    ) {}

    /** Records whether `source` has a turn running, and holds or releases the inhibitor to match. */
    public report(source: object, running: boolean): void {
        // Only a change of state touches the platform: output updates report the same state again and cost nothing.
        if (this.running.has(source) === running) {
            return;
        }

        if (running) {
            this.running.add(source);
        } else {
            this.running.delete(source);
        }

        this.sync();
    }

    /** Forgets every source and releases the inhibitor. Called at quit, when the turns are being killed. */
    public release(): void {
        this.running.clear();
        this.sync();
    }

    private sync(): void {
        const wanted = this.running.size > 0;

        try {
            if (wanted) {
                if (this.blockerId === undefined || !this.blocker.isStarted(this.blockerId)) {
                    this.blockerId = this.blocker.start();
                }

                return;
            }

            // The id stays until the stop is confirmed, so a stop that throws can be retried by the next release.
            if (this.blockerId !== undefined) {
                if (this.blocker.isStarted(this.blockerId)) {
                    this.blocker.stop(this.blockerId);
                }

                this.blockerId = undefined;
            }
        } catch (error) {
            this.log?.(`[keep-awake] could not ${wanted ? "hold" : "release"} the sleep lock: ${(error as Error).message}`);
        }
    }
}
