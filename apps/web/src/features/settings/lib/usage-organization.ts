/**
 * The usage page's organization view reads its members a page at a time
 * (`usage_organization.getOrganizationProjectUsage`): each call returns an
 * opaque cursor to continue with, and the last one the organization's totals.
 * This follows the cursor. Pinned by `usage-organization.test.ts`.
 */

export interface UsageTotalsLike {
    costMicrodollars: number;
    replies: number;
    tokens: number;
}

export interface OrganizationUsage {
    complete: boolean;
    members: number;
    noProject: UsageTotalsLike;
    projects: (UsageTotalsLike & { projectKey: string; title?: string })[];
    total: UsageTotalsLike;
    truncated: boolean;
}

export interface OrganizationUsageStep {
    cursor?: string;
    result?: OrganizationUsage;
}

/** Calls read at most before giving up: 40 × the server's page of members. */
export const MAX_ORGANIZATION_PAGES = 40;

export class OrganizationUsageTooLargeError extends Error {}

/** Calls `fetchStep` with each cursor it hands back until it returns the organization's totals. */
export const readOrganizationUsage = async (fetchStep: (cursor: string | undefined) => Promise<OrganizationUsageStep>): Promise<OrganizationUsage> => {
    let cursor: string | undefined;

    for (let call = 0; call < MAX_ORGANIZATION_PAGES; call += 1) {
        const step = await fetchStep(cursor);

        if (step.result) {
            return step.result;
        }

        if (step.cursor === undefined) {
            break;
        }

        cursor = step.cursor;
    }

    throw new OrganizationUsageTooLargeError("The organization is too large to read its usage in one go.");
};
