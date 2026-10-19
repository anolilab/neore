/** One live query's subscription state — the unit `LiveQueryManager` tracks per query hash. */
import type { QueryKey } from "@tanstack/react-query";

/**
 * How long `fetch` waits for a fresh subscription's first value before falling
 * back to an RPC. A socket normally opens in well under a second; this bounds
 * the case where it cannot open at all.
 */
export const FIRST_VALUE_TIMEOUT_MS = 5000;

/** What `firstValue` resolves with when there is no value to give: error, release, or timeout. */
export const NO_VALUE: unique symbol = Symbol("no-value");

export type SubscriptionError = { code?: string; message: string };

/**
 * `queued` → `seeding` → `settled`, and `closed` from any of them.
 *
 * `seeding` is the only state that holds one of the manager's seed slots
 * (`MAX_CONCURRENT_SEEDS`). Every way out of it — `settle` and `close` — reports
 * whether it held one, so the manager's slot count moves in exactly one place.
 */
export type EntryState = "closed" | "queued" | "seeding" | "settled";

/** One subscribed query: its state, its latest pushed value, and who awaits the first. */
export class Entry {
    public error: SubscriptionError | undefined;

    public hasValue = false;

    public value: unknown;

    private currentState: EntryState = "queued";

    private lingerTimer: ReturnType<typeof setTimeout> | undefined;

    private seedTimer: ReturnType<typeof setTimeout> | undefined;

    private unsubscribe: (() => void) | undefined;

    private readonly waiters = new Set<(value: unknown) => void>();

    public constructor(
        public readonly path: string,
        public readonly args: Readonly<Record<string, unknown>>,
        public readonly queryKey: QueryKey,
    ) {}

    public get state(): EntryState {
        return this.currentState;
    }

    public get isLingering(): boolean {
        return this.lingerTimer !== undefined;
    }

    /**
     * `queued` → `seeding`: the entry now holds a seed slot. `onSlotTimeout` fires
     * if no first answer arrives within `timeoutMs`; returns whether it started.
     */
    public beginSeeding(timeoutMs: number, onSlotTimeout: () => void): boolean {
        if (this.currentState !== "queued") {
            return false;
        }

        this.currentState = "seeding";
        this.seedTimer = setTimeout(onSlotTimeout, timeoutMs);

        return true;
    }

    /** Keeps the subscription's teardown; a closed entry tears it down at once. */
    public attach(unsubscribe: () => void): void {
        if (this.currentState === "closed") {
            unsubscribe();

            return;
        }

        this.unsubscribe = unsubscribe;
    }

    /** `seeding` → `settled`. Returns whether this gave a seed slot back. */
    public settle(): boolean {
        if (this.currentState !== "seeding") {
            return false;
        }

        clearTimeout(this.seedTimer);
        this.seedTimer = undefined;
        this.currentState = "settled";

        return true;
    }

    /** Starts the linger countdown; a no-op while one is already running. */
    public linger(timeoutMs: number, onExpire: () => void): void {
        if (this.lingerTimer !== undefined) {
            return;
        }

        this.lingerTimer = setTimeout(onExpire, timeoutMs);
    }

    public stopLingering(): void {
        clearTimeout(this.lingerTimer);
        this.lingerTimer = undefined;
    }

    public receive(value: unknown): void {
        this.error = undefined;
        this.hasValue = true;
        this.value = value;
        this.flush(value);
    }

    public fail(error: SubscriptionError): void {
        this.error = error;
        this.flush(NO_VALUE);
    }

    /** Resolves with the first value, or `NO_VALUE` on error, release or timeout. */
    public async firstValue(): Promise<unknown> {
        return await new Promise((resolve) => {
            let timer: ReturnType<typeof setTimeout> | undefined;
            const waiter = (value: unknown): void => {
                clearTimeout(timer);
                resolve(value);
            };

            timer = setTimeout(() => {
                this.waiters.delete(waiter);
                resolve(NO_VALUE);
            }, FIRST_VALUE_TIMEOUT_MS);
            this.waiters.add(waiter);
        });
    }

    /** Any state → `closed`. Returns whether this gave a seed slot back. */
    public close(): boolean {
        const heldSlot = this.settle();

        this.stopLingering();
        this.currentState = "closed";
        this.flush(NO_VALUE);
        this.unsubscribe?.();
        this.unsubscribe = undefined;

        return heldSlot;
    }

    private flush(value: unknown): void {
        for (const waiter of this.waiters) {
            waiter(value);
        }

        this.waiters.clear();
    }
}
