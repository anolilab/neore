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

export interface OrganizationUsagePage {
    members: number;
    nextCursor?: string;
    projects: OrganizationProjectTotal[];
    truncated: boolean;
}

/** Pages read at most: past it the result says `truncated`. */
export const MAX_ORGANIZATION_PAGES = 40;

/** Every page from the first, summed per project, costliest first. */
export const sumOrganizationUsage = async (fetchPage: (afterUserId: string | undefined) => Promise<OrganizationUsagePage>): Promise<OrganizationUsagePage> => {
    const sums = new Map<string, OrganizationProjectTotal>();
    let members = 0;
    let truncated = false;
    let cursor: string | undefined;

    for (let page = 0; page < MAX_ORGANIZATION_PAGES; page += 1) {
        const result = await fetchPage(cursor);

        members += result.members;
        truncated ||= result.truncated;

        for (const project of result.projects) {
            const sum = sums.get(project.projectKey) ?? { ...project, costMicrodollars: 0, replies: 0, tokens: 0 };

            sum.costMicrodollars += project.costMicrodollars;
            sum.replies += project.replies;
            sum.tokens += project.tokens;
            sums.set(project.projectKey, sum);
        }

        cursor = result.nextCursor;

        if (cursor === undefined) {
            break;
        }
    }

    return {
        members,
        projects: [...sums.values()].toSorted((a, b) => b.costMicrodollars - a.costMicrodollars || b.replies - a.replies || a.title.localeCompare(b.title)),
        truncated: truncated || cursor !== undefined,
    };
};
