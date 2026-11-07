/**
 * The usage page's organization view: replies, tokens and cost per project of
 * the caller's active organization, and the organization's total — for the
 * organization's admins and owners only.
 *
 * It reads `usageOrganizationReplies`, the organization's ledger: one row per
 * reply, filed when the reply is recorded (`activity.ts`), with its day,
 * spend, the member it belongs to, and its project when the organization owns
 * it. Rows are read by organization, never by membership, so a member who
 * leaves keeps counting; the view only ever sums them, so no member's spend is
 * shown on its own. A member's own project in an organization thread adds to
 * the total only, and counts under "No project" without its name. The view
 * lists only projects the organization owns now; past replies are never filed
 * under an organization (nothing records which one they ran in), so the totals
 * cover usage since organization reporting started.
 */
import { LunoraError, v } from "lunorash/server";

import { internal } from "../_generated/internal";
import { internalMutation, internalQuery } from "../_generated/server";
import { getMemberByOrganizationAndUser } from "../auth/lib/better-auth-queries";
import { usageDailyCutoffDate } from "../gdpr/retention";
import { authAction, rateLimit } from "../lib/crpc";
import { throwForbidden } from "../lib/error-helpers";
import { systemDb } from "../lib/rls/scope";
import { MAX_LENGTH } from "../lib/validators";
import { isDayKey, remainderOf, sumRows } from "./activity-logic";

/** Project titles one lookup reads. */
const TITLE_BATCH = 50;

/** Projects listed with no usage yet, at most. */
export const MAX_PROJECTS = 200;

/** Organization rows one retention sweep deletes. */
const RETENTION_BATCH = 500;

const ADMIN_ROLES = new Set(["admin", "owner"]);

const FORBIDDEN = "Only organization admins can see the organization's usage.";

/** Whether a member's role grants the view; better-auth keeps several roles in one comma-separated string. */
export const isOrganizationAdminRole = (role: string): boolean => role.split(",").some((part) => ADMIN_ROLES.has(part.trim()));

const vTotals = { costMicrodollars: v.number(), replies: v.number(), tokens: v.number() };

const vTitled = v.object({ projectId: v.string(), title: v.string() });

/** Whether `userId` is an admin or owner of the organization, read from their `member` row. */
export const isOrganizationAdmin = internalQuery
    .input({ organizationId: v.string().max(MAX_LENGTH.id), userId: v.string().max(MAX_LENGTH.id) })
    .output(v.boolean())
    .query(async ({ args: { organizationId, userId }, ctx }) => {
        const member = await getMemberByOrganizationAndUser(ctx, organizationId, userId);

        return member !== null && isOrganizationAdminRole(member.role);
    });

/**
 * The organization's usage from `fromDate` on, summed by the database per project (`null`: no project the organization
 * owns). Three grouped reads over the ledger's `by_org_date` index; each answers with a row per project, however many
 * replies the period holds, so no read is ever cut short.
 */
export const organizationUsageSums = internalQuery
    .input({ fromDate: v.string().max(10), organizationId: v.string().max(MAX_LENGTH.id) })
    .output(v.array(v.object({ costMicrodollars: v.number(), projectKey: v.optional(v.string()), replies: v.number(), tokens: v.number() })))
    .query(async ({ args: { fromDate, organizationId }, ctx }) => {
        const where = { date: { gte: fromDate }, organizationId };
        const [costs, tokens, replies] = await Promise.all([
            ctx.db.usageOrganizationReplies.groupBy({ agg: { field: "costMicrodollars", op: "sum" }, by: ["projectKey"], where }),
            ctx.db.usageOrganizationReplies.groupBy({ agg: { field: "tokens", op: "sum" }, by: ["projectKey"], where }),
            ctx.db.usageOrganizationReplies.groupBy({ by: ["projectKey"], where }),
        ]);
        const keyOf = (entry: { key: { projectKey?: string | null } }): string => entry.key.projectKey ?? "";
        const valueIn = (entries: typeof costs, key: string): number => entries.find((entry) => keyOf(entry) === key)?.value ?? 0;

        return replies.map((entry) => {
            const key = keyOf(entry);

            return {
                costMicrodollars: valueIn(costs, key),
                replies: entry.value ?? 0,
                tokens: valueIn(tokens, key),
                ...(key !== "" && { projectKey: key }),
            };
        });
    });

/** Titles of the projects among `projectIds` the organization owns now, and its projects to list at zero. */
export const organizationProjectTitles = internalQuery
    .input({ organizationId: v.string().max(MAX_LENGTH.id), projectIds: v.array(v.string().max(MAX_LENGTH.id)) })
    .output(v.object({ moreUnused: v.boolean(), owned: v.array(vTitled), unused: v.array(vTitled) }))
    .query(async ({ args: { organizationId, projectIds }, ctx }) => {
        const found = await Promise.all(
            projectIds.slice(0, TITLE_BATCH).map(async (projectId) => await systemDb(ctx).projects.findFirst({ where: { _id: projectId as never } })),
        );
        const listed = await systemDb(ctx).projects.findMany({ limit: MAX_PROJECTS + 1, where: { organizationId } });

        return {
            // Past the bound, the projects with no usage are not listed: the result says it was cut.
            moreUnused: listed.page.length > MAX_PROJECTS,
            owned: found.flatMap((project) =>
                project && project.organizationId === organizationId ? [{ projectId: project._id as string, title: project.title }] : [],
            ),
            unused: listed.page.slice(0, MAX_PROJECTS).map((project) => {
                return { projectId: project._id as string, title: project.title };
            }),
        };
    });

/**
 * The caller's active organization's usage from `fromDate` on: its total, per
 * project it owns, and what no project accounts for. Admins and owners only.
 * `organizationId` is the organization the caller's page expects: a request
 * whose active organization has changed since (in another tab) is refused
 * rather than answered for the other one.
 */
export const getOrganizationProjectUsage = authAction
    .use(rateLimit("library/read"))
    .input({ fromDate: v.string().max(10), organizationId: v.optional(v.string().max(MAX_LENGTH.id)) })
    .output(
        v.object({
            result: v.object({
                noProject: v.object({ ...vTotals }),
                projects: v.array(v.object({ ...vTotals, projectKey: v.string(), title: v.string() })),
                // More of the organization's projects have no usage than the list shows; every project with usage is listed.
                projectsCut: v.boolean(),
                total: v.object({ ...vTotals }),
            }),
        }),
    )
    .action(async ({ args: { fromDate, organizationId: expected }, ctx }) => {
        // The organization comes from the session, never from the client; the client's id is only checked against it.
        const organizationId = ctx.user.activeOrganization?.id;

        if (!organizationId || !isDayKey(fromDate)) {
            return throwForbidden(FORBIDDEN);
        }

        if (expected !== undefined && expected !== organizationId) {
            throw new LunoraError("CONFLICT", "The active organization changed. Reload the usage page.");
        }

        if (!(await ctx.runQuery(internal.usage.organization.isOrganizationAdmin, { organizationId, userId: ctx.user.userId }))) {
            return throwForbidden(FORBIDDEN);
        }

        const sums = await ctx.runQuery(internal.usage.organization.organizationUsageSums, { fromDate, organizationId });
        const projects = sums.flatMap(({ projectKey, ...totals }) => (projectKey === undefined ? [] : [{ ...totals, projectKey }]));
        const total = sumRows(sums);
        const usage = new Map(projects.map((project) => [project.projectKey, project]));
        const titles = new Map<string, string>();
        const keys = [...usage.keys()];
        let projectsCut = false;

        // Listed: projects the organization owns now, looked up by id, and its projects with no usage yet, at zero.
        // Anything else — a project that has left the organization — stays in "No project", without its name or id.
        for (let index = 0; index < Math.max(keys.length, 1); index += TITLE_BATCH) {
            const { moreUnused, owned, unused } = await ctx.runQuery(internal.usage.organization.organizationProjectTitles, {
                organizationId,
                projectIds: keys.slice(index, index + TITLE_BATCH),
            });

            projectsCut ||= moreUnused;

            for (const project of [...owned, ...(index === 0 ? unused : [])]) {
                titles.set(project.projectId, project.title);
            }
        }

        const listed = [...titles].map(([projectKey, title]) => {
            const totals = usage.get(projectKey) ?? { costMicrodollars: 0, replies: 0, tokens: 0 };

            return { costMicrodollars: totals.costMicrodollars, projectKey, replies: totals.replies, title, tokens: totals.tokens };
        });

        ctx.log.event("usage.get_organization_project_usage", { projects: listed.length });

        return {
            result: {
                noProject: remainderOf(total, listed),
                projects: listed.toSorted((a, b) => b.costMicrodollars - a.costMicrodollars || b.replies - a.replies || a.title.localeCompare(b.title)),
                projectsCut,
                total,
            },
        };
    });

/**
 * Retention: organization rows dated before the usage rollup's cutoff (`gdpr/retention.ts`), a batch at a time; a full
 * batch schedules the next, so the sweep keeps up however many organizations there are.
 */
export const pruneOrganizationUsage = internalMutation
    .input({})
    .output(v.number())
    .mutation(async ({ ctx }) => {
        const { page } = await ctx.db.usageOrganizationReplies.findMany({
            limit: RETENTION_BATCH,
            orderBy: [{ date: "asc" }],
            where: { date: { lt: usageDailyCutoffDate(ctx.now) } },
        });

        for (const row of page) {
            await ctx.db.delete("usageOrganizationReplies", row._id);
        }

        if (page.length >= RETENTION_BATCH) {
            await ctx.scheduler.runAfter(0, internal.usage.organization.pruneOrganizationUsage, {});
        }

        return page.length;
    });
