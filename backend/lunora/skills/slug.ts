import { LunoraError } from "lunorash/server";

/** `slug` without the hyphens a cut can leave at its end, so the suffix never follows one. */
const trimTrailingHyphens = (slug: string): string => {
    let end = slug.length;

    while (end > 0 && slug[end - 1] === "-") {
        end -= 1;
    }

    return slug.slice(0, end);
};

/** The first of `slug`, `slug-2`, `slug-3`, … that is not in `taken`. */
export const pickFreeSlug = (slug: string, taken: ReadonlySet<string>): string => {
    if (!taken.has(slug)) {
        return slug;
    }

    for (let suffix = 2; suffix < 100; suffix += 1) {
        const candidate = `${trimTrailingHyphens(slug.slice(0, 60))}-${String(suffix)}`;

        if (!taken.has(candidate)) {
            return candidate;
        }
    }

    throw new LunoraError("CONFLICT", `A skill with slug '${slug}' already exists`);
};
