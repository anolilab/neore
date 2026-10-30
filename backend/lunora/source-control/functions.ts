/**
 * Develop mode, read side: the signed-in user's pull requests on their Git host.
 *
 * Every procedure is an ACTION: it calls the host with the user's own connector
 * token, and an external call never belongs in a query or mutation. Nothing here
 * is stored; the page caches what it reads. The review half (drafts, threads,
 * viewed marks) is in `review-*.ts`. The token is decrypted inside the action,
 * used for the call and never returned. A failure a person can act on is a
 * `status`, not a throw.
 *
 * The driver is picked in one place (`DEVELOP_DRIVER`), and the page reads what
 * the host can do from the capability report.
 */
import { v } from "lunorash/server";

import { hasGithubGrant, resolveGithubToken } from "../connectors/lib/github-token";
import { authAction, rateLimit } from "../lib/crpc";
import { MAX_LENGTH } from "../lib/validators";
import { leftOutPast } from "./coverage";
import { DEVELOP_DRIVER } from "./develop-driver";
import { readFromHost } from "./read-host";
import { vFailed } from "./validators";

const vCapability = v.union(
    v.object({ degradation: v.literal("none"), supported: v.literal(true) }),
    v.object({
        degradation: v.union(v.literal("restart"), v.literal("synthetic"), v.literal("divergent")),
        note: v.string().max(MAX_LENGTH.long),
        supported: v.literal(true),
    }),
    v.object({ reason: v.union(v.literal("not_offered"), v.literal("not_enforced"), v.literal("unknown")), supported: v.literal(false) }),
);

const vSummary = v.object({
    authorLogin: v.string(),
    commentCount: v.number(),
    createdAt: v.number(),
    draft: v.boolean(),
    labels: v.array(v.string()),
    number: v.number(),
    repository: v.string(),
    title: v.string(),
    updatedAt: v.number(),
    url: v.string(),
});

const vDetail = v.object({
    additions: v.number(),
    authorLogin: v.string(),
    baseBranch: v.string(),
    body: v.string(),
    bodyTruncated: v.boolean(),
    changedFiles: v.number(),
    commitCount: v.number(),
    createdAt: v.number(),
    deletions: v.number(),
    draft: v.boolean(),
    headBranch: v.string(),
    headSha: v.string(),
    number: v.number(),
    repository: v.string(),
    state: v.union(v.literal("closed"), v.literal("merged"), v.literal("open")),
    title: v.string(),
    updatedAt: v.number(),
    url: v.string(),
});

const vCommit = v.object({ authorName: v.string(), committedAt: v.number(), message: v.string(), sha: v.string() });

const vFile = v.object({
    additions: v.number(),
    deletions: v.number(),
    patch: v.union(v.string(), v.null()),
    patchState: v.union(v.literal("full"), v.literal("host_omitted"), v.literal("over_budget"), v.literal("truncated")),
    path: v.string(),
    previousPath: v.union(v.string(), v.null()),
    status: v.union(
        v.literal("added"),
        v.literal("changed"),
        v.literal("copied"),
        v.literal("modified"),
        v.literal("removed"),
        v.literal("renamed"),
        v.literal("unchanged"),
    ),
});

const vCheck = v.object({
    name: v.string(),
    state: v.union(v.literal("cancelled"), v.literal("failure"), v.literal("neutral"), v.literal("pending"), v.literal("skipped"), v.literal("success")),
    url: v.union(v.string(), v.null()),
});

const vRef = {
    number: v.number(),
    repository: v.string().max(MAX_LENGTH.short),
};

/** Which host Develop reads, what it can do, and whether the user has connected it. No call to the host. */
export const getDevelopHost = authAction
    .use(rateLimit("sourceControl/read"))
    .input({})
    .output(
        v.object({
            connected: v.boolean(),
            host: v.object({
                capabilities: v.object({ groups: v.record(v.string(), v.record(v.string(), vCapability)), reportedAt: v.number(), version: v.literal(1) }),
                connectorSlug: v.string(),
                label: v.string(),
                limits: v.object({ commits: v.number(), files: v.number() }),
                requestNoun: v.union(v.literal("merge request"), v.literal("pull request")),
            }),
        }),
    )
    .action(async ({ ctx }) => {
        const connected = await hasGithubGrant(ctx, ctx.user.userId);

        ctx.log.event("source_control.get_host", { connected });

        return { connected, host: DEVELOP_DRIVER.view };
    });

/** One section of the inbox: needs my review, mine, ready to merge, drafts. */
export const getInbox = authAction
    .use(rateLimit("sourceControl/read"))
    .input({
        page: v.optional(v.number()),
        section: v.union(v.literal("needsMyReview"), v.literal("mine"), v.literal("readyToMerge"), v.literal("drafts")),
    })
    .output(v.union(v.object({ hasMore: v.boolean(), items: v.array(vSummary), page: v.number(), status: v.literal("ok"), total: v.number() }), vFailed))
    .action(async ({ args, ctx }) => {
        const token = await resolveGithubToken(ctx, ctx.user.userId);
        const outcome = await readFromHost(DEVELOP_DRIVER, token, (request) => DEVELOP_DRIVER.listInbox(request, args.section, args.page ?? 1));

        ctx.log.event("source_control.get_inbox", { section: args.section, status: outcome.status });

        return outcome;
    });

/** A pull request's header and description, with how much of its commits and files the host will not list. */
export const getPullRequest = authAction
    .use(rateLimit("sourceControl/read"))
    .input(vRef)
    .output(
        v.union(
            v.object({
                detail: vDetail,
                leftOut: v.object({ commits: v.number(), files: v.number() }),
                status: v.literal("ok"),
            }),
            vFailed,
        ),
    )
    .action(async ({ args, ctx }) => {
        const token = await resolveGithubToken(ctx, ctx.user.userId);
        const outcome = await readFromHost(DEVELOP_DRIVER, token, async (request) => {
            const detail = await DEVELOP_DRIVER.getPullRequest(request, args);
            const { limits } = DEVELOP_DRIVER.view;

            return { detail, leftOut: { commits: leftOutPast(detail.commitCount, limits.commits), files: leftOutPast(detail.changedFiles, limits.files) } };
        });

        ctx.log.event("source_control.get_pull_request", { status: outcome.status });

        return outcome;
    });

export const getPullRequestCommits = authAction
    .use(rateLimit("sourceControl/read"))
    .input({ ...vRef, page: v.optional(v.number()) })
    .output(v.union(v.object({ commits: v.array(vCommit), hasMore: v.boolean(), page: v.number(), status: v.literal("ok") }), vFailed))
    .action(async ({ args, ctx }) => {
        const token = await resolveGithubToken(ctx, ctx.user.userId);
        const outcome = await readFromHost(DEVELOP_DRIVER, token, (request) => DEVELOP_DRIVER.listCommits(request, args, args.page ?? 1));

        ctx.log.event("source_control.get_commits", { status: outcome.status });

        return outcome;
    });

/** One page (100) of a pull request's files with their patches; the page asks for the next while `hasMore`. */
export const getPullRequestFiles = authAction
    .use(rateLimit("sourceControl/read"))
    .input({ ...vRef, page: v.optional(v.number()) })
    .output(v.union(v.object({ files: v.array(vFile), hasMore: v.boolean(), page: v.number(), status: v.literal("ok") }), vFailed))
    .action(async ({ args, ctx }) => {
        const token = await resolveGithubToken(ctx, ctx.user.userId);
        const outcome = await readFromHost(DEVELOP_DRIVER, token, (request) => DEVELOP_DRIVER.listFiles(request, args, args.page ?? 1));

        ctx.log.event("source_control.get_files", { status: outcome.status });

        return outcome;
    });

export const getPullRequestChecks = authAction
    .use(rateLimit("sourceControl/read"))
    .input({ ...vRef, headSha: v.string().max(MAX_LENGTH.short) })
    .output(v.union(v.object({ checks: v.array(vCheck), status: v.literal("ok"), total: v.number() }), vFailed))
    .action(async ({ args, ctx }) => {
        const token = await resolveGithubToken(ctx, ctx.user.userId);
        const outcome = await readFromHost(DEVELOP_DRIVER, token, (request) => DEVELOP_DRIVER.listChecks(request, args, args.headSha));

        ctx.log.event("source_control.get_checks", { status: outcome.status });

        return outcome;
    });
