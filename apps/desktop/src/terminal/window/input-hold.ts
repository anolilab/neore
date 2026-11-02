/**
 * Input the view produces before its shell is running. fish asks the terminal who it is (a primary
 * device attributes query) as it starts and waits for the answer; xterm answers through `onData`, which
 * is the same channel as typing. Dropping that answer, because the start call has not returned yet, left
 * fish waiting out its own timeout (ten seconds) before it showed a prompt.
 */
export interface InputHold {
    /** Forgets what was held: the shell it was meant for never started. */
    clear: () => void;
    /** Holds `data` while the shell starts. Past the limit the rest is dropped. */
    hold: (data: string) => void;
    /** Hands over what was held, in order, and empties the hold. */
    take: () => string;
}

export const createInputHold = (limit: number): InputHold => {
    let held = "";

    return {
        clear: () => {
            held = "";
        },
        hold: (data) => {
            held = (held + data).slice(0, limit);
        },
        take: () => {
            const taken = held;

            held = "";

            return taken;
        },
    };
};
