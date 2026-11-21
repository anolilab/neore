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
import { COMMIT_SHA, isImportablePath, listRepoRuleFiles as listFiles, readRepoRuleFiles as readFiles } from "../source-control/repo-rule-files";
import type { RepoAddress } from "../source-control/repo-rule-files";
import { vFailed } from "../source-control/validators";
import type { Id } from "../_generated/dataModel";
import type { ActionCtx } from "../_generated/server";
import { MAX_RULE_FILES } from "./rule-file-limits";

const vRepoArgs = { projectId: v.id("projects"), repoId: v.id("projectRepositories") };

/** A repository the host this app reads does not hold: nothing to read it with. */
const vUnsupported = v.object({ status: v.literal("unsupported_host") });

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

/** The instruction files the repository holds at one commit, by path and size, and whether a tree was cut; none read yet. */
export const listRepoRuleFiles = authAction
    .use(rateLimit("sourceControl/read"))
    .input(vRepoArgs)
    .output(
        v.union(
            v.object({
                commit: v.optional(v.string()),
                files: v.array(
                    v.object({
                        path: v.string().max(MAX_LENGTH.long),
                        refused: v.optional(v.literal("link")),
                        size: v.number(),
                        tooLarge: v.boolean(),
                    }),
                ),
                status: v.literal("ok"),
                truncated: v.boolean(),
            }),
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
        const outcome = await readFromHost(DEVELOP_DRIVER, token, async (request) => listFiles(request, address));

        ctx.log.event("projects.rule_files.repo_list", {
            count: outcome.status === "ok" ? outcome.files.length : 0,
            status: outcome.status,
            truncated: outcome.status === "ok" && outcome.truncated,
        });

        return outcome;
    });

/**
 * The text of the picked files at the commit their listing read (`commit`), at most a project's worth, taken only from
 * what that commit's listing holds (listed again, under this repository); a file that is gone, too large, not listed or
 * a refused link says so instead.
 */
export const readRepoRuleFiles = authAction
    .use(rateLimit("sourceControl/read"))
    .input({ ...vRepoArgs, commit: v.string().max(64), paths: v.array(v.string().max(MAX_LENGTH.long)).max(MAX_RULE_FILES) })
    .output(
        v.union(
            v.object({
                files: v.array(
                    v.union(
                        v.object({ path: v.string(), status: v.union(v.literal("missing"), v.literal("refused"), v.literal("too_large")) }),
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
        if (args.paths.some((path) => !isImportablePath(path))) {
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
        const outcome = await readFromHost(DEVELOP_DRIVER, token, async (request) => {
            return { files: await readFiles(request, address, args.commit, [...new Set(args.paths)]) };
        });

        ctx.log.event("projects.rule_files.repo_read", {
            read: outcome.status === "ok" ? outcome.files.filter((file) => file.status === "ok").length : 0,
            requested: args.paths.length,
            status: outcome.status,
        });

        return outcome;
    });
