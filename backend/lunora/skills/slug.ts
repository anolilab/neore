import { LunoraError } from "lunorash/server";

import { findFreeSlug } from "./slug-pick";

/** The first of `slug`, `slug-2`, `slug-3`, … that is not in `taken`. */
export const pickFreeSlug = (slug: string, taken: ReadonlySet<string>): string => {
    const free = findFreeSlug(slug, taken);

    if (free === undefined) {
        throw new LunoraError("CONFLICT", `A skill with slug '${slug}' already exists`);
    }

    return free;
};
