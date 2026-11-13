/**
 * Every lucide icon, looked up by its kebab-case name ("arrow-up-0-1"). Load this
 * module only through `loadLucideIconMap` (`lucide-icon-by-name.tsx`): it holds all
 * icons in one chunk, so an icon chosen at runtime costs one request instead of a
 * chunk per icon, and nothing of it lands on the first load.
 */
import type { LucideIcon } from "lucide-react";
import * as lucide from "lucide-react";

const ICON_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;

/** The package exports, read by a name only known at runtime. */
const lucideExports: { readonly [exportName: string]: unknown } = lucide;

const toExportName = (name: string): string =>
    name
        .split("-")
        .map((part: string) => part.charAt(0).toUpperCase() + part.slice(1))
        .join("");

/**
 * The icon for a lucide name, or `undefined` for a name lucide does not have. Every
 * icon (aliases included) is also exported with an `Icon` suffix, which tells an icon
 * apart from the package's other exports (`Icon`, `createLucideIcon`, …).
 */
const getLucideIcon = (name: string): LucideIcon | undefined => {
    if (!ICON_NAME.test(name)) {
        return undefined;
    }

    const exportName = toExportName(name);
    const icon = lucideExports[exportName];

    return icon !== undefined && icon === lucideExports[`${exportName}Icon`] ? (icon as LucideIcon) : undefined;
};

export default getLucideIcon;
