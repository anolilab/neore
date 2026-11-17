import { useEffect, useRef, useState } from "react";

type Timer = ReturnType<typeof setTimeout>;

/** A step to say, and the thread it was heard in. */
export interface SpokenStep {
    label: string;
    threadId: string | null | undefined;
}

interface Spoken {
    text: string;
    threadId: string | null | undefined;
}

/** How long a label stays in the region before the next clear, so each label is heard before it changes. */
const HOLD_MS = 50;
/** The beat between a clear and the text that follows it, so the clear is a change of its own. */
const SET_DELAY_MS = 50;

/** Runs `action` after `delay`, keeping the timer in `pending` until it fires so its owner can clear it. */
const scheduleTimer = (pending: Set<Timer>, delay: number, action: () => void): void => {
    const timer = setTimeout(() => {
        pending.delete(timer);
        action();
    }, delay);

    pending.add(timer);
};

const cancelAll = (pending: Set<Timer>): void => {
    for (const timer of pending) {
        clearTimeout(timer);
    }

    pending.clear();
};

/**
 * The text a live region should say for `step`. Each step clears the text and then sets it
 * after a beat, so the same step twice in a row is still a change the reader hears. A step
 * that starts while the previous one is still held waits its turn, so it is not folded into
 * the same change. Pending timers are dropped when the step is cleared (the reply ended) and
 * on a thread change, and text said in another thread is never shown.
 */
export const useSpokenStep = (step: SpokenStep | null, threadId: string | null | undefined): string => {
    const [spoken, setSpoken] = useState<Spoken>({ text: "", threadId });
    const timers = useRef(new Set<Timer>());
    // The moment the region may next be cleared. Only read and written in the step effect and the cleanup.
    const freeAt = useRef(0);

    // Cleared on unmount and on a thread change.
    useEffect(() => {
        const pending = timers.current;

        return () => {
            cancelAll(pending);
            freeAt.current = 0;
        };
    }, [threadId]);

    useEffect(() => {
        const pending = timers.current;

        if (!step) {
            // No step to say (the reply ended): nothing still waiting to speak may follow, and the label
            // already said is cleared so it is not left in the region.
            cancelAll(pending);
            freeAt.current = 0;
            scheduleTimer(pending, 0, () => {
                setSpoken((current) => {
                    return { ...current, text: "" };
                });
            });

            return;
        }

        const { label, threadId: stepThreadId } = step;
        const clearAt = Math.max(Date.now(), freeAt.current);
        const setAt = clearAt + SET_DELAY_MS;

        freeAt.current = setAt + HOLD_MS;
        scheduleTimer(pending, clearAt - Date.now(), () => {
            setSpoken({ text: "", threadId: stepThreadId });
        });
        scheduleTimer(pending, setAt - Date.now(), () => {
            setSpoken({ text: label, threadId: stepThreadId });
        });
    }, [step]);

    // A label said in another thread is dropped as soon as the thread changes, so coming back to that
    // thread can never bring it back. Adjusted while rendering, like the step state in the caller.
    if (spoken.threadId !== threadId) {
        setSpoken({ text: "", threadId });
    }

    return spoken.threadId === threadId ? spoken.text : "";
};
