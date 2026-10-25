export type FilterOp = "contains" | "equals" | "exists" | "not_equals" | "not_exists" | "starts_with";

/** One payload filter as the form edits it; `value` is unused by `exists` / `not_exists`. */
export interface PayloadFilterRow {
    op: FilterOp;
    path: string;
    value: string;
}

/** Mirror the backend caps (`backend/lunora/triggers/filters.ts`), which are the ones enforced. */
export const MAX_FILTERS = 10;
export const MAX_FILTER_PATH_DEPTH = 8;
export const MAX_FILTER_PATH_LENGTH = 200;
export const MAX_FILTER_VALUE_LENGTH = 500;

/** Property names the backend refuses as a path segment. */
const FORBIDDEN_SEGMENTS = new Set(["__proto__", "constructor", "prototype"]);

export const opTakesValue = (op: FilterOp): boolean => op !== "exists" && op !== "not_exists";

export const isValidFilterPath = (path: string): boolean => {
    const segments = path.split(".");

    return (
        path.length > 0 &&
        path.length <= MAX_FILTER_PATH_LENGTH &&
        segments.length <= MAX_FILTER_PATH_DEPTH &&
        segments.every((segment) => segment.length > 0 && !FORBIDDEN_SEGMENTS.has(segment))
    );
};

/** A filter the backend would accept: a dotted path within the caps, and a value (possibly empty) where the op compares. */
export const isCompleteFilter = (filter: PayloadFilterRow): boolean =>
    isValidFilterPath(filter.path) && (!opTakesValue(filter.op) || filter.value.length <= MAX_FILTER_VALUE_LENGTH);

/** Only a webhook trigger shows and sends filters, so only its rows can block the form. */
export const hasIncompleteFilters = (type: string, filters: PayloadFilterRow[]): boolean =>
    type === "webhook" && filters.some((filter) => !isCompleteFilter(filter));

/** The filters to send: `value` only for the ops that use it. */
export const filtersToSend = (filters: PayloadFilterRow[]) =>
    filters.map((filter) => {
        return { op: filter.op, path: filter.path, ...(opTakesValue(filter.op) && { value: filter.value }) };
    });
