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
import { LunoraError, v } from "lunorash/server";

import { resolveGithubToken } from "../connectors/lib/github-token";
import { authAction, rateLimit } from "../lib/crpc";
import { MAX_LENGTH } from "../lib/validators";
import type { HostCapabilityKey } from "./capabilities";
import { isHostCapabilityAvailable } from "./capabilities";
import { DEVELOP_DRIVER } from "./develop-driver";
import { readFromHost } from "./read-host";
import { vFailed, vMergeMethod, vWriteFailed } from "./validators";
import { writeToHost } from "./write-host";

const vOk = v.object({ status: v.literal("ok") });

const vRef = {
    number: v.number(),
    repository: v.string().max(MAX_LENGTH.short),
};

const requireCapability = (key: HostCapabilityKey): void => {
    if (!isHostCapabilityAvailable(DEVELOP_DRIVER.view.capabilities, key)) {
        throw new LunoraError("BAD_REQUEST", "This host does not offer that");
    }
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
        requireCapability("merge.now");

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

/** Merges now. The host's rules may refuse it: that is a `rejected` answer carrying the host's reason. */
export const mergePullRequest = authAction
    .use(rateLimit("sourceControl/write"))
    .input({ ...vRef, headSha: v.string().max(MAX_LENGTH.short), method: vMergeMethod })
    .output(v.union(v.object({ sha: v.union(v.string(), v.null()), status: v.literal("ok") }), vWriteFailed))
    .action(async ({ args, ctx }) => {
        requireCapability("merge.now");

        const token = await resolveGithubToken(ctx, ctx.user.userId);
        const outcome = await writeToHost(
            DEVELOP_DRIVER,
            token,
            async (request) => await DEVELOP_DRIVER.mergePullRequest(request, args, { headSha: args.headSha, method: args.method }),
        );

        ctx.log.event("source_control.merge", { method: args.method, status: outcome.status });

        return outcome;
    });

/** Turns auto-merge on (merge with `method` once the host's rules are met) or off. */
export const setAutoMerge = authAction
    .use(rateLimit("sourceControl/write"))
    .input({ ...vRef, enabled: v.boolean(), method: vMergeMethod })
    .output(v.union(vOk, vWriteFailed))
    .action(async ({ args, ctx }) => {
        requireCapability("merge.auto");

        const token = await resolveGithubToken(ctx, ctx.user.userId);
        const outcome = await writeToHost(DEVELOP_DRIVER, token, async (request) => {
            await DEVELOP_DRIVER.setAutoMerge(request, args, args.enabled, args.method);

            return {};
        });

        ctx.log.event("source_control.set_auto_merge", { enabled: args.enabled, status: outcome.status });

        return outcome;
    });
