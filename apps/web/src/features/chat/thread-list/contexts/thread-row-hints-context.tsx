import { createContext, use } from "react";

/**
 * What a row's second line needs besides its own thread: the titles of the user's projects and the model a new chat starts on.
 * The list answers both once; a row that asked its own query would add a subscription per row.
 */
export interface ThreadRowHints {
    /** Unset until the user's preferences have answered: no row names its model before then, so none flashes and goes. */
    defaultModel: string | undefined;
    projectTitles: ReadonlyMap<string, string>;
}

export const ThreadRowHintsContext = createContext<ThreadRowHints>({ defaultModel: undefined, projectTitles: new Map() });

/** The project whose section the row sits in, so the row does not repeat the name its section header already shows. */
export const GroupProjectContext = createContext<string | undefined>(undefined);

export const useThreadRowHints = (): ThreadRowHints => use(ThreadRowHintsContext);

export const useGroupProjectId = (): string | undefined => use(GroupProjectContext);
