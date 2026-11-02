/** `slug` without the hyphens a cut can leave at its end, so the suffix never follows one. */
const trimTrailingHyphens = (slug: string): string => {
    let end = slug.length;

    while (end > 0 && slug[end - 1] === "-") {
        end -= 1;
    }

    return slug.slice(0, end);
};

/** The first of `slug`, `slug-2`, `slug-3`, … that is not in `taken`, or `undefined` when all of them are. Pure, so the app can use it too. */
export const findFreeSlug = (slug: string, taken: ReadonlySet<string>): string | undefined => {
    if (!taken.has(slug)) {
        return slug;
    }

    for (let suffix = 2; suffix < 100; suffix += 1) {
        const candidate = `${trimTrailingHyphens(slug.slice(0, 60))}-${String(suffix)}`;

        if (!taken.has(candidate)) {
            return candidate;
        }
    }

    return undefined;
};

/** What the review and the import tell the user when a skill takes another slug than the file names. */
export const slugRenamedWarning = (wanted: string, slug: string): string =>
    `You already have a skill named "${wanted}"; this one will be imported as "${slug}".`;
