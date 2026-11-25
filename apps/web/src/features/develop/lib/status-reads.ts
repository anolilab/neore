/** Linked pull requests whose state (checks, conflicts, reviews) a chat's view reads from the host: a few per view, so a long list costs no more. */
export const MAX_STATUS_READS = 5;

export interface StatusReadLink {
    number: number;
    repository: string;
    statusReadAt?: number;
}

/** The key of a linked pull request inside one list. */
export const linkKey = (link: { number: number; repository: string }): string => `${link.repository}#${link.number}`;

/**
 * The links a view reads, least recently read first (never read first), so the views of one chat reach every link in turn
 * instead of always the newest few. Ties keep the list's order.
 */
export const pickStatusReads = (links: ReadonlyArray<StatusReadLink>, max: number): ReadonlySet<string> => {
    const stalest = links.toSorted((left, right) => (left.statusReadAt ?? 0) - (right.statusReadAt ?? 0)).slice(0, max);

    return new Set(stalest.map((link) => linkKey(link)));
};
