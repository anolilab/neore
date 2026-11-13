import type { LucideIcon } from "lucide-react";

export type GetLucideIcon = (name: string) => LucideIcon | undefined;

const iconMap: { loaded?: GetLucideIcon; pending?: Promise<GetLucideIcon> } = {};

/** The icon map if it has already loaded, so a later mount can render at once. */
export const getLoadedLucideIconMap = (): GetLucideIcon | undefined => iconMap.loaded;

/**
 * Loads the map of every lucide icon (`lucide-icon-map.tsx`, one chunk, fetched
 * once). A failed load is forgotten, so the next caller tries again.
 */
export const loadLucideIconMap = (): Promise<GetLucideIcon> => {
    iconMap.pending ??= import("./lucide-icon-map")
        .then((module_: typeof import("./lucide-icon-map")) => {
            iconMap.loaded = module_.default;

            return module_.default;
        })
        .catch((error: unknown) => {
            iconMap.pending = undefined;

            throw error;
        });

    return iconMap.pending;
};
