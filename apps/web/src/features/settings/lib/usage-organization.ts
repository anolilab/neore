/**
 * The usage page's organization view reads its members a page at a time
 * (`usage_organization.getOrganizationProjectUsage`): each call sums one page of
 * members' shards. This adds the pages up. Pinned by `usage-organization.test.ts`.
 */

export interface OrganizationProjectTotal {
    costMicrodollars: number;
    projectKey: string;
    replies: number;
    title: string;
    tokens: number;
}

/** The replies of projects the organization no longer has, in one total: no project is named. */
export interface OrganizationRemovedTotal {
    costMicrodollars: number;
    replies: number;
    tokens: number;
}

export interface OrganizationUsagePage {
    nextCursor?: string;
    projects: OrganizationProjectTotal[];
    removed?: OrganizationRemovedTotal;
    /** The projects too few members of the view name, folded into one total: no project is named. */
    small?: OrganizationRemovedTotal;
    truncated: boolean;
}

/** Pages read at most: past it the result says `truncated`. */
export const MAX_ORGANIZATION_PAGES = 40;

/** Every page from the first, summed per project, costliest first. */
export const sumOrganizationUsage = async (fetchPage: (cursor: string | undefined) => Promise<OrganizationUsagePage>): Promise<OrganizationUsagePage> => {
    const sums = new Map<string, OrganizationProjectTotal>();
    const removed: OrganizationRemovedTotal = { costMicrodollars: 0, replies: 0, tokens: 0 };
    const small: OrganizationRemovedTotal = { costMicrodollars: 0, replies: 0, tokens: 0 };
    let truncated = false;
    let cursor: string | undefined;

    for (let page = 0; page < MAX_ORGANIZATION_PAGES; page += 1) {
        const result = await fetchPage(cursor);

        truncated ||= result.truncated;

        for (const project of result.projects) {
            const sum = sums.get(project.projectKey) ?? { ...project, costMicrodollars: 0, replies: 0, tokens: 0 };

            sum.costMicrodollars += project.costMicrodollars;
            sum.replies += project.replies;
            sum.tokens += project.tokens;
            sums.set(project.projectKey, sum);
        }

        if (result.removed) {
            removed.costMicrodollars += result.removed.costMicrodollars;
            removed.replies += result.removed.replies;
            removed.tokens += result.removed.tokens;
        }

        if (result.small) {
            small.costMicrodollars += result.small.costMicrodollars;
            small.replies += result.small.replies;
            small.tokens += result.small.tokens;
        }

        cursor = result.nextCursor;

        if (cursor === undefined) {
            break;
        }
    }

    return {
        projects: [...sums.values()].toSorted((a, b) => b.costMicrodollars - a.costMicrodollars || b.replies - a.replies || a.title.localeCompare(b.title)),
        ...(small.replies > 0 && { small }),
        ...(removed.replies > 0 && { removed }),
        truncated: truncated || cursor !== undefined,
    };
};

/**
 * The organization view's period start for a calendar date: that date's midnight in UTC. The view counts whole UTC weeks from the Monday of
 * the date's week, so every viewer who picks the same date, whatever their zone, reads the same weeks.
 */
export const organizationSinceOf = (dayKey: string): number => {
    const [year, month, day] = dayKey.split("-").map(Number) as [number, number, number];

    return Date.UTC(year, month - 1, day);
};
