import type { InboxSection } from "@neore/backend/source-control/types";
import { INBOX_SECTIONS } from "@neore/backend/source-control/types";

export const DEVELOP_TABS = ["description", "commits", "files", "checks", "guide"] as const;

export type DevelopTab = (typeof DEVELOP_TABS)[number];

/** What the address of the page holds: which section of the inbox, and which pull request is open. */
export interface DevelopSearch {
    number?: number;
    repository?: string;
    section?: InboxSection;
    tab?: DevelopTab;
}

const REPOSITORY = /^[\w.-]{1,100}(?:\/[\w.-]{1,100}){1,6}$/u;
const isDotSegment = (segment: string): boolean => segment === "." || segment === "..";

const pick = <T extends string>(allowed: ReadonlyArray<T>, value: unknown): T | undefined => allowed.find((candidate) => candidate === value);

/** Reads the address leniently: a part that does not fit is dropped, never an error. */
export const validateDevelopSearch = (search: { number?: unknown; repository?: unknown; section?: unknown; tab?: unknown }): DevelopSearch => {
    const repo =
        typeof search.repository === "string" && REPOSITORY.test(search.repository) && search.repository.split("/").every((segment) => !isDotSegment(segment))
            ? search.repository
            : undefined;
    const number = Number(search.number);
    const hasRequest = repo !== undefined && Number.isSafeInteger(number) && number > 0;

    return {
        ...(hasRequest && { number, repository: repo }),
        ...(pick(INBOX_SECTIONS, search.section) !== undefined && { section: pick(INBOX_SECTIONS, search.section) }),
        ...(hasRequest && pick(DEVELOP_TABS, search.tab) !== undefined && { tab: pick(DEVELOP_TABS, search.tab) }),
    };
};
