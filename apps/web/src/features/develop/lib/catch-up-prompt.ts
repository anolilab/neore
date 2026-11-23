const PLAIN_BRANCH_NAME = /^[\w.][\w./-]*$/u;

/**
 * A branch name made only of characters that read the same in prose and in a shell command: letters, digits, `.`, `_`, `-` and
 * `/`, not starting with `-`. Git allows more (backticks, `;`, `$`), and the host reports what the pull request's author chose,
 * so anything else gets no prompt at all rather than one an author could shape.
 */
export const isPlainBranchName = (name: string): boolean => PLAIN_BRANCH_NAME.test(name) && !name.includes("..");

/**
 * The prompt the Catch up button puts in the composer for a pull request whose branch is behind its base. Written for the
 * coding agent (git commands and branch names read the same in any language), and the person edits it before sending. Every
 * ref is fetched by name: a single-branch clone has none of them until then. The head is pushed only when origin's branch of that
 * name is the pull request's own head: a fork's branch may share its name. Callers pass plain names only
 * ({@link isPlainBranchName}).
 */
export const catchUpPrompt = ({
    baseBranch,
    headBranch,
    number,
    repository,
}: {
    baseBranch: string;
    headBranch: string;
    number: number;
    repository: string;
}): string =>
    [
        `The branch ${headBranch} of ${repository}#${String(number)} is behind ${baseBranch}. Bring it up to date:`,
        "",
        `1. Fetch by name, which also works in a clone of one branch: \`git fetch origin +refs/heads/${baseBranch}:refs/remotes/origin/${baseBranch}\`, then the pull request's own head with \`git fetch origin +refs/pull/${String(number)}/head:refs/remotes/origin/pr-${String(number)}\`.`,
        `2. Run \`git fetch origin +refs/heads/${headBranch}:refs/remotes/origin/${headBranch}\`. If it succeeds and \`git rev-parse origin/${headBranch}\` equals \`git rev-parse origin/pr-${String(number)}\`, this is the pull request's branch: run \`git switch ${headBranch}\`, then \`git merge --ff-only origin/${headBranch}\` (if that fails, the local branch has commits origin does not: stop and say so). Otherwise the pull request comes from a fork, even when origin has a branch of the same name: run \`git switch -c pr-${String(number)} origin/pr-${String(number)}\` and do not push in step 6.`,
        `3. Run \`git rebase origin/${baseBranch}\`.`,
        "4. Resolve any conflicts so the result keeps the intent of both sides: this branch's change and what landed on the base.",
        "5. Check that the build and the tests still pass, and fix what the rebase broke.",
        `6. Push with \`git push --force-with-lease origin HEAD:${headBranch}\`. If this environment cannot push, the push is refused, or the pull request comes from a fork, leave the rebased commits in place and say so; do not push to any other branch.`,
    ].join("\n");
