const PLAIN_BRANCH_NAME = /^[\w.][\w./-]*$/u;

const PLAIN_HOST = /^[\w.-]+$/u;

const PLAIN_REPO = /^[\w.-]+\/[\w.-]+$/u;

/**
 * A branch name made only of characters that read the same in prose and in a shell command: letters, digits, `.`, `_`, `-` and
 * `/`, not starting with `-`. Git allows more (backticks, `;`, `$`), and the host reports what the pull request's author chose,
 * so anything else gets no prompt at all rather than one an author could shape.
 */
export const isPlainBranchName = (name: string): boolean => PLAIN_BRANCH_NAME.test(name) && !name.includes("..");

/**
 * The host of a pull request's web address (`https://<host>/…`), when it is plain enough for a command: the origin check names
 * it, so an origin on another host with the same `owner/name` does not pass. `undefined` otherwise, and then no prompt is made.
 */
export const hostOfPullRequestUrl = (url: string): string | undefined => {
    const host = URL.canParse(url) ? new URL(url) : undefined;

    return host?.protocol === "https:" && PLAIN_HOST.test(host.hostname) ? host.hostname.toLowerCase() : undefined;
};

/** An `owner/name` repository made of the same plain characters, so it reads the same in prose and in a command. */
export const isPlainRepo = (repo: string): boolean => PLAIN_REPO.test(repo) && !repo.includes("..");

/**
 * The prompt the Catch up button puts in the composer for a pull request whose branch is behind its base. Written for the
 * coding agent (git commands and branch names read the same in any language), and the person edits it before sending. Every
 * ref is fetched by name: a single-branch clone has none of them until then. Each is fetched into its own flat name under
 * `refs/neore/` (`pull-<n>-head`, `pull-<n>-base`, `pull-<n>-branch`), apart from `refs/remotes/origin/`: no branch of origin can
 * overwrite one, and a stale tracking ref (`origin/release` after its branch was deleted) cannot block one (`origin/release/2.0`).
 * The names hold no branch name and nest nothing, so none is ever both a ref and a directory.
 *
 * Whether the head may be pushed is decided only by `headInBaseRepository`, the host's repository identity: a fork's branch can
 * share a name and even a commit with one of origin's. Then the only push is to `refs/heads/<headBranch>` of origin, after origin
 * is checked to be `repository` and its branch to be the pull request's head. For a fork, or a head the host no longer names, the
 * prompt holds no push at all. The steps are for an agent that runs git with the person's own access (a host-run thread, or a
 * paired device or server): a delegated cloud coding-agent run never pushes (`buildAgentPrompt`, and its run script drops the
 * credential before the agent starts), so the prompt says not to hand the steps to one. Callers pass plain names only ({@link isPlainBranchName}, {@link isPlainRepo}).
 */
export const catchUpPrompt = ({
    baseBranch,
    headBranch,
    headInBaseRepository,
    host,
    number,
    repository,
}: {
    baseBranch: string;
    headBranch: string;
    headInBaseRepository: boolean;
    /** From {@link hostOfPullRequestUrl}. */
    host: string;
    number: number;
    repository: string;
}): string => {
    const pull = String(number);
    const pullRef = `refs/neore/pull-${pull}-head`;
    const base = `refs/neore/pull-${pull}-base`;
    // Fetch and push URLs can differ (`pushurl`, `pushInsteadOf`, several URLs): each must be exactly one, and this repository.
    const checkOrigin = `1. Check that \`git remote get-url --all origin\` and \`git remote get-url --push --all origin\` each print exactly one URL, and that both are ${repository} on ${host} (ignoring case and a trailing \`.git\`). Otherwise stop and say so.`;
    // Before any fetch or switch: uncommitted changes would be carried onto the pull request's branch, and the rebase then refuses.
    const checkClean =
        "2. Run `git status --porcelain`. If it prints anything, stop without switching branches or changing any ref, and tell the person to commit or stash their work first.";
    const fetchBaseAndPull = `\`git fetch origin +refs/heads/${baseBranch}:${base}\` and the pull request's own head with \`git fetch origin +refs/pull/${pull}/head:${pullRef}\``;
    // A delegated coding-agent run clones in a sandbox, has no credential once its agent starts, and turns its result into a
    // new pull request from a diff: it can neither push this branch nor leave commits the person can reach.
    const whereToRun =
        "Run these steps yourself, in a checkout where git uses the person's own access to origin (their computer, or a device or server they paired). Do not hand them to a cloud coding agent run: it cannot push, and its result becomes a new pull request instead of updating this one.";
    const finish = [
        `5. Run \`git rebase ${base}\`.`,
        "6. Resolve any conflicts so the result keeps the intent of both sides: this branch's change and what landed on the base.",
        "7. Check that the build and the tests still pass, and fix what the rebase broke.",
    ];

    if (!headInBaseRepository) {
        return [
            `The branch ${headBranch} of ${repository}#${pull} comes from a fork and is behind ${baseBranch}. Rebase it here; it is not pushed, since origin is not where that branch lives.`,
            whereToRun,
            "",
            checkOrigin,
            checkClean,
            `3. Fetch by name, which also works in a clone of one branch: ${fetchBaseAndPull}.`,
            `4. Run \`git switch -c pr-${pull} ${pullRef}\` (if a branch pr-${pull} already exists, stop and say so).`,
            ...finish,
            `8. Leave the rebased commits on pr-${pull} and say so, for the person to bring to the fork. Do not push to any branch or remote.`,
        ].join("\n");
    }

    const head = `refs/neore/pull-${pull}-branch`;
    // The push's lease is the commit step 4 checked and recorded, not a ref: a background fetch can move `head`, and another
    // Catch up run for this pull request in the same repository or a linked worktree can move `pullRef`, after step 4.
    const leaseCommit = "<commit from step 4>";

    return [
        `The branch ${headBranch} of ${repository}#${pull} is behind ${baseBranch}. Bring it up to date.`,
        whereToRun,
        "",
        checkOrigin,
        checkClean,
        `3. Fetch by name, which also works in a clone of one branch: \`git fetch origin +refs/heads/${headBranch}:${head}\`, ${fetchBaseAndPull}.`,
        `4. If \`git rev-parse ${head}\` differs from \`git rev-parse ${pullRef}\`, stop and say so: origin's ${headBranch} is not this pull request's head right now. Otherwise record the commit \`git rev-parse ${pullRef}\` printed and say it: step 8 leases on that commit. Then run \`git switch --no-guess ${headBranch}\` (\`git switch -c ${headBranch} ${head}\` when there is no local branch of that name), then \`git merge --ff-only ${head}\`. If that fails, or \`git rev-parse HEAD\` then differs from \`git rev-parse ${head}\`, the local branch has commits origin does not: stop and say so.`,
        ...finish,
        `8. Push only this pull request's branch: \`git push --no-follow-tags --force-with-lease=refs/heads/${headBranch}:${leaseCommit} origin HEAD:refs/heads/${headBranch}\`, writing the commit you recorded in step 4 in place of ${leaseCommit}. If this environment cannot push or the push is refused, leave the rebased commits in place and say so. Do not push to any other branch or remote.`,
    ].join("\n");
};
