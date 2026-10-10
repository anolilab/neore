/**
 * Coding-agent runs — the actions: run, reap, kill, open a PR.
 *
 * The orchestration is `runner.ts`; this file wires it to storage, the user's
 * BYOK provider key, the GitHub connector and E2B. The provider key and the
 * GitHub token are decrypted here, handed to the runner, and never written
 * anywhere — the runner redacts them from everything it reports.
 */
import { v } from "lunorash/server";

import { internal } from "../_generated/internal";
import type { Id } from "../_generated/dataModel";
import type { ActionCtx } from "../_generated/server";
import { internalAction } from "../_generated/server";
import type { ConnectorGrant } from "../connectors/lib/grant-runtime";
import { obtainAccessToken } from "../connectors/lib/grant-runtime";
import { E2B_API_KEY } from "../env";
import { authAction, rateLimit } from "../lib/crpc";
import { fetchOk, FETCH_TIMEOUT_MS, HttpError } from "../lib/fetch-timeout";
import type { CodingAgentId } from "./commands";
import { CODING_AGENTS, missingKeyMessage, parseRepoUrl, RUN_TIMEOUT_MS } from "./commands";
import { buildRunResultMessage } from "./result-message";
import { createE2BSandboxProvider, killE2BSandbox } from "./sandbox-provider";
import { enqueueJob } from "../lib/job-queue";
import { expandSecrets, redactSecrets } from "./redact";
import type { PullRequestApi, SandboxHandle } from "./runner";
import {
    checkPullRequest,
    finalizeRun,
    openPullRequestForBranch,
    pollRun,
    PR_SANDBOX_TIMEOUT_MS,
    pullRequestProblem,
    startPullRequest,
    startRun,
} from "./runner";

const NOT_CONFIGURED = "Coding agents are not available on this server (no sandbox provider is configured).";

/** A usable GitHub connector token, or `undefined` when GitHub is not connected (or the grant is dead). */
const getGithubToken = async (ctx: Pick<ActionCtx, "runMutation" | "runQuery">, userId: string): Promise<string | undefined> => {
    const grants = (await ctx.runQuery(internal.connectors.store.listConnectorGrants, { userId })) as ConnectorGrant[];
    const grant = grants.find((candidate) => candidate.slug === "github");

    if (!grant) {
        return undefined;
    }

    const outcome = await obtainAccessToken(ctx, grant);

    return "error" in outcome ? undefined : outcome.accessToken;
};

/** The GitHub REST call that opens the PR — from the backend, never from a sandbox. */
const githubPullRequestCreator =
    (token: string): PullRequestApi["createPullRequest"] =>
    async ({ base, body, head, owner, repo, title }) => {
        try {
            const response = await fetchOk(`https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls`, {
                body: JSON.stringify({ base, body, head, title }),
                errorPrefix: "GitHub API error",
                headers: {
                    Accept: "application/vnd.github+json",
                    Authorization: `Bearer ${token}`,
                    "Content-Type": "application/json",
                    "User-Agent": "neore-chat",
                    "X-GitHub-Api-Version": "2022-11-28",
                },
                includeBody: true,
                method: "POST",
                timeoutMs: FETCH_TIMEOUT_MS,
            });
            const json = (await response.json()) as { html_url?: unknown };

            if (typeof json.html_url !== "string" || !json.html_url.startsWith("https://github.com/")) {
                throw new TypeError("GitHub did not return a pull request URL");
            }

            return json.html_url;
        } catch (error) {
            if (error instanceof HttpError && error.body) {
                const detail = (() => {
                    try {
                        return (JSON.parse(error.body) as { message?: string }).message;
                    } catch {
                        return undefined;
                    }
                })();

                throw new Error(detail ? `${error.message} — ${detail}` : error.message, { cause: error });
            }

            throw error;
        }
    };

const pullRequestTitle = (prompt: string): string => {
    const firstLine = prompt.split("\n", 1)[0]?.trim() ?? "";

    return `Coding agent: ${firstLine.length > 72 ? `${firstLine.slice(0, 71)}…` : firstLine}`;
};

const pullRequestBody = (summary: string | undefined): string =>
    [summary?.trim() || "_The agent did not leave a summary._", "", "---", "Opened by a Neore coding-agent run. Review the change before merging."].join("\n");

/**
 * Between polls. Polls ride the jobs queue (`lib/job-queue.ts`), so they no
 * longer hold the one-at-a-time SchedulerDO; this is just log freshness against
 * a sandbox command per poll.
 */
export const POLL_INTERVAL_MS = 4000;

/** A run still unfinished this long after it started is over, whatever the sandbox says. */
const POLL_DEADLINE_MS = RUN_TIMEOUT_MS + 60_000;

type RunnerCtx = Pick<ActionCtx, "runMutation" | "runQuery" | "scheduler">;

/** The user's provider key for `agent`, or `undefined`. */
const loadProviderKey = async (ctx: Pick<ActionCtx, "runQuery">, userId: string, agent: CodingAgentId): Promise<string | undefined> => {
    const keys = await ctx.runQuery(internal.auth.functions.getDecryptedProviderKeysQuery, { userId });

    return keys[CODING_AGENTS[agent].providerKey];
};

const failRun = async (ctx: RunnerCtx, runId: Id<"codingAgentRuns">, error: string): Promise<void> => {
    await ctx.runMutation(internal.coding_agents.functions.appendRunLog, { runId, text: `${error}\n` });
    await ctx.runMutation(internal.coding_agents.functions.completeRun, { error, runId, status: "failed" });
    await ctx.scheduler.runAfter(0, internal.coding_agents.execute.finishRun, { runId });
};

/**
 * Step 1: claim the run, check the key, create the sandbox and launch the run
 * script in it. Returns in seconds; the script runs on in the sandbox.
 */
export const startCodingAgentRun = internalAction
    .input({ runId: v.id("codingAgentRuns") })
    .output(v.null())
    .action(async ({ args: { runId }, ctx }) => {
        const claim = await ctx.runMutation(internal.coding_agents.functions.claimRun, { runId });

        if (!claim) {
            return null;
        }

        if (!E2B_API_KEY) {
            await failRun(ctx, runId, NOT_CONFIGURED);

            return null;
        }

        const providerKey = await loadProviderKey(ctx, claim.userId, claim.agent);

        if (!providerKey) {
            await failRun(ctx, runId, missingKeyMessage(claim.agent));

            return null;
        }

        const repo = parseRepoUrl(claim.repoUrl);
        const githubToken = repo.github ? await getGithubToken(ctx, claim.userId).catch(() => undefined) : undefined;

        await ctx.runMutation(internal.coding_agents.functions.appendRunLog, { runId, text: `Starting sandbox for ${repo.cloneUrl}\n` });

        const started = await startRun(
            {
                agent: claim.agent,
                ...(claim.branch !== undefined && { branch: claim.branch }),
                ...(githubToken !== undefined && { githubToken }),
                prompt: claim.prompt,
                providerKey,
                repo,
                runId,
                timeoutMs: RUN_TIMEOUT_MS,
            },
            {
                onSandbox: async (sandboxId) => await ctx.runMutation(internal.coding_agents.functions.setRunSandbox, { runId, sandboxId }),
                sandboxes: createE2BSandboxProvider(E2B_API_KEY),
            },
        );

        if (started.status === "failed") {
            await failRun(ctx, runId, `Could not start the sandbox: ${started.error ?? "unknown error"}`);
        } else if (started.status === "started") {
            await enqueueJob(internal.coding_agents.execute.pollCodingAgentRun, { runId, seq: 0 }, { delayMs: POLL_INTERVAL_MS });
        }

        // "cancelled": the cancel already scheduled the follow-ups; startRun killed the sandbox.
        return null;
    });

/**
 * Step 2, repeated: append what the script logged since the last poll, and
 * once it has ended, finalize — diff, summary, kill — and hand off to the
 * follow-ups. Each poll schedules the next; a poll that finds the run no longer
 * running (cancelled, reaped) simply stops the chain.
 */
export const pollCodingAgentRun = internalAction
    .input({ runId: v.id("codingAgentRuns"), seq: v.number() })
    .output(v.null())
    .action(async ({ args: { runId, seq }, ctx }) => {
        // At-least-once delivery: only the first delivery of `seq` polls.
        if (!(await ctx.runMutation(internal.coding_agents.functions.claimPoll, { runId, seq }))) {
            return null;
        }

        const run = await ctx.runQuery(internal.coding_agents.functions.getRunForPoll, { runId });

        if (!run || !E2B_API_KEY) {
            return null;
        }

        const next = async (): Promise<void> => {
            await enqueueJob(internal.coding_agents.execute.pollCodingAgentRun, { runId, seq: seq + 1 }, { delayMs: POLL_INTERVAL_MS });
        };

        const provider = createE2BSandboxProvider(E2B_API_KEY);

        if (!run.sandboxId || Date.now() - run.startedAt > POLL_DEADLINE_MS) {
            if (run.sandboxId) {
                await killE2BSandbox(E2B_API_KEY, run.sandboxId);
            }

            await failRun(ctx, runId, `Timed out after ${String(RUN_TIMEOUT_MS / 60_000)} minutes`);

            return null;
        }

        let sandbox: SandboxHandle;

        try {
            sandbox = await provider.connect(run.sandboxId);
        } catch {
            await failRun(ctx, runId, "The sandbox stopped before the run finished.");

            return null;
        }

        // Exact-match redaction needs the key; the GitHub token never reaches
        // the log (it lives only in the clone's `git` process), and the token
        // patterns in `redactSecrets` back that up.
        const providerKey = await loadProviderKey(ctx, run.userId, run.agent);
        const secrets = expandSecrets([providerKey]);
        let polled: Awaited<ReturnType<typeof pollRun>>;

        try {
            polled = await pollRun(sandbox, { agent: run.agent, offset: run.logOffset, secrets });
        } catch {
            // A transient read failure: try again next time; the deadline bounds it.
            await next();

            return null;
        }

        const { cancelled } = await ctx.runMutation(internal.coding_agents.functions.recordPoll, {
            offset: polled.offset,
            runId,
            ...(polled.summary !== undefined && { summary: polled.summary }),
            text: polled.text,
        });

        if (cancelled) {
            await sandbox.kill().catch(() => {});

            return null;
        }

        if (!polled.status) {
            await next();

            return null;
        }

        const outcome = await finalizeRun(sandbox, {
            agent: run.agent,
            secrets,
            status: polled.status,
            ...((polled.summary ?? run.summary) !== undefined && { summary: polled.summary ?? run.summary }),
            timeoutMs: RUN_TIMEOUT_MS,
        });

        if (outcome.error) {
            await ctx.runMutation(internal.coding_agents.functions.appendRunLog, { runId, text: `${outcome.error}\n` });
        }

        await ctx.runMutation(internal.coding_agents.functions.completeRun, { runId, ...outcome });
        await ctx.scheduler.runAfter(0, internal.coding_agents.execute.finishRun, { runId });

        return null;
    });

/**
 * The follow-ups of a finished run: the result message in its thread and a
 * waiting task round's answer. Runs once — after the PR, when one was asked for.
 */
const postFollowUps = async (ctx: RunnerCtx, runId: Id<"codingAgentRuns">): Promise<void> => {
    const run = await ctx.runQuery(internal.coding_agents.functions.getRunForFollowUp, { runId });

    if (!run) {
        return;
    }

    if (run.threadId) {
        await ctx.runMutation(internal.coding_agents.functions.postRunResult, {
            agentName: CODING_AGENTS[run.agent].label,
            runId,
            text: buildRunResultMessage(run),
            threadId: run.threadId,
            userId: run.userId,
        });
    }

    if (run.taskRunId) {
        // A verifier call: on the jobs queue; it skips a round that is already complete.
        await enqueueJob(internal.tasks.execute.finishCodingAgentRound, { codingRunId: runId });
    }
};

/**
 * Start a PR for a finished run: claim it, then launch the PR script in a fresh
 * sandbox and hand over to {@link pollPullRequest}. Seconds long; git runs in the
 * sandbox. Returns an explanation when it cannot start (and records it).
 */
const startPullRequestForRun = async (
    ctx: RunnerCtx,
    input: { followUp: boolean; runId: Id<"codingAgentRuns">; userId: string },
): Promise<{ error: string; followUpsPosted?: boolean } | { started: true }> => {
    if (!E2B_API_KEY) {
        return { error: NOT_CONFIGURED };
    }

    const claim = await ctx.runMutation(internal.coding_agents.functions.beginPullRequest, input);

    if ("error" in claim) {
        return claim;
    }

    const { runId } = input;
    const fail = async (error: string): Promise<{ error: string; followUpsPosted: boolean }> => {
        const { followUp } = await ctx.runMutation(internal.coding_agents.functions.completePullRequest, {
            log: `Could not open the pull request: ${error}\n`,
            runId,
        });

        if (followUp) {
            await postFollowUps(ctx, runId);
        }

        return { error, followUpsPosted: followUp };
    };

    const repo = parseRepoUrl(claim.repoUrl);
    const githubToken = repo.github ? await getGithubToken(ctx, input.userId).catch(() => undefined) : undefined;
    const problem = pullRequestProblem({ baseBranch: claim.baseBranch, githubToken, repo });

    if (problem || !githubToken) {
        return await fail(problem ?? "not available");
    }

    const started = await startPullRequest(
        { baseBranch: claim.baseBranch, diff: claim.diff, githubToken, repo, runId, title: pullRequestTitle(claim.prompt) },
        { sandboxes: createE2BSandboxProvider(E2B_API_KEY) },
    );

    if (!started.sandboxId || started.error) {
        return await fail(started.error ?? "the sandbox did not start");
    }

    await ctx.runMutation(internal.coding_agents.functions.setPullRequestSandbox, { runId, sandboxId: started.sandboxId });
    await ctx.runMutation(internal.coding_agents.functions.appendRunLog, { runId, text: "Opening a pull request…\n" });
    await enqueueJob(internal.coding_agents.execute.pollPullRequest, { runId, seq: claim.pollSeq }, { delayMs: POLL_INTERVAL_MS });

    return { started: true };
};

/**
 * Step 3, exactly once per run however it ended: start the PR the user asked
 * for (whose final step then posts the follow-ups), or post them now.
 */
export const finishRun = internalAction
    .input({ runId: v.id("codingAgentRuns") })
    .output(v.null())
    .action(async ({ args: { runId }, ctx }) => {
        const { claimed, wantsPr } = await ctx.runMutation(internal.coding_agents.functions.claimFinish, { runId });

        if (!claimed) {
            return null;
        }

        if (wantsPr) {
            const run = await ctx.runQuery(internal.coding_agents.functions.getRunForFollowUp, { runId });
            const pr = run ? await startPullRequestForRun(ctx, { followUp: true, runId, userId: run.userId }) : undefined;

            // Started: the PR's final step posts the follow-ups. Failed after the
            // claim: that failure already posted them. Refused before it (no key,
            // a PR already in flight from the button): they are posted here.
            if (pr && ("started" in pr || pr.followUpsPosted === true)) {
                return null;
            }
        }

        await postFollowUps(ctx, runId);

        return null;
    });

/**
 * A PR in flight, polled like a run: when the script pushed the branch, open
 * the PR through the GitHub API (the only step that talks to GitHub from here),
 * record it, and post the follow-ups that were waiting on it.
 */
export const pollPullRequest = internalAction
    .input({ runId: v.id("codingAgentRuns"), seq: v.number() })
    .output(v.null())
    .action(async ({ args: { runId, seq }, ctx }) => {
        // At-least-once delivery: only the first delivery of `seq` polls.
        if (!(await ctx.runMutation(internal.coding_agents.functions.claimPoll, { runId, seq }))) {
            return null;
        }

        const next = async (): Promise<void> => {
            await enqueueJob(internal.coding_agents.execute.pollPullRequest, { runId, seq: seq + 1 }, { delayMs: POLL_INTERVAL_MS });
        };
        const pr = await ctx.runQuery(internal.coding_agents.functions.getPullRequestForPoll, { runId });

        if (!pr || !E2B_API_KEY) {
            return null;
        }

        const complete = async (log: string, prUrl?: string): Promise<void> => {
            const { followUp } = await ctx.runMutation(internal.coding_agents.functions.completePullRequest, {
                log,
                ...(prUrl !== undefined && { prUrl }),
                runId,
            });

            if (followUp) {
                await postFollowUps(ctx, runId);
            }
        };

        if (!pr.sandboxId || Date.now() - pr.startedAt > PR_SANDBOX_TIMEOUT_MS + 60_000) {
            if (pr.sandboxId) {
                await killE2BSandbox(E2B_API_KEY, pr.sandboxId);
            }

            await complete("Could not open the pull request: timed out.\n");

            return null;
        }

        let sandbox: SandboxHandle;

        try {
            sandbox = await createE2BSandboxProvider(E2B_API_KEY).connect(pr.sandboxId);
        } catch {
            await complete("Could not open the pull request: its sandbox stopped.\n");

            return null;
        }

        const githubToken = await getGithubToken(ctx, pr.userId).catch(() => undefined);
        const secrets = expandSecrets([githubToken]);
        let check: Awaited<ReturnType<typeof checkPullRequest>>;

        try {
            check = await checkPullRequest(sandbox, { runId, secrets });
        } catch {
            await next();

            return null;
        }

        if (check.status === "pending") {
            await next();

            return null;
        }

        if (check.status === "failed") {
            await complete(`${check.log}\nCould not open the pull request: ${check.error}\n`);

            return null;
        }

        if (!githubToken) {
            await complete(`${check.log}\nCould not open the pull request: GitHub is no longer connected.\n`);

            return null;
        }

        try {
            const url = await openPullRequestForBranch(
                {
                    baseBranch: pr.baseBranch,
                    body: pullRequestBody(pr.summary),
                    branch: check.branch,
                    repo: parseRepoUrl(pr.repoUrl),
                    title: pullRequestTitle(pr.prompt),
                },
                { createPullRequest: githubPullRequestCreator(githubToken) },
            );

            await complete(`${check.log}\nOpened pull request ${url}\n`, url);
        } catch (error) {
            const message = redactSecrets(error instanceof Error ? error.message : String(error), secrets).slice(0, 1000);

            await complete(`${check.log}\nCould not open the pull request: ${message}\n`);
        }

        return null;
    });

export const killRunSandbox = internalAction
    .input({ sandboxId: v.string() })
    .output(v.null())
    .action(async ({ args }) => {
        if (E2B_API_KEY) {
            await killE2BSandbox(E2B_API_KEY, args.sandboxId);
        }

        return null;
    });

/** Fails a run nothing finished (the poll chain broke) and kills its sandbox. */
export const reapRun = internalAction
    .input({ runId: v.id("codingAgentRuns") })
    .output(v.null())
    .action(async ({ args, ctx }) => {
        const expired = await ctx.runMutation(internal.coding_agents.functions.expireRun, { runId: args.runId });

        if (!expired) {
            return null;
        }

        if (expired.sandboxId && E2B_API_KEY) {
            await killE2BSandbox(E2B_API_KEY, expired.sandboxId);
        }

        await ctx.scheduler.runAfter(0, internal.coding_agents.execute.finishRun, { runId: args.runId });

        return null;
    });

/** "Create PR" in the run view. Starts the PR and returns; the run view shows its progress in the log. */
export const createPullRequest = authAction
    .use(rateLimit("codingAgent/pr"))
    .input({ runId: v.id("codingAgentRuns") })
    .output(v.union(v.object({ started: v.literal(true) }), v.object({ error: v.string() })))
    .action(async ({ args, ctx }) => {
        const result = await startPullRequestForRun(ctx, { followUp: false, runId: args.runId, userId: ctx.user.userId });

        ctx.log.event("coding_agents.create_pull_request", { started: "started" in result });

        return "started" in result ? { started: true as const } : { error: result.error };
    });
