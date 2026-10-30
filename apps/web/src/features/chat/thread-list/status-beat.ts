import { useEffect } from "react";

const STEP_MS = 500;
const STEPS = 3;
const ATTRIBUTE = "statusBeat";
const REDUCED_MOTION_QUERY = "(prefers-reduced-motion: reduce)";

const clock: {
    attached: boolean;
    beat: number;
    reducedMotion: MediaQueryList | undefined;
    subscribers: number;
    timer: ReturnType<typeof setInterval> | undefined;
} = { attached: false, beat: 0, reducedMotion: undefined, subscribers: 0, timer: undefined };

const setBeat = (value: number): void => {
    clock.beat = value;
    document.documentElement.dataset[ATTRIBUTE] = String(value);
};

const advance = (): void => {
    setBeat((clock.beat + 1) % STEPS);
};

const stopTimer = (): void => {
    if (clock.timer !== undefined) {
        clearInterval(clock.timer);
        clock.timer = undefined;
    }

    Reflect.deleteProperty(document.documentElement.dataset, ATTRIBUTE);
};

const sync = (): void => {
    if (clock.subscribers === 0 || document.hidden || clock.reducedMotion?.matches) {
        stopTimer();

        return;
    }

    if (clock.timer === undefined) {
        setBeat(0);
        clock.timer = setInterval(advance, STEP_MS);
    }
};

const attach = (): void => {
    if (clock.attached) {
        return;
    }

    clock.attached = true;
    clock.reducedMotion = globalThis.matchMedia(REDUCED_MOTION_QUERY);
    clock.reducedMotion.addEventListener("change", sync);
    document.addEventListener("visibilitychange", sync);
};

const detach = (): void => {
    clock.attached = false;
    clock.reducedMotion?.removeEventListener("change", sync);
    clock.reducedMotion = undefined;
    document.removeEventListener("visibilitychange", sync);
};

/** Registers one subscriber on the shared clock; the returned function unregisters it. */
export const subscribeStatusBeat = (): (() => void) => {
    clock.subscribers += 1;
    attach();
    sync();

    let released = false;

    return () => {
        if (released) {
            return;
        }

        released = true;
        clock.subscribers -= 1;
        sync();

        if (clock.subscribers === 0) {
            detach();
        }
    };
};

/** While `active`, the shared clock writes `data-status-beat` (0, 1, 2) on the root, one DOM write per step for every row. */
export const useStatusBeat = (active: boolean): void => {
    useEffect(() => {
        if (!active) {
            return undefined;
        }

        return subscribeStatusBeat();
    }, [active]);
};
