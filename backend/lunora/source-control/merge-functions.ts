/**
 * Develop mode, checks and merge: the host calls that change a pull request's
 * state. Every procedure is an ACTION and every one is something the user just
 * confirmed in the UI: nothing here runs on its own. A procedure refuses when the
 * driver's capability report does not declare what it does (`unknown` is
 * unsupported), so a client that skips the UI's gating still cannot reach a host
 * call the driver never offered.
 *
 * A merge names the head commit the person looked at, so the host refuses it when
 * the branch moved since. When the host's rules refuse a merge the answer is
 * `rejected` with the host's own reason. The token is used for the call and never
 * returned.
 */
import { v } from "lunorash/server";

import { internal } from "../_generated/internal";
import type { ActionCtx } from "../_generated/server";

import { resolveGithubToken } from "../connectors/lib/github-token";
import { authAction, rateLimit } from "../lib/crpc";
import { MAX_LENGTH } from "../lib/validators";
import { isHostCapabilityAvailable } from "./capabilities";
import { requireCapability } from "./capability-gate";
import { DEVELOP_DRIVER } from "./develop-driver";
import { recordMergedPullRequest } from "./pr-merged";
import { MERGE_TIME_PRECISION_MS } from "./pr-threads";
import { readFromHost } from "./read-host";
import { vFailed, vMergeMethod, vWriteFailed } from "./validators";
import { writeToHost } from "./write-host";

const vOk = v.object({ status: v.literal("ok") });

const vRef = {
    number: v.number(),
    repository: v.string().max(MAX_LENGTH.short),
};

/** What the host says of mergeability, and which merge methods and auto-merge the repository allows. */
export const getMergeStatus = authAction
    .use(rateLimit("sourceControl/read"))
    .input(vRef)
    .output(
        v.union(
            v.object({
                autoMergeAllowed: v.boolean(),
                autoMergeEnabled: v.boolean(),
                methods: v.array(vMergeMethod),
                state: v.union(
                    v.literal("behind"),
                    v.literal("blocked"),
                    v.literal("clean"),
                    v.literal("conflicting"),
                    v.literal("draft"),
                    v.literal("unknown"),
                    v.literal("unstable"),
                ),
                status: v.literal("ok"),
            }),
            vFailed,
        ),
    )
    .action(async ({ args, ctx }) => {
        // The panel is useful with either: a host may offer auto-merge alone.
        if (!isHostCapabilityAvailable(DEVELOP_DRIVER.view.capabilities, "merge.now")) {
            requireCapability("merge.auto");
        }

        const token = await resolveGithubToken(ctx, ctx.user.userId);
        const outcome = await readFromHost(DEVELOP_DRIVER, token, (request) => DEVELOP_DRIVER.getMergeStatus(request, args));

        ctx.log.event("source_control.get_merge_status", { status: outcome.status });

        return outcome;
    });

/** Re-runs one check on its own (a single job where the host has jobs), not the workflow it belongs to. */
export const rerunCheck = authAction
    .use(rateLimit("sourceControl/write"))
    .input({ ...vRef, checkId: v.string().max(MAX_LENGTH.id) })
    .output(v.union(vOk, vWriteFailed))
    .action(async ({ args, ctx }) => {
        requireCapability("checks.rerun");

        const token = await resolveGithubToken(ctx, ctx.user.userId);
        const outcome = await writeToHost(DEVELOP_DRIVER, token, async (request) => {
            await DEVELOP_DRIVER.rerunCheck(request, args, args.checkId);

            return {};
        });

        ctx.log.event("source_control.rerun_check", { status: outcome.status });

        return outcome;
    });

/** Whether the owner's merged-chat archiving is on. A failed lookup answers true (the host's time is then read), and is logged. */
const mergedArchiveOnOrUnknown = async (ctx: Pick<ActionCtx, "runQuery">, userId: string): Promise<boolean> => {
    try {
        return await ctx.runQuery(internal.source_control.pr_threads.mergedArchiveOn, { userId });
    } catch (error) {
        console.error("[source-control] could not read the merged-archive setting for a merge", error);

        return true;
    }
};

/** The host's merge time of a pull request that has merged, read once after the merge. Absent when the read fails. */
const hostMergedAt = async (token: Parameters<typeof readFromHost>[1], ref: { number: number; repository: string }): Promise<number | undefined> => {
    try {
        const outcome = await readFromHost(DEVELOP_DRIVER, token, async (request) => {
            const detail = await DEVELOP_DRIVER.getPullRequest(request, ref);

            return { mergedAt: detail.mergedAt, state: detail.state };
        });

        return outcome.status === "ok" && outcome.state === "merged" ? outcome.mergedAt : undefined;
    } catch (error) {
        // The merge already happened on the host: a failed timestamp read must not fail the merge or skip recording it.
        console.error("[source-control] could not read a merged pull request's merge time", error);

        return undefined;
    }
};

/** Merges now. The host's rules may refuse it: that is a `rejected` answer carrying the host's reason. */
export const mergePullRequest = authAction
    .use(rateLimit("sourceControl/write"))
    .input({ ...vRef, headSha: v.string().max(MAX_LENGTH.short), method: vMergeMethod })
    .output(v.union(v.object({ sha: v.union(v.string(), v.null()), status: v.literal("ok") }), vWriteFailed))
    .action(async ({ args, ctx }) => {
        requireCapability("merge.now");

        const token = await resolveGithubToken(ctx, ctx.user.userId);
        // Taken before the merge is asked for, so it is never later than the host's merge time.
        const requestedAt = Date.now();
        const outcome = await writeToHost(
            DEVELOP_DRIVER,
            token,
            async (request) => await DEVELOP_DRIVER.mergePullRequest(request, args, { headSha: args.headSha, method: args.method }),
        );

        ctx.log.event("source_control.merge", { method: args.method, status: outcome.status });

        // An unconfirmed answer (the host may have merged, but its reply could not be read) is recorded only when a host read
        // confirms the merge: the read returns a merge time only for a merged pull request.
        const ref = { number: args.number, repository: args.repository };
        // The host's time is read only when it can change the outcome: an unconfirmed answer needs it to confirm the merge, and a
        // merge that can archive needs it to order against the opt-in. Otherwise the merge is recorded at the request time.
        // A failed settings lookup must not fail a merge the host already made: it reads the host's time, the conservative path.
        const archiveOn = outcome.status === "ok" ? await mergedArchiveOnOrUnknown(ctx, ctx.user.userId) : false;
        const hostAt = outcome.status === "unconfirmed" || (outcome.status === "ok" && archiveOn) ? await hostMergedAt(token, ref) : undefined;

        if (outcome.status === "ok" || (outcome.status === "unconfirmed" && hostAt !== undefined)) {
            // The host's time is whole seconds, so the merge lies in the second it names; the request time is precise and never
            // after the merge. The later of the two orders a merge this request completed against the owner's opt-in (a merge after
            // opt-in inside the same second still archives). A pull request that had merged clearly before this request (a retry of an
            // old merge) keeps its historical time, so it is judged as it was. The upper bound is the end of the host's second.
            const historical = hostAt !== undefined && hostAt + MERGE_TIME_PRECISION_MS <= requestedAt ? hostAt : undefined;
            const mergedAt = historical ?? Math.max(hostAt ?? 0, requestedAt);
            // Without the host's time the merge may have come at any point from the request onward, so a link made after the request is
            // not counted as predating it. That leaves a link made in that window unarchived now; the next status read of the pull request
            // records the merge with the host's time and then counts it.
            const mergedBefore = hostAt === undefined ? requestedAt : hostAt + MERGE_TIME_PRECISION_MS;

            await recordMergedPullRequest(ctx, ctx.user.userId, ref, mergedAt, mergedBefore);
        }

        return outcome;
    });

/** Turns auto-merge on (merge `headSha` with `method` once the host's rules are met) or off. */
export const setAutoMerge = authAction
    .use(rateLimit("sourceControl/write"))
    .input({ ...vRef, enabled: v.boolean(), headSha: v.string().max(MAX_LENGTH.short), method: vMergeMethod })
    .output(v.union(vOk, vWriteFailed))
    .action(async ({ args, ctx }) => {
        requireCapability("merge.auto");

        const token = await resolveGithubToken(ctx, ctx.user.userId);
        const outcome = await writeToHost(DEVELOP_DRIVER, token, async (request) => {
            await DEVELOP_DRIVER.setAutoMerge(request, args, args.enabled, args.method, args.headSha);

            return {};
        });

        ctx.log.event("source_control.set_auto_merge", { enabled: args.enabled, status: outcome.status });

        return outcome;
    });
