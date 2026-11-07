/**
 * The usage page's organization view: replies, tokens and cost per project of
 * the caller's active organization, and the organization's total, summed over
 * every member — for the organization's admins and owners only.
 *
 * Each member's usage lives in the rollup on their own shard (`activity.ts`):
 * a reply in an organization's thread or project is filed under that
 * organization when it is recorded (an `__organization__` row), and a reply in
 * a project the organization owns is filed under that project with the
 * organization on the row. The view adds up exactly those rows — every member,
 * every project — and lists only projects the organization owns now; a
 * member's personal project, or one that left the organization, counts under
 * "No project" without its name. Past replies are never filed under an
 * organization (nothing records which one they ran in), so the totals cover
 * usage since organization reporting started.
 *
 * Totals only, never per member: one call asks at most
 * {@link MEMBERS_PER_CALL} shards (each a subrequest), and the running sums
 * between calls travel in an encrypted cursor bound to the organization, the
 * caller and the period. The client sees no partial sum and no page size, so
 * no choice of cursor narrows the view to one member.
 */
import { LunoraError, v } from "lunorash/server";

import { internal } from "../_generated/internal";
import { internalQuery } from "../_generated/server";
import { getMemberByOrganizationAndUser } from "../auth/lib/better-auth-queries";
import { callOnShard } from "../lib/cross-shard";
import { authAction, rateLimit } from "../lib/crpc";
import { decryptKey, encryptKey } from "../lib/encryption";
import { throwForbidden } from "../lib/error-helpers";
import { systemDb } from "../lib/rls/scope";
import { MAX_LENGTH } from "../lib/validators";
import type { UsageTotals } from "./activity-logic";
import { addProjectTotals, foldOrganizationRows, isDayKey, remainderOf } from "./activity-logic";

/** Member shards one call asks, at most: well inside a Worker invocation's subrequest budget. */
export const MEMBERS_PER_CALL = 20;

/** Projects listed by name, at most; a project past it still counts, under its id. */
export const MAX_PROJECTS = 200;

/** One member's rows of one organization one read takes: a project row per day and project, plus one per day. */
export const MEMBER_ROW_LIMIT = 20_000;

/** Project titles one lookup reads. */
const TITLE_BATCH = 50;

/** How long a cursor stays usable. */
const CURSOR_TTL_MS = 10 * 60 * 1000;

/** Member shards asked at once. */
const SHARD_CONCURRENCY = 5;

const ADMIN_ROLES = new Set(["admin", "owner"]);

/** Whether a member's role grants the view; better-auth keeps several roles in one comma-separated string. */
export const isOrganizationAdminRole = (role: string): boolean => role.split(",").some((part) => ADMIN_ROLES.has(part.trim()));

const vTotals = { costMicrodollars: v.number(), replies: v.number(), tokens: v.number() };

/** The organization's projects and one page of its members, or `null` when `userId` is not one of its admins. */
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
            systemDb(ctx).projects.findMany({ limit: MAX_PROJECTS, where: { organizationId } }),
        ]);
        const memberIds = members.page.slice(0, MEMBERS_PER_CALL).map((row) => row.userId);

        return {
            memberIds,
            ...(members.page.length > MEMBERS_PER_CALL && { nextCursor: memberIds.at(-1) }),
            projects: projects.page.map((row) => {
                return { projectId: row._id as string, title: row.title };
            }),
        };
    });

/** One member's usage filed under the organization from `fromDate` on, read on the member's shard. */
export const memberOrganizationUsage = internalQuery
    .input({ fromDate: v.string().max(10), organizationId: v.string().max(MAX_LENGTH.id), userId: v.string().max(MAX_LENGTH.id) })
    .output(
        v.object({
            projects: v.array(v.object({ ...vTotals, projectKey: v.string() })),
            total: v.object({ ...vTotals }),
            truncated: v.boolean(),
        }),
    )
    .query(async ({ args: { fromDate, organizationId, userId }, ctx }) => {
        if (!isDayKey(fromDate)) {
            return { projects: [], total: { costMicrodollars: 0, replies: 0, tokens: 0 }, truncated: false };
        }

        // Only rows filed under this organization: the id comes from the caller's session, never from the client.
        const { page } = await ctx.db.usageDaily.findMany({
            limit: MEMBER_ROW_LIMIT,
            orderBy: [{ date: "desc" }],
            where: { date: { gte: fromDate }, organizationId, userId },
        });

        return { ...foldOrganizationRows(page, organizationId), truncated: page.length >= MEMBER_ROW_LIMIT };
    });

/** Titles of the projects among `projectIds` the organization owns now; any other id is left out. */
export const organizationProjectTitles = internalQuery
    .input({ organizationId: v.string().max(MAX_LENGTH.id), projectIds: v.array(v.string().max(MAX_LENGTH.id)) })
    .output(v.array(v.object({ projectId: v.string(), title: v.string() })))
    .query(async ({ args: { organizationId, projectIds }, ctx }) => {
        const found = await Promise.all(
            projectIds.slice(0, TITLE_BATCH).map(async (projectId) => await systemDb(ctx).projects.findFirst({ where: { _id: projectId as never } })),
        );

        return found.flatMap((project) =>
            project && project.organizationId === organizationId ? [{ projectId: project._id as string, title: project.title }] : [],
        );
    });

/** The running sums between calls; only ever handed to the client encrypted. */
interface CursorState {
    afterUserId: string;
    expiresAt: number;
    fromDate: string;
    members: number;
    organizationId: string;
    projects: [string, UsageTotals][];
    requesterId: string;
    total: UsageTotals;
    truncated: boolean;
}

const CURSOR_REFUSED = "That usage read cannot be continued. Start it again.";

const sealCursor = async (state: CursorState): Promise<string> => await encryptKey(JSON.stringify(state), "usage-cursors");

/** The state a cursor carries, when it was issued for this organization, caller and period and has not expired. */
export const openCursor = async (
    cursor: string,
    expected: { fromDate: string; now: number; organizationId: string; requesterId: string },
): Promise<CursorState> => {
    let state: CursorState;

    try {
        state = JSON.parse(await decryptKey(cursor, "usage-cursors")) as CursorState;
    } catch {
        throw new LunoraError("BAD_REQUEST", CURSOR_REFUSED);
    }

    const matches =
        state.organizationId === expected.organizationId &&
        state.requesterId === expected.requesterId &&
        state.fromDate === expected.fromDate &&
        state.expiresAt >= expected.now;

    if (!matches) {
        throw new LunoraError("BAD_REQUEST", CURSOR_REFUSED);
    }

    return state;
};

/** `items` mapped `limit` at a time. */
const mapLimited = async <T, R>(items: ReadonlyArray<T>, limit: number, map: (item: T) => Promise<R>): Promise<R[]> => {
    const results: R[] = [];

    for (let index = 0; index < items.length; index += limit) {
        results.push(...(await Promise.all(items.slice(index, index + limit).map(async (item) => await map(item)))));
    }

    return results;
};

const vResult = v.object({
    members: v.number(),
    noProject: v.object({ ...vTotals }),
    projects: v.array(v.object({ ...vTotals, projectKey: v.string(), title: v.string() })),
    total: v.object({ ...vTotals }),
    truncated: v.boolean(),
});

/**
 * The caller's active organization's usage from `fromDate` on: its total, per
 * project, and what no project accounts for. Admins and owners only. Returns
 * either `cursor` — call again with it — or, on the last call, `result`.
 */
export const getOrganizationProjectUsage = authAction
    .use(rateLimit("library/read"))
    .input({ cursor: v.optional(v.string().max(MAX_LENGTH.document)), fromDate: v.string().max(10) })
    .output(v.object({ cursor: v.optional(v.string()), result: v.optional(vResult) }))
    .action(async ({ args: { cursor, fromDate }, ctx }) => {
        const organizationId = ctx.user.activeOrganization?.id;

        if (!organizationId || !isDayKey(fromDate)) {
            return throwForbidden("Only organization admins can see the organization's usage.");
        }

        const requesterId = ctx.user.userId;

        const now = Date.now();

        const state: CursorState = cursor
            ? await openCursor(cursor, { fromDate, now, organizationId, requesterId })
            : {
                  afterUserId: "",
                  expiresAt: now + CURSOR_TTL_MS,
                  fromDate,
                  members: 0,
                  organizationId,
                  projects: [],
                  requesterId,
                  total: { costMicrodollars: 0, replies: 0, tokens: 0 },
                  truncated: false,
              };
        // The role is checked on every call, so a cursor outlives no demotion.
        const scope = await ctx.runQuery(internal.usage.organization.organizationUsageScope, {
            organizationId,
            userId: requesterId,
            ...(state.afterUserId !== "" && { afterUserId: state.afterUserId }),
        });

        if (!scope) {
            return throwForbidden("Only organization admins can see the organization's usage.");
        }

        const perMember = await mapLimited(
            scope.memberIds,
            SHARD_CONCURRENCY,
            async (userId) =>
                await callOnShard(internal.usage.organization.memberOrganizationUsage, { fromDate, organizationId, userId }, { shardKey: userId }),
        );
        const projects = new Map(state.projects);
        const total = { ...state.total };

        for (const member of perMember) {
            addProjectTotals(projects, member.projects);
            total.costMicrodollars += member.total.costMicrodollars;
            total.replies += member.total.replies;
            total.tokens += member.total.tokens;
        }

        const next: CursorState = {
            ...state,
            afterUserId: scope.nextCursor ?? "",
            members: state.members + scope.memberIds.length,
            projects: [...projects],
            total,
            truncated: state.truncated || perMember.some((member) => member.truncated),
        };

        if (scope.nextCursor !== undefined) {
            return { cursor: await sealCursor(next) };
        }

        // Listed: projects the organization owns now, looked up by id (so none past the first page is mislabelled), and
        // its projects with no usage yet, at zero. Anything else — a member's personal project, one that left the
        // organization — stays in "No project", without its name or id.
        const titles = new Map(scope.projects.map((project) => [project.projectId, project.title]));
        const unknown = [...projects.keys()].filter((projectKey) => !titles.has(projectKey));

        for (let index = 0; index < unknown.length; index += TITLE_BATCH) {
            const owned = await ctx.runQuery(internal.usage.organization.organizationProjectTitles, {
                organizationId,
                projectIds: unknown.slice(index, index + TITLE_BATCH),
            });

            for (const project of owned) {
                titles.set(project.projectId, project.title);
            }
        }

        const rows = [...titles].map(([projectKey, title]) => {
            return { ...(projects.get(projectKey) ?? { costMicrodollars: 0, replies: 0, tokens: 0 }), projectKey, title };
        });

        ctx.log.event("usage.get_organization_project_usage", { members: next.members, projects: rows.length });

        return {
            result: {
                members: next.members,
                noProject: remainderOf(total, rows),
                projects: rows.toSorted((a, b) => b.costMicrodollars - a.costMicrodollars || b.replies - a.replies || a.projectKey.localeCompare(b.projectKey)),
                total,
                truncated: next.truncated,
            },
        };
    });
