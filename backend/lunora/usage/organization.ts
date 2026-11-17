/**
 * The usage page's organization view: replies, tokens and cost per project of
 * the caller's active organization, summed over its members — for the
 * organization's admins and owners only.
 *
 * Each member's usage lives in the rollup on their own shard (`activity.ts`),
 * so the action reads the organization's projects and one page of its members,
 * asks each of those members' shards for its rows of those projects, and adds
 * them up. One call asks at most {@link MAX_MEMBERS_PER_CALL} shards — each is a
 * subrequest, and a Worker invocation has few — and returns `nextCursor`; the
 * client sums the pages. At most {@link MAX_PROJECTS} projects, with `truncated`
 * set when the organization has more.
 */
import { v } from "lunorash/server";

import { internal } from "../_generated/internal";
import { internalMutation, internalQuery, type QueryCtx } from "../_generated/server";
import { getMemberByOrganizationAndUser } from "../auth/lib/better-auth-queries";
import { callOnShard } from "../lib/cross-shard";
import { decryptKey, encryptKey } from "../lib/encryption";
import { authAction, rateLimit } from "../lib/crpc";
import { throwForbidden } from "../lib/error-helpers";
import { systemDb } from "../lib/rls/scope";
import { MAX_LENGTH } from "../lib/validators";
import { COHORT_SIZE, insertContributor } from "./cohorts";

/** Members one call walks, at most, once the group it is in has closed: well inside a Worker invocation's subrequest budget. */
export const MAX_MEMBERS_PER_CALL = 25;

/** Member shard calls one walk makes, at most: with the scope reads, under a Free Worker's 50 subrequests. */
export const MAX_MEMBER_CALLS = 40;

/** Projects one read lists, at most. */
export const MAX_PROJECTS = 200;

/** Member shards asked at once. */
const SHARD_CONCURRENCY = 8;

/** Contributors one read of the walk takes. */
const SCOPE_BATCH = 10;

/**
 * The members in one group. A group is fixed by its place in the organization's member order, not by who was active in the period, so no
 * change of period start can swap the members a total covers. A group is shown only when no member of it was active, or all of them were.
 */
export const MIN_MEMBERS_PER_GROUP = COHORT_SIZE;

/**
 * Splits a walk's members into one group per cohort. The walk is in cohort order, so each cohort's members are contiguous and each group is
 * the cohort as the walk read it. A cohort's membership was fixed when its members were booked, so a group never changes between calls.
 */
export const groupByCohort = <Member extends { cohort: number }>(members: ReadonlyArray<Member>): Member[][] => {
    const groups: Member[][] = [];

    for (const member of members) {
        const last = groups.at(-1);

        if (last !== undefined && last[0]?.cohort === member.cohort) {
            last.push(member);
        } else {
            groups.push([member]);
        }
    }

    return groups;
};

/**
 * The walk's members without the cohort it stopped inside, when an earlier cohort exists; otherwise all of them, so a walk whose first cohort
 * is cut short still moves on. `members` is in cohort order, so the cohort it stopped in is a suffix.
 */
export const withoutLastCohort = <Member extends { cohort: number }>(members: ReadonlyArray<Member>): Member[] => {
    const last = members.at(-1)?.cohort;
    const earlier = members.filter((member) => member.cohort !== last);

    return earlier.length > 0 ? earlier : [...members];
};

/** Where a walk stands: the last member it has read, in cohort order. */
export interface WalkPosition {
    cohort: number;
    userId: string;
}

/**
 * Whether a full group's sums are released: not withheld (see {@link pageWithheld}), and no member read past the ledger's ceiling. A
 * truncated member is withheld with the group, so no response says which member had more rows than the read takes.
 */
export const groupReleased = (group: ReadonlyArray<{ active: boolean; truncated?: boolean }>): boolean =>
    !pageWithheld(group) && group.every((member) => member.truncated !== true);

/**
 * Whether a group's sums (or the trailing members') are withheld: some of its members were active in the period, but fewer than
 * {@link MIN_MEMBERS_PER_GROUP}. The sum of a few active members, with the rest quiet, is one person's spend. A group where nobody was
 * active shows nothing to hide.
 */
export const pageWithheld = (members: ReadonlyArray<{ active: boolean }>): boolean => {
    const active = members.filter((member) => member.active).length;

    return active > 0 && active < MIN_MEMBERS_PER_GROUP;
};

const ADMIN_ROLES = new Set(["admin", "owner"]);

/** Whether a member's role grants the view; better-auth keeps several roles in one comma-separated string. */
export const isOrganizationAdminRole = (role: string): boolean => role.split(",").some((part) => ADMIN_ROLES.has(part.trim()));

const vTotals = { costMicrodollars: v.number(), replies: v.number(), tokens: v.number() };

/**
 * One batch of an organization's contributors in walk order: by cohort, then user id, from the cursor's position on. The cursor's cohort is
 * read from its user id on, then the later cohorts, so a booking that lands between two batches is not read twice or skipped.
 */
const contributorBatch = async (ctx: QueryCtx, organizationId: string, after?: WalkPosition): Promise<{ cohort: number; userId: string }[]> => {
    const db = systemDb(ctx);
    const limit = SCOPE_BATCH + 1;
    const rows: { cohort: number; userId: string }[] = [];

    if (after !== undefined) {
        // From the primary: a replica that lags a new contributor's entry would drop that member's usage from the totals.
        const { page } = await db.usageOrganizationContributors.findMany({
            consistency: "primary",
            limit,
            orderBy: [{ userId: "asc" }],
            where: { cohort: after.cohort, organizationId, userId: { gt: after.userId } },
        });

        rows.push(
            ...page.map((row) => {
                return { cohort: row.cohort, userId: row.userId };
            }),
        );
    }

    if (rows.length < limit) {
        const { page } = await db.usageOrganizationContributors.findMany({
            consistency: "primary",
            limit: limit - rows.length,
            orderBy: [{ cohort: "asc" }, { userId: "asc" }],
            where: { organizationId, ...(after !== undefined && { cohort: { gt: after.cohort } }) },
        });

        rows.push(
            ...page.map((row) => {
                return { cohort: row.cohort, userId: row.userId };
            }),
        );
    }

    return rows;
};

/** The organization's projects and members, or `null` when `userId` is not one of its admins. */
export const organizationUsageScope = internalQuery
    .input({
        afterCohort: v.optional(v.number()),
        afterUserId: v.optional(v.string().max(MAX_LENGTH.id)),
        organizationId: v.string().max(MAX_LENGTH.id),
        userId: v.string().max(MAX_LENGTH.id),
        // Whether to read the project list: a walk reads it once, with its first batch, and every later batch of the call uses that list.
        withProjects: v.optional(v.boolean()),
    })
    .output(
        v.union(
            v.null(),
            v.object({
                // In walk order: by cohort, then user id.
                members: v.array(v.object({ cohort: v.number(), userId: v.string() })),
                // Whether contributors follow this batch.
                more: v.boolean(),
                projects: v.array(v.object({ projectId: v.string(), title: v.string() })),
                truncated: v.boolean(),
            }),
        ),
    )
    .query(async ({ args: { afterCohort, afterUserId, organizationId, userId, withProjects }, ctx }) => {
        // From the primary: a replica that still holds a revoked membership must not grant the view.
        const member = await getMemberByOrganizationAndUser(ctx, organizationId, userId, "primary");

        if (!member || !isOrganizationAdminRole(member.role)) {
            return null;
        }

        // Everyone with rows under the organization, current members and those who left, a batch at a time by user id: a key no change moves,
        // so someone added mid-way is not counted twice.
        const [contributors, projects] = await Promise.all([
            contributorBatch(
                ctx,
                organizationId,
                afterCohort !== undefined && afterUserId !== undefined ? { cohort: afterCohort, userId: afterUserId } : undefined,
            ),
            // From the primary: a project that just moved out must not still be listed, or its usage would show to the old organization's admins.
            withProjects === false
                ? undefined
                : systemDb(ctx).projects.findMany({ consistency: "primary", limit: MAX_PROJECTS + 1, where: { organizationId } }),
        ]);
        // Each member once: two entries for one member (a race while their first replies were recorded) must not count them twice.
        const seen = new Set<string>();
        const members = contributors.slice(0, SCOPE_BATCH).filter((row) => {
            if (seen.has(row.userId)) {
                return false;
            }

            seen.add(row.userId);

            return true;
        });
        const listed = projects?.page ?? [];

        return {
            members,
            more: contributors.length > SCOPE_BATCH,
            projects: listed.slice(0, MAX_PROJECTS).map((row) => {
                return { projectId: row._id as string, title: row.title };
            }),
            truncated: listed.length > MAX_PROJECTS,
        };
    });

/** Ledger rows one read takes, and reads at most: past them the result says `truncated`. */
const REPLY_PAGE = 500;
const MAX_REPLY_PAGES = 20;

/**
 * One member's replies per project, for the organization's projects named, from `since` (epoch ms) on; runs on the member's shard. It reads
 * the rows recorded under the organization (`usageOrganizationReplies`), so a reply keeps the organization it was recorded under: a project
 * moved in later has no rows for the replies made before it moved.
 */
export const memberProjectUsage = internalQuery
    .input({
        // Whether `projectIds` is every project the organization has. Cut at `MAX_PROJECTS`, a project that is not listed is not known to
        // have left, so its replies are not counted as removed.
        organizationId: v.string().max(MAX_LENGTH.id),
        projectIds: v.array(v.string().max(MAX_LENGTH.id)),
        projectsListed: v.boolean(),
        since: v.number(),
        userId: v.string().max(MAX_LENGTH.id),
    })
    .output(
        v.object({
            // Whether the member had any reply in the period: a page of members with few active ones is withheld (`pageWithheld`).
            active: v.boolean(),
            projects: v.array(v.object({ ...vTotals, projectKey: v.string() })),
            // The replies of projects the organization no longer has: their totals, without naming the projects, so a member's personal
            // project that left is not shown by name, while its usage keeps counting.
            removed: v.optional(v.object(vTotals)),
            truncated: v.boolean(),
        }),
    )
    .query(async ({ args: { organizationId, projectIds, projectsListed, since, userId }, ctx }) => {
        const wanted = new Set(projectIds);
        const sums = new Map<string, { costMicrodollars: number; projectKey: string; replies: number; tokens: number }>();
        const removed = { costMicrodollars: 0, replies: 0, tokens: 0 };
        let cursor: string | null = null;
        let truncated = false;
        let active = false;

        for (let pages = 1; ; pages += 1) {
            const result: { continueCursor: string | null; isDone: boolean; page: { costMicrodollars: number; projectKey: string; tokens: number }[] } =
                await ctx.db.usageOrganizationReplies.findMany({
                    consistency: "primary",
                    cursor,
                    limit: REPLY_PAGE,
                    where: { at: { gte: since }, organizationId, userId },
                });

            if (result.page.length > 0) {
                active = true;
            }

            for (const row of result.page) {
                if (!wanted.has(row.projectKey)) {
                    if (projectsListed) {
                        removed.costMicrodollars += row.costMicrodollars;
                        removed.replies += 1;
                        removed.tokens += row.tokens;
                    }

                    continue;
                }

                const sum = sums.get(row.projectKey) ?? { costMicrodollars: 0, projectKey: row.projectKey, replies: 0, tokens: 0 };

                sum.costMicrodollars += row.costMicrodollars;
                sum.replies += 1;
                sum.tokens += row.tokens;
                sums.set(row.projectKey, sum);
            }

            if (result.isDone) {
                break;
            }

            if (pages >= MAX_REPLY_PAGES) {
                truncated = true;
                break;
            }

            cursor = result.continueCursor;
        }

        return { active, projects: [...sums.values()], ...(removed.replies > 0 && { removed }), truncated };
    });

/** One member's usage as the walk reads it. */
interface MemberWalk {
    active: boolean;
    cohort: number;
    projects: { costMicrodollars: number; projectKey: string; replies: number; tokens: number }[];
    removed?: { costMicrodollars: number; replies: number; tokens: number };
    truncated: boolean;
    userId: string;
}

/**
 * Replies, tokens and cost per project of the caller's active organization from
 * `since` (epoch ms) on, summed over one page of its members (from `afterUserId`).
 * Admins and owners only; projects with no usage are listed with zeros. Call
 * again with `nextCursor` until it is absent, and add the pages up.
 */
/** How long a page cursor opens: the walk resumes within the hour, not at any time later against a changed contributor list. */
export const CURSOR_TTL_MS = 60 * 60 * 1000;

/**
 * A page cursor: the walk's position, sealed so a caller can only resume a walk the server issued. It is bound to the organization and the
 * period (`since`) it was issued for, and it expires after {@link CURSOR_TTL_MS}. A cursor the caller makes up, takes from another
 * organization or period, or keeps past its time, does not open.
 */
export const sealOrganizationCursor = async (organizationId: string, position: WalkPosition, since: number, issuedAt = Date.now()): Promise<string> =>
    await encryptKey(JSON.stringify({ cohort: position.cohort, issuedAt, organizationId, since, userId: position.userId }), "usage-cursor");

export const openOrganizationCursor = async (organizationId: string, since: number, cursor: string, now = Date.now()): Promise<WalkPosition> => {
    let opened: { cohort?: unknown; issuedAt?: unknown; organizationId?: unknown; since?: unknown; userId?: unknown } | undefined;

    try {
        opened = JSON.parse(await decryptKey(cursor, "usage-cursor")) as typeof opened;
    } catch {
        opened = undefined;
    }

    const fresh = typeof opened?.issuedAt === "number" && now - opened.issuedAt <= CURSOR_TTL_MS;

    if (
        !opened ||
        opened.organizationId !== organizationId ||
        opened.since !== since ||
        !fresh ||
        typeof opened.userId !== "string" ||
        typeof opened.cohort !== "number"
    ) {
        return throwForbidden("The usage page is not valid; load the organization's usage again.");
    }

    return { cohort: opened.cohort, userId: opened.userId };
};

export const getOrganizationProjectUsage = authAction
    .use(rateLimit("usage/organization"))
    .input({ cursor: v.optional(v.string().max(MAX_LENGTH.cursor)), organizationId: v.string().max(MAX_LENGTH.id), since: v.number() })
    .output(
        v.object({
            // Not the number of members walked: that would show where a group closed, and so how active the members after it were.
            nextCursor: v.optional(v.string()),
            projects: v.array(v.object({ ...vTotals, projectKey: v.string(), title: v.string() })),
            // The replies to projects the organization no longer has, in one total: no project named.
            removed: v.optional(v.object(vTotals)),
            // The projects with too few members in the view to be named, in one total (`MIN_MEMBERS_PER_GROUP` members across them to show).
            small: v.optional(v.object(vTotals)),
            truncated: v.boolean(),
        }),
    )
    .action(async ({ args: { cursor, organizationId, since }, ctx }) => {
        // A walk is bound to the organization that started it: a page asked under another active organization is refused, so pages
        // of two organizations are never added up together.
        if (ctx.user.activeOrganization?.id !== organizationId || !Number.isFinite(since)) {
            return throwForbidden("Only organization admins can see the organization's usage.");
        }

        // The walk resumes after the last member asked, in cohort order; it starts at the cursor's member, if there is one.
        let resume: WalkPosition | undefined = cursor === undefined ? undefined : await openOrganizationCursor(organizationId, since, cursor);
        const walked: MemberWalk[] = [];
        // The project list is read once, with the call's first batch: every member of the call is then summed against the same list.
        let projects: { projectId: string; title: string }[] | undefined;
        let projectsCut = false;
        let remaining = false;

        for (;;) {
            const scope = await ctx.runQuery(internal.usage.organization.organizationUsageScope, {
                organizationId,
                userId: ctx.user.userId,
                ...(resume !== undefined && { afterCohort: resume.cohort, afterUserId: resume.userId }),
                withProjects: projects === undefined,
            });

            if (!scope) {
                return throwForbidden("Only organization admins can see the organization's usage.");
            }

            if (projects === undefined) {
                projects = scope.projects;
                projectsCut = scope.truncated;
            }

            const projectIds = projects.map((project) => project.projectId);
            const batch = scope.members;
            let stopped = false;

            let index = 0;

            while (index < batch.length && !stopped) {
                // The member shards one walk asks, all of them: a Free Worker allows 50 subrequests, and the scope reads come on top. A chunk
                // stops at the call's member limit, so no member past it is read and then thrown away.
                const size = Math.min(SHARD_CONCURRENCY, MAX_MEMBER_CALLS - walked.length, MAX_MEMBERS_PER_CALL - walked.length);

                if (size <= 0) {
                    stopped = true;
                    break;
                }

                const chunk = batch.slice(index, index + size);

                index += size;
                // Asked even with no projects left: a member's replies to projects that left the organization still count, as `removed`.
                const results = await Promise.all(
                    chunk.map(
                        async ({ userId }) =>
                            await callOnShard(
                                internal.usage.organization.memberProjectUsage,
                                { organizationId, projectIds, projectsListed: !projectsCut, since, userId },
                                { shardKey: userId },
                            ),
                    ),
                );

                for (const [position, result] of results.entries()) {
                    const member = chunk[position];

                    if (member === undefined) {
                        break;
                    }

                    walked.push({ ...result, cohort: member.cohort, userId: member.userId });
                    resume = { cohort: member.cohort, userId: member.userId };

                    // The call stops once it has enough members; the cohort it stops in is cut back below unless the walk has passed it.
                    if (walked.length >= MAX_MEMBERS_PER_CALL) {
                        stopped = true;
                        break;
                    }
                }
            }

            if (stopped) {
                remaining = resume?.userId !== batch.at(-1)?.userId || scope.more;
                break;
            }

            if (!scope.more) {
                break;
            }
        }

        const listed = projects ?? [];

        // The walk stopped inside a cohort: that cohort is cut back to the cohort before it, and the next call walks it whole. A cohort is
        // released only once the walk has passed it or read every member. With no earlier cohort, the partial one stays (a booking race
        // can make a cohort very large, and the walk must still move on).
        if (remaining) {
            const kept = withoutLastCohort(walked).length;

            if (kept < walked.length) {
                walked.splice(kept);

                const tail = walked.at(-1);

                resume = tail === undefined ? undefined : { cohort: tail.cohort, userId: tail.userId };
            }
        }

        // A cohort is shown when none of its members was active or all were; a cohort with some active members is withheld whole, and so is one
        // smaller than a cohort (`pageWithheld`).
        const groups = groupByCohort(walked);
        const releasedGroups = groups.filter((group) => groupReleased(group));
        const groupsWithheld = releasedGroups.length < groups.length;
        const shown = releasedGroups.flat();
        const removed = { costMicrodollars: 0, replies: 0, tokens: 0 };
        const sums = new Map(
            listed.map((project) => [project.projectId, { costMicrodollars: 0, projectKey: project.projectId, replies: 0, title: project.title, tokens: 0 }]),
        );

        // A project is named only with at least `MIN_MEMBERS_PER_GROUP` members in it: one member's project is that member's spend. A project
        // below that is folded into one total, released only with that many members across it, so its usage still shows. The removed
        // projects are one total, released on the same rule.
        const membersPerProject = new Map<string, number>();

        for (const member of shown) {
            for (const project of member.projects) {
                membersPerProject.set(project.projectKey, (membersPerProject.get(project.projectKey) ?? 0) + 1);
            }
        }

        const folded = (projectKey: string): boolean => {
            const count = membersPerProject.get(projectKey) ?? 0;

            return count > 0 && count < MIN_MEMBERS_PER_GROUP;
        };
        const removedMembers = shown.filter((member) => member.removed !== undefined).length;
        const removedWithheld = removedMembers > 0 && removedMembers < MIN_MEMBERS_PER_GROUP;
        const small = { costMicrodollars: 0, replies: 0, tokens: 0 };
        const smallMembers = new Set<number>();

        for (const [index, member] of shown.entries()) {
            for (const project of member.projects) {
                if (folded(project.projectKey)) {
                    small.costMicrodollars += project.costMicrodollars;
                    small.replies += project.replies;
                    small.tokens += project.tokens;
                    smallMembers.add(index);

                    continue;
                }

                const sum = sums.get(project.projectKey);

                if (sum) {
                    sum.costMicrodollars += project.costMicrodollars;
                    sum.replies += project.replies;
                    sum.tokens += project.tokens;
                }
            }

            if (member.removed && !removedWithheld) {
                removed.costMicrodollars += member.removed.costMicrodollars;
                removed.replies += member.removed.replies;
                removed.tokens += member.removed.tokens;
            }
        }

        // The folded total is released only with `MIN_MEMBERS_PER_GROUP` members across its projects.
        const smallReleased = smallMembers.size >= MIN_MEMBERS_PER_GROUP;
        const smallWithheld = smallMembers.size > 0 && !smallReleased;
        const someWithheld = removedWithheld || smallWithheld;

        ctx.log.event("usage.get_organization_project_usage", { members: walked.length, projects: listed.length });

        const nextCursor = remaining && resume !== undefined ? await sealOrganizationCursor(organizationId, resume, since) : undefined;
        // `walked` is in cohort order, so its last member is the position the walk reached.

        return {
            ...(nextCursor !== undefined && { nextCursor }),
            projects: [...sums.values()]
                // Only projects with replies in the shown groups: a withheld group must not render every project at zero.
                .filter((sum) => sum.replies > 0 && !folded(sum.projectKey))
                .toSorted((a, b) => b.costMicrodollars - a.costMicrodollars || b.replies - a.replies || a.title.localeCompare(b.title)),
            ...(smallReleased && small.replies > 0 && { small }),
            ...(removed.replies > 0 && { removed }),
            // A member's own truncation is never copied out: it would show that one member had more rows than the read takes. Their group is
            // withheld instead, which says only that some group is partial.
            truncated: projectsCut || groupsWithheld || someWithheld,
        };
    });

/** Ledger rows one export read takes, newest first. */
const EXPORT_REPLY_PAGE = 2000;

/**
 * Export reads one ledger export makes, at most: with {@link EXPORT_REPLY_PAGE} rows a read, this covers far more rows than the export's byte
 * budget holds, and bounds the subrequests the account export makes on a member's shard.
 */
export const MAX_EXPORT_REPLY_PAGES = 20;

/**
 * One page of the user's organization ledger for the account export: each reply's instant, cost and tokens, and the organization and
 * project it was recorded under. No reply keys: they are bookkeeping, not the user's data.
 */
export const collectOrganizationRepliesForExport = internalQuery
    .input({ cursor: v.union(v.string(), v.null()), userId: v.string().max(MAX_LENGTH.id) })
    .output(
        v.object({
            cursor: v.union(v.string(), v.null()),
            rows: v.array(
                v.object({
                    at: v.number(),
                    costMicrodollars: v.number(),
                    organizationId: v.string(),
                    projectKey: v.string(),
                    tokens: v.number(),
                }),
            ),
        }),
    )
    .query(async ({ args: { cursor, userId }, ctx }) => {
        // From the primary, as the other export reads are: a replica that lags a reply just recorded would leave it out of the export. Newest
        // first, so the collector can stop reading once the budget is full, instead of reading the whole ledger to find its newest rows.
        const result = await ctx.db.usageOrganizationReplies.findMany({
            consistency: "primary",
            cursor,
            limit: EXPORT_REPLY_PAGE,
            orderBy: [{ at: "desc" }],
            where: { userId },
        });

        return {
            cursor: result.isDone ? null : result.continueCursor,
            rows: result.page.map((row) => {
                return {
                    at: row.at,
                    costMicrodollars: row.costMicrodollars,
                    organizationId: row.organizationId,
                    projectKey: row.projectKey,
                    tokens: row.tokens,
                };
            }),
        };
    });

/**
 * The ledger rows for the export, the newest that fit a byte budget, in reply-time order. The reader returns the newest rows first, a page
 * at a time, and the collector stops once the budget is full or after `maxPages` reads, whichever comes first. Past either, the oldest rows
 * are cut, and `cut` says so, as the trigger history is cut: the export still succeeds, and says what it left out. The budget is the JSON
 * array of the rows, `[` and `]` included.
 */
export const collectOrganizationReplyPages = async <Row extends { at: number }>(
    read: (cursor: string | null) => Promise<{ cursor: string | null; rows: Row[] }>,
    maxBytes: number,
    maxPages: number = MAX_EXPORT_REPLY_PAGES,
): Promise<{ cut: boolean; rows: Row[] }> => {
    const encoder = new TextEncoder();
    // Newest first: the rows are added as they are read, and reversed into reply-time order at the end.
    const kept: Row[] = [];
    let bytes = 2;
    let cursor: string | null = null;
    let pages = 0;

    do {
        const page = await read(cursor);

        pages += 1;

        const newestFirst = page.rows.toSorted((a, b) => b.at - a.at);

        for (const row of newestFirst) {
            // A row after the first kept one brings its comma.
            const size = encoder.encode(JSON.stringify(row)).byteLength + (kept.length > 0 ? 1 : 0);

            if (bytes + size > maxBytes) {
                return { cut: true, rows: kept.toReversed() };
            }

            bytes += size;
            kept.push(row);
        }

        cursor = page.cursor;

        if (cursor !== null && pages >= maxPages) {
            return { cut: true, rows: kept.toReversed() };
        }
    } while (cursor !== null);

    return { cut: false, rows: kept.toReversed() };
};

/** Contributor entries one reconcile sets for a member under an organization: duplicates are a race's, a few at most. */
export const CONTRIBUTORS_PER_PAIR = 50;

/**
 * Sets a member's contributor entries under an organization to match their rows on this shard: an entry while they have rows, none once
 * they have none. It runs on the member's shard after the write that changed the rows has committed (`recordOrganizationReply`, the
 * retention prune). Lunora does not commit a shard's writes and a global table's together, so the global entry is never written in the
 * same mutation as the rows; this one only reads the shard, so a run that is repeated changes nothing more.
 */
export const reconcileOrganizationContributor = internalMutation
    .input({ organizationId: v.string().max(MAX_LENGTH.id), userId: v.string().max(MAX_LENGTH.id) })
    .output(v.null())
    .mutation(async ({ args: { organizationId, userId }, ctx }) => {
        const row = await ctx.db.usageOrganizationReplies.findFirst({ consistency: "primary", where: { organizationId, userId } });
        const { page: entries } = await ctx.db.usageOrganizationContributors.findMany({
            consistency: "primary",
            limit: CONTRIBUTORS_PER_PAIR,
            where: { organizationId, userId },
        });

        if (row) {
            if (entries.length === 0) {
                await insertContributor(ctx, { createdAt: row.at, organizationId, userId });
            }

            // Two entries for one member (two first replies booked at once) would each count the member; one is kept.
            await Promise.all(entries.slice(1).map(async (entry) => await ctx.db.delete("usageOrganizationContributors", entry._id)));

            return null;
        }

        await Promise.all(entries.map(async (entry) => await ctx.db.delete("usageOrganizationContributors", entry._id)));

        return null;
    });
