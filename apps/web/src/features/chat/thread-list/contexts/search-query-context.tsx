import { createContext, use } from "react";

/**
 * The query whose results the sidebar shows. Only the message matches under a result read it (to cut their snippets): passed to
 * every row instead, each keystroke's answer would re-render all of them.
 */
export const SearchQueryContext = createContext("");

export const useShownSearchQuery = (): string => use(SearchQueryContext);
