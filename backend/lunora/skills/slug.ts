import { LunoraError } from "lunorash/server";

/** The first of `slug`, `slug-2`, `slug-3`, … that is not in `taken`. */
export const pickFreeSlug = (slug: string, taken: ReadonlySet<string>): string => {
    if (!taken.has(slug)) {
        return slug;
    }

    for (let suffix = 2; suffix < 100; suffix += 1) {
        const candidate = `${slug.slice(0, 60)}-${String(suffix)}`;

        if (!taken.has(candidate)) {
            return candidate;
        }
    }

    throw new LunoraError("CONFLICT", `A skill with slug '${slug}' already exists`);
};
