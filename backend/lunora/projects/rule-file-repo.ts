/**
 * Rule files imported from one of the project's repositories: what its root and rules folder hold at one commit
 * (`listRepoRuleFiles`), then the text of the files the person picked, at that commit (`readRepoRuleFiles`). Actions, because they
 * call the host; with the person's own connector token, so the host decides what they may read. Only whoever may save
 * the project's rule files may import, for a repository the project lists (`repoForRuleFileImport`). Nothing is
 * stored: the editor turns the text into unsaved drafts with the upload import's rules. Only counts are logged.
 */
import { LunoraError, v } from "lunorash/server";

import { internal } from "../_generated/internal";
import { parseRepoUrl } from "../coding-agents/commands";
import { resolveGithubToken } from "../connectors/lib/github-token";
import { authAction, rateLimit } from "../lib/crpc";
import { MAX_LENGTH } from "../lib/validators";
import { DEVELOP_DRIVER } from "../source-control/develop-driver";
import { readFromHost } from "../source-control/read-host";
import {
    COMMIT_SHA,
    fetchBudget,
    FetchBudgetSpent,
    isImportablePath,
    listRepoRuleFiles as listFiles,
    readRepoRuleFiles as readFiles,
    repoReadLedger,
} from "../source-control/repo-rule-files";
import type { RepoAddress } from "../source-control/repo-rule-files";
import { vFailed } from "../source-control/validators";
import type { Id } from "../_generated/dataModel";
import type { ActionCtx } from "../_generated/server";
import { MAX_RULE_FILES } from "./rule-file-limits";

const vRepoArgs = { projectId: v.id("projects"), repoId: v.id("projectRepositories") };

/** A repository the host this app reads does not hold: nothing to read it with. */
const vUnsupported = v.object({ status: v.literal("unsupported_host") });

/**
 * A listing whose own walk ran out of the action's host requests (redirect hops and a 401's repeat spent them): a retry
 * meets the same redirects, so it is told apart from the host's error.
 */
const vBudgetSpent = v.object({ status: v.literal("budget_spent") });

/** The repository's address on the host, or `null` for one elsewhere; a project or repository the caller may not import from is NOT_FOUND. */
const addressFor = async (
    ctx: Pick<ActionCtx, "runQuery">,
    userId: string,
    { projectId, repoId }: { projectId: Id<"projects">; repoId: Id<"projectRepositories"> },
): Promise<RepoAddress | null> => {
    const repo = await ctx.runQuery(internal.projects.functions.repoForRuleFileImport, { projectId, repoId, userId });

    if (!repo) {
        throw new LunoraError("NOT_FOUND", "Repository not found");
    }

    const { github } = parseRepoUrl(repo.url);

    return github ? { name: github.repo, owner: github.owner, ...(repo.defaultBranch && { ref: repo.defaultBranch }) } : null;
};

/**
 * The instruction files the repository holds at one commit, by path, size and the blob a read takes (a link followed
 * with the path it leads to, one not followed with why), whether a tree was cut, and how many of the rules folder's
 * files are past the listing's cap; none read yet. At most `HOST_FETCHES_PER_IMPORT` host requests, a 401's repeat included:
 * a walk they cut short is `budget_spent`.
 */
export const listRepoRuleFiles = authAction
    .use(rateLimit("sourceControl/read"))
    .input(vRepoArgs)
    .output(
        v.union(
            v.object({
                commit: v.optional(v.string()),
                files: v.array(
                    v.object({
                        linkOf: v.optional(v.string().max(MAX_LENGTH.long)),
                        path: v.string().max(MAX_LENGTH.long),
                        refused: v.optional(
                            v.union(v.literal("broken"), v.literal("budget"), v.literal("outside"), v.literal("too_deep"), v.literal("too_long")),
                        ),
                        sha: v.optional(v.string()),
                        size: v.number(),
                        tooLarge: v.boolean(),
                    }),
                ),
                omitted: v.optional(v.number()),
                status: v.literal("ok"),
                truncated: v.boolean(),
            }),
            vBudgetSpent,
            vFailed,
            vUnsupported,
        ),
    )
    .action(async ({ args, ctx }) => {
        const address = await addressFor(ctx, ctx.user.userId, args);

        if (!address) {
            return { status: "unsupported_host" as const };
        }

        const token = await resolveGithubToken(ctx, ctx.user.userId);
        // One budget for both tries: a 401's repeat spends what the first left.
        const budgeted = fetchBudget();
        // Links past the budget are listed `budget`; a walk the budget cuts short (redirect hops spent it) lists nothing
        // it can stand by, so it is `budget_spent`, never a thrown error: trying again meets the same redirects.
        const outcome = await readFromHost(DEVELOP_DRIVER, token, async (request) => listFiles(budgeted(request), address)).catch((error: unknown) => {
            if (error instanceof FetchBudgetSpent) {
                return { status: "budget_spent" as const };
            }

            throw error;
        });

        ctx.log.event("projects.rule_files.repo_list", {
            count: outcome.status === "ok" ? outcome.files.length : 0,
            omitted: outcome.status === "ok" ? (outcome.omitted ?? 0) : 0,
            status: outcome.status,
            truncated: outcome.status === "ok" && outcome.truncated,
        });

        return outcome;
    });

/**
 * The text of the picked files at the commit their listing read (`commit`), at most a project's worth, taken only from
 * what that commit's listing holds (listed again, under this repository: each by the blob SHA its listing gave, a link's
 * only when followed again it ends there); a file that is gone, too large, not listed or a refused link says so instead, and one past the
 * action's `HOST_FETCHES_PER_IMPORT` host requests (a 401's repeat included) is `not_read`.
 */
export const readRepoRuleFiles = authAction
    .use(rateLimit("sourceControl/read"))
    .input({
        ...vRepoArgs,
        commit: v.string().max(64),
        files: v.array(v.object({ path: v.string().max(MAX_LENGTH.long), sha: v.optional(v.string().max(64)) })).max(MAX_RULE_FILES),
    })
    .output(
        v.union(
            v.object({
                files: v.array(
                    v.union(
                        v.object({
                            path: v.string(),
                            status: v.union(v.literal("missing"), v.literal("not_read"), v.literal("refused"), v.literal("too_large")),
                        }),
                        v.object({ path: v.string(), status: v.literal("ok"), text: v.string() }),
                    ),
                ),
                status: v.literal("ok"),
            }),
            vFailed,
            vUnsupported,
        ),
    )
    .action(async ({ args, ctx }) => {
        // Only paths a listing can offer: the import reads instruction files, never anything else in the repository.
        if (args.files.some(({ path }) => !isImportablePath(path))) {
            throw new LunoraError("BAD_REQUEST", "Only a repository's instruction files can be imported");
        }

        // A commit SHA only, never a branch: the read takes the files the listing listed.
        if (!COMMIT_SHA.test(args.commit)) {
            throw new LunoraError("BAD_REQUEST", "A commit SHA is required");
        }

        const address = await addressFor(ctx, ctx.user.userId, args);

        if (!address) {
            return { status: "unsupported_host" as const };
        }

        const token = await resolveGithubToken(ctx, ctx.user.userId);
        // Each path once.
        const picks = [...new Map(args.files.map((file) => [file.path, file])).values()];
        // One budget for both tries, requests and bytes: a 401's repeat spends what the first left, and reuses its blobs.
        const budgeted = fetchBudget();
        const ledger = repoReadLedger();
        const outcome = await readFromHost(DEVELOP_DRIVER, token, async (request) => {
            return { files: await readFiles(budgeted(request), address, args.commit, picks, ledger) };
        });

        ctx.log.event("projects.rule_files.repo_read", {
            notRead: outcome.status === "ok" ? outcome.files.filter((file) => file.status === "not_read").length : 0,
            read: outcome.status === "ok" ? outcome.files.filter((file) => file.status === "ok").length : 0,
            requested: args.files.length,
            status: outcome.status,
        });

        return outcome;
    });
