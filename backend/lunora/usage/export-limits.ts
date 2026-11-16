/**
 * The limits of a usage export, and the totals a recount compares. Pure constants and types with no imports, so the export workflow and
 * its steps can use them without loading the rollup's Lunora functions, which the mobile and extension type checks cannot resolve.
 */
/**
 * Rollup rows one export page reads and persists: about 135 KB of exported JSON. Below 1,000 so one page's writes (a row per distinct
 * project, the two pieces, and the run's row) stay under a mutation's write limit.
 */
export const USAGE_EXPORT_PAGE = 900;

/** Rollup rows one recount reads. A count keeps nothing, so it reads more at a time. */
export const USAGE_COUNT_PAGE = 2000;

/**
 * Projects one title read takes, four at a time. A project document holds at most 2 MiB (`projects/export-pages.ts`), so a
 * read is at most 8 MiB of documents, well under the 32 MiB a single read may use.
 */
export const USAGE_TITLE_STEP = 4;

/**
 * The most exported usage JSON one export keeps. The usage action reads it back from its own budget, so usage gets a fixed
 * share of the file; past the share the export fails, and says the usage history is too large.
 */
export const USAGE_EXPORT_BYTES = 8 * 1024 * 1024;

/**
 * Passes over the rollup in one attempt. Each pass uses its own step names, so a pass redone after a change reads the rollup
 * again instead of replaying a count the workflow already has.
 */
export const USAGE_EXPORT_PASSES = 6;

/**
 * Attempts at the export. An attempt whose passes all changed under it is followed by a durable pause (`step.sleep`), so a
 * backfill that is still writing can finish, and then a new attempt with fresh step names. Past the last attempt the export
 * fails with a clear error.
 */
export const USAGE_EXPORT_ATTEMPTS = 3;

/**
 * Project document bytes one title step reads, measured as their JSON. A step reads projects four at a time and stops once this
 * is reached, so a step's reads stay bounded whatever the projects' sizes; the number of steps follows the total size, not the
 * number of projects. A step reads at most this plus one batch, plus the rows pieces it lists the projects from.
 */
export const TITLE_STEP_BYTES = 8 * 1024 * 1024;

/**
 * Serialized title bytes one title step writes into its piece. A title is at most 10,000 characters, so a step of up to a thousand projects
 * could pass a stored document's 2 MB limit; the step stops adding projects once this is reached, and the next step starts there.
 */
export const TITLE_PIECE_BYTES = 1024 * 1024;

/**
 * What one id a title step asks for counts against its budget, whether or not its project is still there. A deleted project reads
 * no document, so without this its ids would cost nothing, and one step would work through all of them.
 */
export const TITLE_ID_BYTES = 4 * 1024;

/**
 * The position step between two rows pages' projects: a title step's position is its rows page times this, plus its offset among that
 * page's projects. A page holds at most `USAGE_EXPORT_PAGE` rows, so its offsets stay below it.
 */
export const PROJECT_POSITION = 1_000_000;

/** The totals of the rows dated before a cutoff: what a recount must match, and what a page reports for its own rows. */
export interface ClosedTotals {
    cost: number;
    replies: number;
    rows: number;
    tokens: number;
}
