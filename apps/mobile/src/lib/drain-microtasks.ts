/** How many microtask turns a chain of awaits takes to settle; generous, and it waits on no clock. */
const MICROTASK_TURNS = 50;

/** For tests: lets every pending promise chain settle, through microtasks only (no timer, no wall-clock wait). */
export const drainMicrotasks = async (): Promise<void> => {
    for (let turn = 0; turn < MICROTASK_TURNS; turn += 1) {
        // eslint-disable-next-line no-await-in-loop -- each turn lets one more step of the chain settle
        await Promise.resolve();
    }
};
