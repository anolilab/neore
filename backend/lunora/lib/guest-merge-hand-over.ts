/** Tries of the progress record's write at a guest's hand-over ({@link handOverGuestMerge}). */
export const HAND_OVER_RECORD_TRIES = 2;

/**
 * A guest's merge handed over at its conversion (`auth.ts#onGuestConverted`): `record` writes its progress record
 * (`lib/account-merge.ts#recordGuestMerge`), tried again once, then `queue` sends its first job. The job goes even when the record could
 * not be written (its first lease writes the record too), but that failure is then thrown: the caller keeps what lets it
 * hand the merge over again (`auth/guest-conversion.ts` keeps its pending hand-over for the next sign-in, and a repeat is
 * safe: the record keeps its progress, the lease runs one delivery at a time). A merge is never left with neither a record
 * nor a failure someone sees.
 */
export const handOverGuestMerge = async (record: () => Promise<unknown>, queue: () => Promise<void>): Promise<void> => {
    let failure: { error: unknown } | null = null;

    for (let attempt = 1; attempt <= HAND_OVER_RECORD_TRIES; attempt += 1) {
        try {
            await record();
            failure = null;

            break;
        } catch (error) {
            failure = { error };
        }
    }

    await queue();

    if (failure !== null) {
        throw failure.error;
    }
};
