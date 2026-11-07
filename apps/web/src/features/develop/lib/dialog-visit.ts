/**
 * Which visit of a dialog a request belongs to. Each open and each close starts a new visit; a request that settles
 * after its visit ended must not write its result into the next one.
 */
export interface DialogVisits {
    /** The visit a request starts in: hand it back to {@link DialogVisits.isCurrent} when it settles. */
    current: () => number;
    isCurrent: (visit: number) => boolean;
    /** The dialog opened or closed: whatever was in flight belongs to a visit that is over. */
    next: () => void;
}

export const createDialogVisits = (): DialogVisits => {
    let visit = 0;

    return {
        current: () => visit,
        isCurrent: (candidate) => candidate === visit,
        next: () => {
            visit += 1;
        },
    };
};
