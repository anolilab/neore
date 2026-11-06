/**
 * The usage page's organization view: replies, tokens and cost per project of
 * the caller's active organization, summed over its members — for the
 * organization's admins and owners only.
 *
 * Each member's usage lives in the rollup on their own shard (`activity.ts`),
 * so the action reads the organization's projects and one page of its members,
 * asks each of those members' shards for its rows of those projects, and adds
 * them up. One call asks at most {@link MEMBERS_PER_CALL} shards — each is a
 * subrequest, and a Worker invocation has few — and returns `nextCursor`; the
 * client sums the pages. At most {@link MAX_PROJECTS} projects, with `truncated`
 * set when the organization has more.
 */
import { v } from "lunorash/server";

import { internal } from "../_generated/internal";
import { internalQuery } from "../_generated/server";
import { getMemberByOrganizationAndUser } from "../auth/lib/better-auth-queries";
import { callOnShard } from "../lib/cross-shard";
import { authAction, rateLimit } from "../lib/crpc";
import { throwForbidden } from "../lib/error-helpers";
import { systemDb } from "../lib/rls/scope";
import { MAX_LENGTH } from "../lib/validators";
import { foldProjectTotals, isDayKey, PROJECT_ROW_LIMIT, PROJECT_SKILL_KEY } from "./activity-logic";

/** Member shards one call asks, at most: well inside a Worker invocation's subrequest budget. */
export const MEMBERS_PER_CALL = 25;

/** Projects one read lists, at most. */
export const MAX_PROJECTS = 200;

/** Member shards asked at once. */
const SHARD_CONCURRENCY = 8;

const ADMIN_ROLES = new Set(["admin", "owner"]);

/** Whether a member's role grants the view; better-auth keeps several roles in one comma-separated string. */
export const isOrganizationAdminRole = (role: string): boolean => role.split(",").some((part) => ADMIN_ROLES.has(part.trim()));

const vTotals = { costMicrodollars: v.number(), replies: v.number(), tokens: v.number() };

/** The organization's projects and members, or `null` when `userId` is not one of its admins. */
export const organizationUsageScope = internalQuery
    .input({
        afterUserId: v.optional(v.string().max(MAX_LENGTH.id)),
        organizationId: v.string().max(MAX_LENGTH.id),
        userId: v.string().max(MAX_LENGTH.id),
    })
    .output(
        v.union(
            v.null(),
            v.object({
                memberIds: v.array(v.string()),
                nextCursor: v.optional(v.string()),
                projects: v.array(v.object({ projectId: v.string(), title: v.string() })),
                truncated: v.boolean(),
            }),
        ),
    )
    .query(async ({ args: { afterUserId, organizationId, userId }, ctx }) => {
        const member = await getMemberByOrganizationAndUser(ctx, organizationId, userId);

        if (!member || !isOrganizationAdminRole(member.role)) {
            return null;
        }

        // Paged by user id, a key no membership change moves, so a member who joins mid-way is not counted twice.
        const [members, projects] = await Promise.all([
            ctx.db.member.findMany({
                limit: MEMBERS_PER_CALL + 1,
                orderBy: [{ userId: "asc" }],
                where: { organizationId, ...(afterUserId !== undefined && { userId: { gt: afterUserId } }) },
            }),
            systemDb(ctx).projects.findMany({ limit: MAX_PROJECTS + 1, where: { organizationId } }),
        ]);
        const memberIds = members.page.slice(0, MEMBERS_PER_CALL).map((row) => row.userId);

        return {
            memberIds,
            ...(members.page.length > MEMBERS_PER_CALL && { nextCursor: memberIds.at(-1) }),
            projects: projects.page.slice(0, MAX_PROJECTS).map((row) => {
                return { projectId: row._id as string, title: row.title };
            }),
            truncated: projects.page.length > MAX_PROJECTS,
        };
    });

/** One member's totals per project, for the projects named, from `fromDate` on; runs on the member's shard. */
export const memberProjectUsage = internalQuery
    .input({ fromDate: v.string().max(10), projectIds: v.array(v.string().max(MAX_LENGTH.id)), userId: v.string().max(MAX_LENGTH.id) })
    .output(v.object({ projects: v.array(v.object({ ...vTotals, projectKey: v.string() })), truncated: v.boolean() }))
    .query(async ({ args: { fromDate, projectIds, userId }, ctx }) => {
        if (!isDayKey(fromDate) || projectIds.length === 0) {
            return { projects: [], truncated: false };
        }

        const wanted = new Set(projectIds);
        const { page } = await ctx.db.usageDaily.findMany({
            limit: PROJECT_ROW_LIMIT,
            orderBy: [{ date: "desc" }],
            where: { date: { gte: fromDate }, skillKey: PROJECT_SKILL_KEY, userId },
        });

        return {
            projects: foldProjectTotals(page).filter((project) => wanted.has(project.projectKey)),
            truncated: page.length >= PROJECT_ROW_LIMIT,
        };
    });

/** `items` mapped `limit` at a time. */
const mapLimited = async <T, R>(items: ReadonlyArray<T>, limit: number, map: (item: T) => Promise<R>): Promise<R[]> => {
    const results: R[] = [];

    for (let index = 0; index < items.length; index += limit) {
        results.push(...(await Promise.all(items.slice(index, index + limit).map(async (item) => await map(item)))));
    }

    return results;
};

/**
 * Replies, tokens and cost per project of the caller's active organization from
 * `fromDate` on, summed over one page of its members (from `afterUserId`).
 * Admins and owners only; projects with no usage are listed with zeros. Call
 * again with `nextCursor` until it is absent, and add the pages up.
 */
export const getOrganizationProjectUsage = authAction
    .use(rateLimit("library/read"))
    .input({ afterUserId: v.optional(v.string().max(MAX_LENGTH.id)), fromDate: v.string().max(10) })
    .output(
        v.object({
            members: v.number(),
            nextCursor: v.optional(v.string()),
            projects: v.array(v.object({ ...vTotals, projectKey: v.string(), title: v.string() })),
            truncated: v.boolean(),
        }),
    )
    .action(async ({ args: { afterUserId, fromDate }, ctx }) => {
        const organizationId = ctx.user.activeOrganization?.id;

        if (!organizationId || !isDayKey(fromDate)) {
            return throwForbidden("Only organization admins can see the organization's usage.");
        }

        const scope = await ctx.runQuery(internal.usage.organization.organizationUsageScope, {
            organizationId,
            userId: ctx.user.userId,
            ...(afterUserId !== undefined && { afterUserId }),
        });

        if (!scope) {
            return throwForbidden("Only organization admins can see the organization's usage.");
        }

        const projectIds = scope.projects.map((project) => project.projectId);
        const perMember = await mapLimited(scope.memberIds, SHARD_CONCURRENCY, async (userId) =>
            projectIds.length === 0
                ? { projects: [], truncated: false }
                : await callOnShard(internal.usage.organization.memberProjectUsage, { fromDate, projectIds, userId }, { shardKey: userId }),
        );
        const sums = new Map(
            scope.projects.map((project) => [
                project.projectId,
                { costMicrodollars: 0, projectKey: project.projectId, replies: 0, title: project.title, tokens: 0 },
            ]),
        );

        for (const member of perMember) {
            for (const project of member.projects) {
                const sum = sums.get(project.projectKey);

                if (sum) {
                    sum.costMicrodollars += project.costMicrodollars;
                    sum.replies += project.replies;
                    sum.tokens += project.tokens;
                }
            }
        }

        ctx.log.event("usage.get_organization_project_usage", { members: scope.memberIds.length, projects: projectIds.length });

        return {
            members: scope.memberIds.length,
            ...(scope.nextCursor !== undefined && { nextCursor: scope.nextCursor }),
            projects: [...sums.values()].toSorted((a, b) => b.costMicrodollars - a.costMicrodollars || b.replies - a.replies || a.title.localeCompare(b.title)),
            truncated: scope.truncated || perMember.some((member) => member.truncated),
        };
    });
