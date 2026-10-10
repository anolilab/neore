import type { ThreadTagColor } from "./thread-tag-logic";

/**
 * Chip classes per palette key. Written out in full (not built from the key) so
 * Tailwind's scanner sees every class.
 */
export const THREAD_TAG_CHIP_CLASSES: Record<ThreadTagColor, string> = {
    amber: "bg-amber-500/15 text-amber-700 dark:bg-amber-500/25 dark:text-amber-300",
    blue: "bg-blue-500/15 text-blue-700 dark:bg-blue-500/25 dark:text-blue-300",
    gray: "bg-zinc-500/15 text-zinc-700 dark:bg-zinc-500/25 dark:text-zinc-300",
    green: "bg-green-500/15 text-green-700 dark:bg-green-500/25 dark:text-green-300",
    orange: "bg-orange-500/15 text-orange-700 dark:bg-orange-500/25 dark:text-orange-300",
    pink: "bg-pink-500/15 text-pink-700 dark:bg-pink-500/25 dark:text-pink-300",
    red: "bg-red-500/15 text-red-700 dark:bg-red-500/25 dark:text-red-300",
    teal: "bg-teal-500/15 text-teal-700 dark:bg-teal-500/25 dark:text-teal-300",
    violet: "bg-violet-500/15 text-violet-700 dark:bg-violet-500/25 dark:text-violet-300",
};

/** Solid swatch / dot classes per palette key. */
export const THREAD_TAG_DOT_CLASSES: Record<ThreadTagColor, string> = {
    amber: "bg-amber-500",
    blue: "bg-blue-500",
    gray: "bg-zinc-500",
    green: "bg-green-500",
    orange: "bg-orange-500",
    pink: "bg-pink-500",
    red: "bg-red-500",
    teal: "bg-teal-500",
    violet: "bg-violet-500",
};
