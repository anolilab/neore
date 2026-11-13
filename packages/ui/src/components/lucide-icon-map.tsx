/**
 * Every lucide icon, looked up by its kebab-case name ("arrow-up-0-1"). Load this
 * module only through `loadLucideIconMap` (`lucide-icon-loader.tsx`): it holds all
 * icons in one chunk, so an icon chosen at runtime costs one request instead of a
 * chunk per icon, and nothing of it lands on the first load.
 */
import type { LucideIcon } from "lucide-react";
import * as lucide from "lucide-react";

/** What lucide knows about an icon: its name and its official aliases. */
interface LucideIconData {
    aliases?: ReadonlyArray<string | { name: string }>;
    name?: string;
}

/** The package exports, read by a name only known at runtime. */
const lucideExports: { readonly [exportName: string]: unknown } = lucide;

/**
 * An icon component's own data. The component renders lucide's `Icon` with it, so
 * calling its render function (no hooks, no DOM) hands it back without a lookup table.
 */
const iconDataOf = (icon: unknown): LucideIconData | undefined => {
    const { render } = icon as { render?: (props: object, ref: null) => { props?: { icon?: LucideIconData } } | null };

    return typeof render === "function" ? (render({}, null)?.props?.icon ?? undefined) : undefined;
};

/**
 * The icons by every name lucide gives them, and only those: an icon's name and its
 * aliases, exactly as lucide's own name list has them. A name that merely spells the
 * same component ("arrow-up01") is not one of them.
 */
const buildIconsByName = (): ReadonlyMap<string, LucideIcon> => {
    const byName = new Map<string, LucideIcon>();
    const seen = new Set<unknown>();

    for (const [exportName, value] of Object.entries(lucideExports)) {
        // Every icon (aliases included) is also exported with an `Icon` suffix, which tells an icon apart from the
        // package's other exports (`Icon`, `createLucideIcon`, …).
        if (value === undefined || seen.has(value) || lucideExports[`${exportName}Icon`] !== value) {
            continue;
        }

        seen.add(value);

        const data = iconDataOf(value);

        if (data?.name) {
            const aliases = data.aliases ?? [];

            byName.set(data.name, value as LucideIcon);

            for (const alias of aliases) {
                byName.set(typeof alias === "string" ? alias : alias.name, value as LucideIcon);
            }
        }
    }

    return byName;
};

const ICONS_BY_NAME = buildIconsByName();

/** The icon for a lucide name or alias, or `undefined` for any other string. */
const getLucideIcon = (name: string): LucideIcon | undefined => ICONS_BY_NAME.get(name);

export default getLucideIcon;
