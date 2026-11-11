/**
 * How the export action (`steps.ts#generateExportFile`) shares one request's read budget between its sections. What a
 * section read is close to what it exports, so each later section gets what the earlier ones left.
 */

/** Lunora's read budget for one request, shared by every query an action runs (`maxReadBytes`). */
export const ACTION_READ_BYTES = 32 * 1024 * 1024;

/** Held back for the last page of a section and anything read after it. */
export const READ_MARGIN_BYTES = 8 * 1024 * 1024;

/**
 * The most reading the trigger history may cost. A run is read whole, its webhook body (up to 1 MiB) included, even
 * when the export cuts it; the history is cut oldest first to fit.
 */
export const TRIGGER_READ_BYTES = 12 * 1024 * 1024;

/**
 * What the coding-agent sessions may read. They are read first and cannot be cut short, so they keep the margin and the
 * floor below free for the sections after them: past this the export fails with PAYLOAD_TOO_LARGE, never reads past the budget.
 */
export const ACP_READ_BYTES = ACTION_READ_BYTES - READ_MARGIN_BYTES;

/** The least the project repositories may read, even when earlier sections used the rest of the budget. */
export const REPOSITORIES_READ_FLOOR_BYTES = 256 * 1024;

/**
 * What the project repositories may read after `used` bytes. They cannot be cut short, so a set larger than
 * this fails the export with PAYLOAD_TOO_LARGE rather than the whole request failing on the read budget.
 */
export const repositoriesReadBudget = (used: number): number => Math.max(REPOSITORIES_READ_FLOOR_BYTES, ACTION_READ_BYTES - used - READ_MARGIN_BYTES);

/**
 * What the repositories' project details may read after `used` bytes, the repository rows included. No floor: the
 * details can be left out (each marked as such), so they never read past the action's budget.
 */
export const projectDetailsReadBudget = (used: number): number => Math.max(0, ACTION_READ_BYTES - used - READ_MARGIN_BYTES);

/** What the trigger history may read after every other section read `used` bytes; 0 leaves it all out, marked as cut. */
export const triggerReadBudget = (used: number): number => Math.max(0, Math.min(TRIGGER_READ_BYTES, ACTION_READ_BYTES - used - READ_MARGIN_BYTES));
