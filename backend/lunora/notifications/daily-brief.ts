/**
 * The Daily Brief: an OPT-IN morning summary delivered as a notification.
 *
 * ## Scheduling without a cron
 *
 * The same shape as the nightly memory reflection (`memory/reflection.ts`). No
 * cron walks the user table: after an interactive reply, `afterRun` schedules
 * {@link noteDailyBriefActivity}, which stamps `lastActiveAt` and — when no run
 * is pending — `runAt`s {@link runDailyBrief} at the user's next local 07:xx.
 * Turning the setting on ({@link setDailyBriefEnabled}) does the same, so the
 * first brief does not wait for a chat. Only users active in the last two days
 * ever have a run queued.
 *
 * The run re-checks everything when it fires ({@link claimDailyBrief}): still
 * enabled, recently active, inside the local morning window, not already run
 * today. A late, duplicated or stale job does nothing.
 *
 * ## Cost
 *
 * One utility-model call, bounded by `BRIEF_LIMITS`. A brief is a background run
 * nobody is watching, so it is charged like one — `tasks/account.ts:chargeRound`
 * (the chat daily limit and the task-run ceiling). Anonymous accounts get none.
 * A day with nothing to report is not charged and writes nothing.
 */
import { generateText } from "ai";
import { v } from "lunorash/server";

import { internal } from "../_generated/internal";
import type { MutationCtx } from "../_generated/server";
import { internalAction, internalMutation, internalQuery } from "../_generated/server";
import { saveUserSettings } from "../auth/lib/preference-writes";
import { isAccountDeletionUnderway } from "../gdpr/deletion-guard";
import { loadHomeOverview } from "../home/overview";
import { authMutation, rateLimit } from "../lib/crpc";
import { patchRow } from "../lib/patch";
import { gatewayFetch } from "../lib/services";
import { getUtilityModel } from "../lib/utility-model";
import { planActivityUpdate } from "../memory/reflection-logic";
import { chargeRound, hasRoundAllowance, loadTaskAccount, taskAccessProblem } from "../tasks/account";
import type { BriefInputs } from "./daily-brief-logic";
import {
    BRIEF_LIMITS,
    BRIEF_SYSTEM_PROMPT,
    buildBriefPrompt,
    checkBriefEligibility,
    fallbackBrief,
    hasBriefContent,
    nextBriefRunAt,
} from "./daily-brief-logic";
import { notify } from "./notify";
import { sumMessageCosts } from "../agent/message-cost";
import { DAILY_BRIEF_SKILL_KEY } from "../usage/activity-logic";
import { scheduleReplyUsage } from "../usage/schedule";

const DAY_MS = 24 * 60 * 60 * 1000;

/** Notifications a brief reads to say what happened since the last one. */
const BRIEF_EVENTS_READ = 50;

/** Structured event per run, so skip reasons are countable. */
const BRIEF_EVENT = "notifications.daily_brief";

const loadUserSettings = async (ctx: Pick<MutationCtx, "db">, userId: string) => await ctx.db.userSettings.findFirst({ where: { userId } });

const loadState = async (ctx: Pick<MutationCtx, "db">, userId: string) => await ctx.db.dailyBriefState.findFirst({ where: { userId } });

/** Records activity and makes sure the next morning's run is scheduled. Cheap when nothing changed. */
const ensureScheduled = async (ctx: MutationCtx, userId: string, timeZone: string | undefined): Promise<void> => {
    const now = Date.now();
    const state = await loadState(ctx, userId);
    const plan = planActivityUpdate(state ?? undefined, now);

    if (!plan.recordActivity && !plan.schedule) {
        return;
    }

    let scheduled: { scheduledFor: number; scheduledJobId: string } | undefined;

    if (plan.schedule) {
        const scheduledFor = nextBriefRunAt(now, timeZone, userId);
        const scheduledJobId = await ctx.scheduler.runAt(scheduledFor, internal.notifications.daily_brief.runDailyBrief, { userId });

        scheduled = { scheduledFor, scheduledJobId };
    }

    if (state) {
        await ctx.db.patch(state._id, { lastActiveAt: now, ...scheduled });
    } else {
        await ctx.db.insert("dailyBriefState", { lastActiveAt: now, userId, ...scheduled });
    }
};

/** Scheduled by `afterRun` after an interactive reply. A no-op for users who have not opted in. */
export const noteDailyBriefActivity = internalMutation
    .input({ userId: v.string() })
    .output(v.null())
    .mutation(async ({ args: { userId }, ctx }) => {
        if (await isAccountDeletionUnderway(ctx, userId)) {
            return null;
        }

        const settings = await loadUserSettings(ctx, userId);

        if (settings?.dailyBriefEnabled === true) {
            await ensureScheduled(ctx, userId, settings.timezone);
        }

        return null;
    });

/** The settings toggle. Turning it on schedules the next morning's brief right away. */
export const setDailyBriefEnabled = authMutation
    .use(rateLimit("notifications/update"))
    .input({ enabled: v.boolean() })
    .output(v.null())
    .mutation(async ({ args: { enabled }, ctx }) => {
        const { userId } = ctx.user;

        if (await isAccountDeletionUnderway(ctx, userId)) {
            return null;
        }

        const settings = await loadUserSettings(ctx, userId);

        await saveUserSettings(ctx.db, settings, userId, { dailyBriefEnabled: enabled });

        if (enabled) {
            await ensureScheduled(ctx, userId, settings?.timezone);
        }

        ctx.log.event("notifications.set_daily_brief_enabled", { enabled });

        return null;
    });

/**
 * Decides, when the job fires, whether this run happens, and claims the local
 * day so a duplicate delivery cannot run (or be charged) a second time.
 */
export const claimDailyBrief = internalMutation
    .input({ userId: v.string() })
    .output(
        v.union(v.object({ claimed: v.literal(true), localDay: v.string(), since: v.number() }), v.object({ claimed: v.literal(false), reason: v.string() })),
    )
    .mutation(async ({ args: { userId }, ctx }) => {
        const [settings, state] = await Promise.all([loadUserSettings(ctx, userId), loadState(ctx, userId)]);
        const now = ctx.now;
        const eligibility = checkBriefEligibility({
            enabled: settings?.dailyBriefEnabled === true,
            lastActiveAt: state?.lastActiveAt,
            lastRunLocalDay: state?.lastRunLocalDay,
            now,
            timeZone: settings?.timezone,
        });

        if (!state) {
            return { claimed: false as const, reason: "no_state" };
        }

        // Clear the pending job unless it names a LATER one (activity scheduled
        // it while this one was overdue). `undefined` removes a field (`lib/patch.ts`).
        const clearPending = state.scheduledFor !== undefined && state.scheduledFor > now ? {} : { scheduledFor: undefined, scheduledJobId: undefined };

        if (!eligibility.eligible) {
            await patchRow(ctx.db, state, clearPending);

            return { claimed: false as const, reason: eligibility.reason };
        }

        const since = state.lastRunAt ?? now - DAY_MS;

        await patchRow(ctx.db, state, { ...clearPending, lastRunAt: now, lastRunLocalDay: eligibility.localDay });

        return { claimed: true as const, localDay: eligibility.localDay, since };
    });

/**
 * Charges the run once it has something to say, so a quiet day costs nothing.
 * An anonymous account gets no brief, as it gets no tasks. With `checkOnly` it
 * only answers whether a charge WOULD succeed: the run checks before the model
 * call and charges after it succeeds, so a failed call is never billed.
 */
export const chargeDailyBrief = internalMutation
    .input({ checkOnly: v.optional(v.boolean()), userId: v.string() })
    .output(v.union(v.literal("charged"), v.literal("no_account"), v.literal("daily_limit")))
    .mutation(async ({ args: { checkOnly, userId }, ctx }) => {
        const account = await loadTaskAccount(ctx, userId);

        if (!account || taskAccessProblem(account) !== undefined) {
            return "no_account" as const;
        }

        const ok = checkOnly === true ? await hasRoundAllowance(ctx, userId, account) : await chargeRound(ctx, userId, account);

        return ok ? ("charged" as const) : ("daily_limit" as const);
    });

export const loadDailyBriefInputs = internalQuery
    .input({ since: v.number(), userId: v.string() })
    .output(
        v.object({
            events: v.array(v.object({ outcome: v.optional(v.union(v.literal("success"), v.literal("failure"))), title: v.string(), type: v.string() })),
            needsYou: v.array(v.object({ kind: v.string(), title: v.string() })),
            running: v.array(v.object({ kind: v.string(), title: v.string() })),
            threads: v.array(v.string()),
        }),
    )
    .query(async ({ args: { since, userId }, ctx }): Promise<BriefInputs> => {
        const [overview, recent] = await Promise.all([
            loadHomeOverview(ctx, userId),
            ctx.db.notifications.findMany({ limit: BRIEF_EVENTS_READ, orderBy: [{ createdAt: "desc" }], where: { createdAt: { gt: since }, userId } }),
        ]);

        return {
            events: recent.page
                .filter((row) => row.type !== "daily_brief")
                .map((row) => {
                    return { title: row.title, type: row.type, ...(row.outcome && { outcome: row.outcome }) };
                }),
            needsYou: [
                ...overview.approvals.map((approval) => {
                    return { kind: "waiting_in_chat", title: approval.threadTitle ?? "A chat" };
                }),
                ...overview.reviews.map((task) => {
                    return { kind: "task_review", title: task.title };
                }),
            ],
            running: [
                ...overview.runningTasks.map((task) => {
                    return { kind: "task", title: task.title };
                }),
                ...overview.codingAgents.map((run) => {
                    return { kind: "coding_agent", title: `${run.repo}: ${run.prompt}` };
                }),
                ...overview.subAgents.map((run) => {
                    return { kind: "sub_agent", title: run.task };
                }),
            ],
            // `recentThreads` is most-recently-updated first, so "touched since
            // the last brief" is its leading run.
            threads: overview.recentThreads.filter((thread) => thread.updatedAt > since && thread.title).map((thread) => thread.title!),
        };
    });

export const writeDailyBrief = internalMutation
    .input({ localDay: v.string(), summary: v.string(), userId: v.string() })
    .output(v.null())
    .mutation(async ({ args: { localDay, summary, userId }, ctx }) => {
        await notify(ctx, { body: summary, dedupeKey: `daily_brief:${localDay}`, link: "/dashboard", title: localDay, type: "daily_brief", userId });

        return null;
    });

export const runDailyBrief = internalAction
    .input({ userId: v.string() })
    .output(v.null())
    .action(async ({ args: { userId }, ctx }) => {
        const claim = await ctx.runMutation(internal.notifications.daily_brief.claimDailyBrief, { userId });

        if (!claim.claimed) {
            ctx.log.event(BRIEF_EVENT, { outcome: "skipped", reason: claim.reason, userId });

            return null;
        }

        const inputs = await ctx.runQuery(internal.notifications.daily_brief.loadDailyBriefInputs, { since: claim.since, userId });

        if (!hasBriefContent(inputs)) {
            ctx.log.event(BRIEF_EVENT, { outcome: "skipped", reason: "nothing_to_report", userId });

            return null;
        }

        const allowance = await ctx.runMutation(internal.notifications.daily_brief.chargeDailyBrief, { checkOnly: true, userId });

        if (allowance !== "charged") {
            ctx.log.event(BRIEF_EVENT, { outcome: "skipped", reason: allowance, userId });

            return null;
        }

        let summary = "";
        let usage: { costMicrodollars: number; tokens: number } | undefined;

        try {
            const result = await generateText({
                maxOutputTokens: BRIEF_LIMITS.maxOutputTokens,
                model: await getUtilityModel(gatewayFetch(ctx), { userId }),
                prompt: buildBriefPrompt(inputs),
                system: BRIEF_SYSTEM_PROMPT,
            });

            summary = result.text.trim();
            usage = {
                costMicrodollars: Math.round(sumMessageCosts(result.steps.map((step) => step.providerMetadata))?.microdollars ?? 0),
                tokens: result.totalUsage.totalTokens ?? 0,
            };
        } catch (error) {
            console.warn("[notifications/daily-brief] Model call failed, writing the counts instead:", error);
        }

        // Charged only for a summary the model actually wrote; the plain
        // counts cost no model call. A limit reached in between (another run
        // spent the last round) drops the summary back to the counts.
        if (summary !== "") {
            const charge = await ctx.runMutation(internal.notifications.daily_brief.chargeDailyBrief, { userId });

            if (charge !== "charged") {
                summary = "";
            }
        }

        // The usage page counts the brief as one reply of the day it is for; the
        // day is its key, so a redelivered run records it once.
        if (summary !== "" && usage) {
            scheduleReplyUsage(ctx.scheduler as never, {
                at: Date.now(),
                ...usage,
                date: claim.localDay,
                replyKey: `daily_brief:${claim.localDay}`,
                skillKey: DAILY_BRIEF_SKILL_KEY,
                userId,
            });
        }

        await ctx.runMutation(internal.notifications.daily_brief.writeDailyBrief, {
            localDay: claim.localDay,
            summary: (summary || fallbackBrief(inputs)).slice(0, BRIEF_LIMITS.maxSummaryChars),
            userId,
        });

        ctx.log.event(BRIEF_EVENT, { modelUsed: summary !== "", outcome: "ran", userId });

        return null;
    });
