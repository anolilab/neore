import { getActivePersona } from "../session";

/**
 * The owner a fixture row gets unless a story names one. Rows are built when a story module loads, before its persona
 * is set, so they carry this marker and it resolves to the active persona's user when a response is produced.
 */
export const OWNER = "persona:owner";

/** The row with `userId` resolved to the active persona's user, as `sessionFor` names it (`user_${persona}`). Other rows pass through. */
export const ownedBy = <T extends { userId?: unknown }>(row: T): T => {
    return row.userId === OWNER ? { ...row, userId: `user_${getActivePersona()}` } : row;
};
