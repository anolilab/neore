/**
 * The prompt the Catch up button puts in the composer for a pull request whose branch is behind its base. Written for the
 * coding agent (git commands and branch names read the same in any language), and the person edits it before sending.
 */
export const catchUpPrompt = ({ baseBranch, number, repository }: { baseBranch: string; number: number; repository: string }): string =>
    [
        `The branch of ${repository}#${String(number)} is behind ${baseBranch}. Bring it up to date:`,
        "",
        `1. Run \`git fetch origin\`, then \`git rebase origin/${baseBranch}\`.`,
        "2. Resolve any conflicts so the result keeps the intent of both sides: this branch's change and what landed on the base.",
        "3. Check that the build and the tests still pass, and fix what the rebase broke.",
        "4. If the branch was already pushed, push it with `git push --force-with-lease`.",
    ].join("\n");
