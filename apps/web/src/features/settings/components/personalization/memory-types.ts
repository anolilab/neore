import { useLingui } from "@lingui/react/macro";
import { useMemo } from "react";

/** Mirrors `backend/lunora/memory/taxonomy.ts`. */
export const MEMORY_TYPES = ["identity", "preference", "context", "activity", "experience"] as const;

export type MemoryType = (typeof MEMORY_TYPES)[number];

export const MEMORY_TYPE_COLORS: Record<MemoryType, string> = {
    activity: "bg-gray-100 text-gray-800 dark:bg-gray-900 dark:text-gray-200",
    context: "bg-cyan-100 text-cyan-800 dark:bg-cyan-900 dark:text-cyan-200",
    experience: "bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-200",
    identity: "bg-purple-100 text-purple-800 dark:bg-purple-900 dark:text-purple-200",
    preference: "bg-blue-100 text-blue-800 dark:bg-blue-900 dark:text-blue-200",
};

export const isMemoryType = (value: unknown): value is MemoryType => typeof value === "string" && (MEMORY_TYPES as ReadonlyArray<string>).includes(value);

/** Translated label per memory type. */
export const useMemoryTypeLabels = (): Record<MemoryType, string> => {
    const { t } = useLingui();

    return useMemo(() => {
        return {
            activity: t`Activities`,
            context: t`Context`,
            experience: t`Experience`,
            identity: t`Identity`,
            preference: t`Preferences`,
        };
    }, [t]);
};
