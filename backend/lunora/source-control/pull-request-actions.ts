/**
 * Develop mode, pull request actions: edit the title and description, request reviewers,
 * and open a revert of a merged pull request. Every procedure is an ACTION and every one is
 * something the user confirmed in the UI. A procedure refuses when the driver does not
 * declare the capability, before any token is read. A host refusal comes back as `rejected`
 * with the host's own reason; a write whose answer never arrived is `unconfirmed`.
 */
import { LunoraError, v } from "lunorash/server";

import { resolveGithubToken } from "../connectors/lib/github-token";
import { authAction, rateLimit } from "../lib/crpc";
import { MAX_LENGTH } from "../lib/validators";
import { requireCapability } from "./capability-gate";
import { DEVELOP_DRIVER } from "./develop-driver";
import { vWriteFailed } from "./validators";
import { writeToHost } from "./write-host";

const vOk = v.object({ status: v.literal("ok") });

const vRef = {
    number: v.number(),
    repository: v.string().max(MAX_LENGTH.short),
};

/** A title the host accepts is at most 256 characters; the validator only bounds what one request can store. */
const vTitle = v.string().max(MAX_LENGTH.short);
/** A description is as long as a prompt the workbench takes, well inside the host's own limit. */
const vBody = v.string().max(MAX_LENGTH.text);

/** Changes the title and/or description. A field left out keeps its value; an empty change is refused here. */
export const editPullRequest = authAction
    .use(rateLimit("sourceControl/write"))
    .input({ ...vRef, body: v.optional(vBody), title: v.optional(vTitle) })
    .output(v.union(vOk, vWriteFailed))
    .action(async ({ args, ctx }) => {
        requireCapability("pullRequest.edit");

        if (args.title === undefined && args.body === undefined) {
            throw new LunoraError("BAD_REQUEST", "Nothing to change");
        }

        const token = await resolveGithubToken(ctx, ctx.user.userId);
        const outcome = await writeToHost(DEVELOP_DRIVER, token, async (request) => {
            await DEVELOP_DRIVER.editPullRequest(request, args, { body: args.body, title: args.title });

            return {};
        });

        ctx.log.event("source_control.edit_pull_request", { status: outcome.status });

        return outcome;
    });

/** Adds reviewers by login; the ones already requested stay. The host checks that each login may review. */
export const requestReviewers = authAction
    .use(rateLimit("sourceControl/write"))
    .input({ ...vRef, logins: v.array(v.string().max(MAX_LENGTH.short)) })
    .output(v.union(vOk, vWriteFailed))
    .action(async ({ args, ctx }) => {
        requireCapability("reviewers.request");

        const token = await resolveGithubToken(ctx, ctx.user.userId);
        const outcome = await writeToHost(DEVELOP_DRIVER, token, async (request) => {
            await DEVELOP_DRIVER.requestReviewers(request, args, args.logins);

            return {};
        });

        ctx.log.event("source_control.request_reviewers", { count: args.logins.length, status: outcome.status });

        return outcome;
    });

/** Opens a pull request that reverts a merged one. The new pull request is a separate change the person reviews and merges. */
export const revertPullRequest = authAction
    .use(rateLimit("sourceControl/write"))
    .input({ ...vRef, body: v.optional(vBody), title: v.optional(vTitle) })
    .output(v.union(v.object({ number: v.number(), repository: v.string(), status: v.literal("ok"), url: v.string() }), vWriteFailed))
    .action(async ({ args, ctx }) => {
        requireCapability("pullRequest.revert");

        const token = await resolveGithubToken(ctx, ctx.user.userId);
        const outcome = await writeToHost(
            DEVELOP_DRIVER,
            token,
            async (request) => await DEVELOP_DRIVER.revertPullRequest(request, args, { body: args.body, title: args.title }),
        );

        ctx.log.event("source_control.revert_pull_request", { status: outcome.status });

        return outcome;
    });
