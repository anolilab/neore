import { useReducedMotion } from "motion/react";

import { usePlaying } from "./visual-playback";

/** Length of one loop of a use-case visual, in seconds. Every visual loops within this. */
const LOOP_SECONDS = 6;
/** Share of the loop a fade takes to rise (or fall). */
const FADE = 0.04;

const LOOP = { duration: LOOP_SECONDS, ease: "easeInOut", repeat: Infinity } as const;
const STILL = { duration: 0 } as const;

type Values = Record<string, (number | string)[]>;
type Rest = Record<string, number | string>;

/**
 * Keyframes for a looping visual. `times` are fractions of one loop, starting at 0 and ending at 1; `values` holds one
 * array per property, each as long as `times`. With reduced motion the loop stops and `rest` (the final state) shows.
 */
export const loop = (times: number[], values: Values, rest: Rest, reduce: boolean) => {
    return {
        animate: reduce ? rest : values,
        transition: reduce ? STILL : { ...LOOP, times },
    };
};

/** Opacity that rises at `from`, holds, and falls at `to`. `rest` is the opacity under reduced motion. */
export const fade = (from: number, to: number, reduce: boolean, rest = 1) =>
    loop([0, from, from + FADE, to, to + FADE, 1], { opacity: [0, 0, 1, 1, 0, 0] }, { opacity: rest }, reduce);

/**
 * Whether a visual holds still: the person asked for less motion, or the visual is off screen. Read once per render, so
 * the loop stops in place and rests on its final frame.
 */
export const useReduce = (): boolean => {
    const playing = usePlaying();

    return useReducedMotion() === true || !playing;
};
