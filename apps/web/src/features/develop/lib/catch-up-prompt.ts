/**
 * The prompt the Catch up button puts in the composer for a pull request whose branch is behind its base. Written for the
 * coding agent (git commands and branch names read the same in any language), and the person edits it before sending.
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
        `1. Run \`git fetch origin\`, then \`git switch ${headBranch}\` (it tracks origin/${headBranch} when the branch is not local yet). If no such branch exists, the pull request comes from a fork: run \`gh pr checkout ${String(number)} --repo ${repository}\` instead, which points the branch's upstream at the fork.`,
        `2. Run \`git rebase origin/${baseBranch}\`.`,
        "3. Resolve any conflicts so the result keeps the intent of both sides: this branch's change and what landed on the base.",
        "4. Check that the build and the tests still pass, and fix what the rebase broke.",
        "5. If the branch was already pushed, push it with `git push --force-with-lease`, which goes to the branch's upstream (the fork for a fork pull request). If this environment cannot push, or the push is refused, leave the rebased commits in place and say so; do not push to any other branch.",
    ].join("\n");
