import type { MergeMethod } from "@neore/backend/source-control/types";

/** The method to offer: the person's choice while the repository still allows it, else the first it allows. */
export const methodToUse = (allowed: ReadonlyArray<MergeMethod>, chosen: MergeMethod | null): MergeMethod | null => {
    if (chosen !== null && allowed.includes(chosen)) {
        return chosen;
    }

    return allowed[0] ?? null;
};
