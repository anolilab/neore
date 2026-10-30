/**
 * A timestamp as epoch milliseconds. Our own writes store `Date.now()`, but rows better-auth writes (users, teams)
 * store an ISO string, and outputs that declare a number fail on them. An unreadable value reads as 0.
 */
export const toEpochMs = (value: unknown): number => {
    if (typeof value === "number") {
        return value;
    }

    const parsed = value instanceof Date ? value.getTime() : Date.parse(String(value));

    return Number.isNaN(parsed) ? 0 : parsed;
};
