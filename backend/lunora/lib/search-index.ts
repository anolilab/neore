import { LunoraError } from "lunorash/server";

/** Lunora's answer for a search index whose backfill has not yet covered the table (`SEARCH_INDEX_BUILDING`, 503). */
export const isSearchIndexBuilding = (error: unknown): boolean => error instanceof LunoraError && error.code === "SEARCH_INDEX_BUILDING";
