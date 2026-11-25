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

/** A run tag for {@link catchUpPrompt}: eight hex digits, so its refs read short and differ from another control's run. */
export const catchUpRunId = (): string => crypto.randomUUID().replaceAll("-", "").slice(0, 8);

/**
 * A command that checks one of origin's URL lists without printing any URL. A URL passes only in one of three forms, so a fetch
 * or push cannot go through another transport or service on the same host: `https://[userinfo@]host[:443]/repository`,
 * `ssh://git@host[:22]/repository` or the scp-like `git@host:repository`, each with an optional `.git` and trailing `/`, and
 * with host and repository compared ignoring case. Another scheme (`http://`, `git://`, `file://`), another port, another ssh
 * user or a path prints `mismatch`, as does a list that does not hold exactly one URL. `host` and `repo` are plain
 * ({@link isPlainRepo}), so they read the same inside the quotes.
 */
const originCheck = (list: string, host: string, repo: string): string =>
    String.raw`git remote get-url ${list} origin | awk -v h='${host}' -v r='${repo.toLowerCase()}' '{ n++; u = tolower($0); sub(/\/+$/, "", u); sub(/\.git$/, "", u); if (sub(/^https:\/\/([^@\/]*@)?/, "", u)) ok = (u == h "/" r) || (u == h ":443/" r); else if (sub(/^ssh:\/\/git@/, "", u)) ok = (u == h "/" r) || (u == h ":22/" r); else if (sub(/^git@/, "", u)) ok = (u == h ":" r); else ok = 0; if (!ok) bad++ } END { print (n == 1 && !bad) ? "match" : "mismatch" }'`;

/**
 * A command that prints `ready` only when `HEAD` is the branch `branch` (not detached, not another branch) and holds exactly the
 * commit `commitRef` names. It fails closed: a missing ref, a failed switch or a different commit print nothing. Both are
 * compared as whole strings, never as patterns: a `.` in a branch name would match any character, and a failed switch would
 * then pass on a lookalike branch (`release-1x` for `release-1.x`) at the same commit.
 */
const onBranchAt = (branch: string, commitRef: string): string =>
    `[ "$(git symbolic-ref -q HEAD)" = "refs/heads/${branch}" ] && [ "$(git rev-parse --verify -q HEAD)" = "$(git rev-parse --verify -q ${commitRef})" ] && echo ready`;

/** How a run picks a local branch of its own: `local`, or the first of `local-2`, `local-3`, … that does not exist yet. */
const chooseBranch = (local: string): string =>
    `choose the branch name: start with ${local}, and while \`git show-ref --verify --quiet refs/heads/<name>\` succeeds for it, try ${local}-2, ${local}-3 and so on.`;

/** The pull request {@link catchUpPrompt} is for, with plain names only. */
interface CatchUpPromptInput {
    baseBranch: string;
    headBranch: string;
    headInBaseRepository: boolean;
    /** From {@link hostOfPullRequestUrl}. */
    host: string;
    number: number;
    repository: string;
    /** One per mounted control ({@link catchUpRunId}): repeated clicks give the same text, which the composer adds once. */
    run: string;
}

/**
 * The prompt the Catch up button puts in the composer for a pull request whose branch is behind its base. Written for the
 * coding agent (git commands and branch names read the same in any language), and the person edits it before sending. Every
 * ref is fetched by name: a single-branch clone has none of them until then. Each is fetched into its own flat name under
 * `refs/worktree/neore/` (`pull-<n>-<run>-head`, `-base`, `-branch`), apart from `refs/remotes/origin/`: no branch of origin can
 * overwrite one, and a stale tracking ref (`origin/release` after its branch was deleted) cannot block one (`origin/release/2.0`).
 * Git keeps `refs/worktree/` apart for each linked worktree, so the same prompt run in two of them fetches, rebases on and
 * deletes refs of its own: one run's clean-up never deletes the other's base. The names hold no branch name and nest nothing, so
 * none is ever both a ref and a directory. `run` is one per mounted Catch up control, so a second click puts the same text in the
 * composer and its duplicate check skips it; the forced fetches never replace a ref of the person's own, and the last step
 * deletes them again.
 *
 * Whether the head may be pushed is decided only by `headInBaseRepository`, the host's repository identity: a fork's branch can
 * share a name and even a commit with one of origin's. Then the only push is to `refs/heads/<headBranch>` of origin, after origin
 * is checked to be `repository` and its branch to be the pull request's head. For a fork, or a head the host no longer names, the
 * prompt holds no push at all. The steps are for an agent that runs git with the person's own access (a host-run thread, or a
 * paired device or server): a delegated cloud coding-agent run never pushes (`buildAgentPrompt`, and its run script drops the
 * credential before the agent starts), so the prompt says not to hand the steps to one. A branch with merge commits is not rebased
 * at all (a rebase drops them, and any conflict resolution made in one): the prompt stops and suggests merging the base. A
 * rebase that stops on a conflict is continued or aborted, one that stops for any other reason (a failing hook) is aborted, and
 * an abort counts only once HEAD is back on the commit it started from: a rebase is never left half done, and nothing is pushed unless the build and the tests pass and every fix is
 * committed. Callers pass plain names only ({@link isPlainBranchName}, {@link isPlainRepo}, and a `run` of letters and digits).
 */
export const catchUpPrompt = ({ baseBranch, headBranch, headInBaseRepository, host, number, repository, run }: CatchUpPromptInput): string => {
    const pull = String(number);
    const refPrefix = `refs/worktree/neore/pull-${pull}-${run}`;
    const pullRef = `${refPrefix}-head`;
    const base = `${refPrefix}-base`;
    // A URL can hold the person's credential (`https://<user>:<token>@host/…`), and what a command prints stays in the session's
    // transcript, so no URL is ever printed: the filter reads each one and prints only `match` or `mismatch`.
    const doNotPrintUrls =
        "Do not print origin's URLs any other way (remote -v, get-url on its own, or the remote's config): they can hold the person's credentials.";
    // Fetch and push URLs can differ (`pushurl`, `pushInsteadOf`, several URLs). A run that pushes needs both to be exactly one
    // URL of this repository; a fork's run never pushes, so only where it fetches from matters there.
    const checkOriginToPush = `1. Run \`${originCheck("--all", host, repository)}\` and \`${originCheck("--push --all", host, repository)}\`. Each prints only \`match\` or \`mismatch\`; unless both print \`match\`, stop and say so. ${doNotPrintUrls}`;
    const checkOriginToFetch = `1. Run \`${originCheck("--all", host, repository)}\`. It prints only \`match\` or \`mismatch\`; unless it prints \`match\`, stop and say so. ${doNotPrintUrls}`;
    // Before any fetch or switch: uncommitted changes would be carried onto the pull request's branch, and the rebase then refuses.
    // The flags override `status.showUntrackedFiles` and `diff.ignoreSubmodules`, which can hide untracked files or a changed
    // submodule; a failed status says nothing, so only a status that succeeds with no output counts as clean.
    const status = "git status --porcelain --untracked-files=all --ignore-submodules=none";
    const checkClean = `2. Run \`${status}\`. If it fails or prints anything, stop without switching branches or changing any ref, and tell the person to commit or stash their work first.`;
    const cleanAfterChecks = `\`${status}\` succeeds and prints nothing`;
    // One fetch for every ref: it fails as a whole when any of them cannot be fetched, and then nothing after it runs.
    const fetchRefs = (refspecs: string[], then = ""): string =>
        `3. Fetch by name, which also works in a clone of one branch: run \`git fetch origin ${refspecs.join(" ")}\`. If it fails, do step 9, then stop and say so: do not switch branches or rebase with refs a failed fetch left out.${then}`;
    const baseAndPull = [`+refs/heads/${baseBranch}:${base}`, `+refs/pull/${pull}/head:${pullRef}`];
    // A delegated coding-agent run clones in a sandbox, has no credential once its agent starts, and turns its result into a
    // new pull request from a diff: it can neither push this branch nor leave commits the person can reach.
    const whereToRun =
        "Run these steps yourself, in a checkout where git uses the person's own access to origin (their computer, or a device or server they paired). Do not hand them to a cloud coding agent run: it cannot push, and its result becomes a new pull request instead of updating this one.";
    // Every stop from the fetch (step 3) on still deletes what it fetched: the refs are this run's alone.
    const stopAfterFetch = "do step 9, then stop and say so";
    // A plain rebase drops merge commits, and with them any conflict resolution made only in one. Rewriting with
    // `--rebase-merges` can still lose those resolutions, so a branch with merges is not rewritten at all.
    const checkMerges = `If \`git rev-list --merges ${base}..${pullRef}\` prints anything, do not rebase: do step 9, then stop and tell the person that the branch has merge commits, which a rebase would drop along with any conflict resolutions made in them, so Catch up does not rewrite it; suggest merging ${baseBranch} into it instead.`;
    // `--no-update-refs` overrides a `rebase.updateRefs` setting: other local branches pointing into these commits stay where they are.
    // Step 8 loops back here when the base moves, so the repeat rebase gets it too.
    // `onFailedChecks` says where the rebased commits go when step 7 stops; `onAbortedRepeat`, when a repeat rebase from step 8
    // is aborted and leaves the first one checked out.
    // A rebase can fail without starting (a `pre-rebase` hook, a ref it cannot read): then no rebase is in progress, nothing was
    // rebased, and step 7 must not check and report the unchanged commits as rebased. It can also stop with a rebase in progress
    // and nothing left to resolve (a hook failing during `--continue`): that one is aborted, never left half done. `--git-path`
    // finds the rebase state in a linked worktree too, whose `.git` is a file.
    // `branch` is the branch the rebase runs on, written as the prompt names it.
    const finish = (branch: string, onFailedChecks: string, onAbortedRepeat?: string): string[] => {
        const startCommit = "<start commit from step 5>";
        const rebaseState = (name: string): string => `"$(git rev-parse --git-path ${name})"`;
        const inRebase = `test -d ${rebaseState("rebase-merge")} || test -d ${rebaseState("rebase-apply")}`;
        // The abort counts only once no rebase is in progress and HEAD is the branch again, on the commit it held before step 5.
        const abort = `git rebase --abort && ! test -d ${rebaseState("rebase-merge")} && ! test -d ${rebaseState("rebase-apply")} && ${onBranchAt(branch, startCommit)}`;
        const afterAbort = `${onAbortedRepeat === undefined ? "" : `${onAbortedRepeat}, `}${stopAfterFetch}`;

        return [
            `5. Record the commit \`git rev-parse HEAD\` prints as the start commit. Run \`git rebase --no-update-refs ${base}\`. If it fails and \`${inRebase}\` fails too, no rebase started: say git's error, ${afterAbort}. If it fails with a rebase in progress, go to step 6. Go on to step 7 only once the rebase has completed.`,
            `6. While \`git diff --name-only --diff-filter=U\` lists files, the rebase stopped on a conflict: resolve it so the result keeps the intent of both sides: this branch's change and what landed on the base. Stage the resolved files with \`git add\` and run \`git rebase --continue\`, and repeat for each later conflict until the rebase completes. If a conflict cannot be resolved, or the rebase or \`git rebase --continue\` fails while that lists no file (a hook failed, or git stopped for another reason), abort: run \`${abort}\` as one command, with the commit you recorded in step 5 in place of ${startCommit}${branch === "<name>" ? " and the branch you chose in step 4 in place of <name>" : ""}. Unless it prints \`ready\`, the checkout may still be mid-rebase: run nothing else in it, tell the person to look at \`git status\` there, ${stopAfterFetch}. Otherwise say git's error (never a URL), ${afterAbort}.`,
            `7. Check that the build and the tests still pass. Fix what the rebase broke and commit each fix on this branch. If the build or the tests still fail, do not push: ${onFailedChecks}, ${stopAfterFetch}.`,
        ];
    };
    // Last, and also on any stop from step 3 on: the refs are this run's alone, and nothing reads them once the run is over.
    const cleanUp = (refs: string[]): string =>
        `9. Whether the steps finished or you stopped at step 3 or any step after it, delete the refs this run fetched (a failed fetch may have left some out): ${refs.map((ref) => `\`git update-ref -d ${ref}\``).join(", ")}.`;

    if (!headInBaseRepository) {
        // Named for this run, then numbered past any branch that already exists: a retry of the same control (same run) or a
        // branch a former run left for the person to carry to the fork never stops this one.
        const local = `pr-${pull}-${run}`;

        return [
            `The branch ${headBranch} of ${repository}#${pull} comes from a fork and is behind ${baseBranch}. Rebase it here; it is not pushed, since origin is not where that branch lives.`,
            whereToRun,
            "",
            checkOriginToFetch,
            checkClean,
            fetchRefs(baseAndPull),
            // Branches are shared by every linked worktree: one checked out in another already exists here too. The rebase runs on
            // whatever is checked out, so it waits until HEAD is shown to be the new branch on the pull request's head.
            `4. ${checkMerges} Otherwise ${chooseBranch(local)} Then run \`git switch -c <name> ${pullRef} && ${onBranchAt("<name>", pullRef)}\` with the name you chose in place of <name>. Unless it prints \`ready\`, do not rebase: ${stopAfterFetch}.`,
            ...finish("<name>", "leave the rebased commits in place"),
            `8. Leave the rebased commits on the branch you chose in step 4 and say so, naming that branch, for the person to bring to the fork. Do not push to any branch or remote. Unless ${cleanAfterChecks}, also list what it shows and tell the person to commit what belongs to the change on that branch and remove the rest.`,
            cleanUp([base, pullRef]),
        ].join("\n");
    }

    const head = `${refPrefix}-branch`;
    // The push's lease is the commit step 4 checked and recorded, not a ref: a background fetch can move `head`, and step 8's
    // fetch of the pull request's head moves `pullRef`, after step 4.
    const leaseCommit = "<commit from step 4>";
    // The base the rebase is built on. The base's next fetch (step 8) must still hold it: a base force-pushed back past it would
    // leave the rebase carrying commits the base no longer has, and the ancestry check alone would let them into the push.
    const baseCommit = "<base commit from step 3>";
    // Git refuses to switch to a branch another linked worktree has checked out; this run does not reach into that worktree.
    // The pull request can move on while the rebase and the checks run: its head pushed by someone else, or the request
    // retargeted or closed. The lease only guards origin's branch, so step 8 reads the request's own head ref again (git alone),
    // and its state and base through the host's CLI. Without a signed-in CLI nothing confirms the request is still open on its
    // base, so the run fails closed: no push, the rebase set aside. Each prints only `same`, `changed`, `signed-in` or `none`.
    const headUnchanged = `if git fetch --quiet origin +refs/pull/${pull}/head:${pullRef} 2>/dev/null && [ "$(git rev-parse --verify -q ${pullRef})" = "${leaseCommit}" ]; then echo same; else echo changed; fi`;
    const hostCliSignedIn = `gh auth status --hostname ${host} >/dev/null 2>&1 && echo signed-in || echo none`;
    const requestUnchanged = `gh pr view ${pull} --repo ${host}/${repository} --json state,baseRefName,headRefName --jq 'if .state == "OPEN" and .baseRefName == "${baseBranch}" and .headRefName == "${headBranch}" then "same" else "changed" end' 2>/dev/null || echo changed`;
    // Without a signed-in CLI the person pushes the set-aside branch themselves. The rebase rewrote the branch, so a plain push
    // is refused as non-fast-forward; the lease on the commit step 4 recorded refuses it, too, once origin's branch moved on.
    // The command names the remote `origin`, never a URL.
    const manualPush = `git push --no-follow-tags --force-with-lease=refs/heads/${headBranch}:${leaseCommit} origin refs/heads/<name>:refs/heads/${headBranch}`;
    const checkOtherWorktree = `Then run \`git worktree list --porcelain\`: if it shows \`branch refs/heads/${headBranch}\` under a \`worktree\` path other than this checkout's (\`git rev-parse --show-toplevel\`), do step 9, then stop and tell the person to run Catch up from that worktree, naming its path.`;

    // A run that does not push must not leave the rebase on the pull request's branch: the next run's step 4 fast-forwards from origin's tip
    // and stops on a branch origin does not have. Step 4 made sure the branch held only origin's commit, so moving it back to
    // that commit drops nothing: the rebase and any fixes stay on a branch of this run's own, and `update-ref` moves the branch
    // only while it still holds exactly what was set aside. No reset, no `branch -f`: nothing else may move it. The move is chained
    // on the new branch: unless the switch made it, HEAD is on it and it holds the pull request's branch's commit, the pull
    // request's branch stays where it is, holding the rebase, and nothing else moves it.
    const setAside = `set the rebase aside, so ${headBranch} is back on origin's commit and the next Catch up starts from it: ${chooseBranch(`pr-${pull}-${run}`)} Run \`git switch -c <name> && ${onBranchAt("<name>", `refs/heads/${headBranch}`)} && git update-ref refs/heads/${headBranch} ${leaseCommit} refs/heads/<name>\` as one command, with the name you chose in place of <name> and the commit you recorded in step 4 in place of ${leaseCommit}. If it fails at any point, do not move ${headBranch} in any other way: leave the rebase where it is, say which branch holds it (\`git branch --show-current\`), do step 9, then stop. Otherwise name the branch that now holds the rebase`;

    return [
        `The branch ${headBranch} of ${repository}#${pull} is behind ${baseBranch}. Bring it up to date.`,
        whereToRun,
        "",
        checkOriginToPush,
        checkClean,
        fetchRefs(
            [`+refs/heads/${headBranch}:${head}`, ...baseAndPull],
            ` Then record the commit \`git rev-parse ${base}\` prints and say it: the rebase is built on that base, and step 8 checks the base still holds it.`,
        ),
        `4. If \`git rev-parse ${head}\` differs from \`git rev-parse ${pullRef}\`, ${stopAfterFetch}: origin's ${headBranch} is not this pull request's head right now. ${checkMerges} Otherwise record the commit \`git rev-parse ${pullRef}\` printed and say it: step 8 leases on that commit. ${checkOtherWorktree} Otherwise, if \`git show-ref --verify --quiet refs/heads/${headBranch}\` succeeds, run \`git switch --no-guess ${headBranch} && git merge --ff-only ${head}\`; if not, run \`git switch -c ${headBranch} ${head}\`. Then run \`${onBranchAt(headBranch, pullRef)}\`. Unless it prints \`ready\`, the switch failed or the local branch has commits origin does not; do not rebase: ${stopAfterFetch}.`,
        ...finish(headBranch, setAside, "and if you came back here from step 8, set the rebase aside as step 7 says"),
        // The base can move during the rebase and the checks: a push onto the base fetched in step 3 would leave the branch behind again.
        // A checkout left dirty by the checks is not pushed, and the rebase is set aside: left on the pull request's branch, the
        // next Catch up's step 4 would stop on a branch origin does not have. The set-aside's switch carries the changes along.
        `8. Unless ${cleanAfterChecks}, do not push: list what it shows, set the rebase aside as step 7 says, and tell the person to commit what belongs to the change on the branch that now holds the rebase and remove the rest; ${stopAfterFetch}. Otherwise run \`git fetch origin +refs/heads/${baseBranch}:${base}\` again. If that fetch fails, do not push: set the rebase aside as step 7 says; ${stopAfterFetch}. Run \`git merge-base --is-ancestor ${baseCommit} ${base}\`, writing the base commit you recorded in place of ${baseCommit}. If it fails, the base's history was rewritten (force-pushed) and the rebase holds commits the base no longer has: do not push and do not rebase again; set the rebase aside as step 7 says and say that the base's history was rewritten; ${stopAfterFetch}. If \`git merge-base --is-ancestor ${base} HEAD\` fails, the base moved on: record the commit \`git rev-parse ${base}\` prints now as the base commit in place of the one from step 3, and go back to step 5 once. If it has moved again when you are back here, do not push: set the rebase aside as step 7 says and say that another Catch up is needed; ${stopAfterFetch}. Otherwise check the pull request itself before pushing: run \`${headUnchanged}\`, writing the commit you recorded in step 4 in place of ${leaseCommit}. Unless it prints \`same\`, do not push: the pull request's head moved or could not be read; set the rebase aside as step 7 says; ${stopAfterFetch}. Then run \`${hostCliSignedIn}\`. Unless it prints \`signed-in\`, do not push: without a signed-in \`gh\` nothing can confirm the pull request is still open on ${baseBranch}; set the rebase aside as step 7 says, and tell the person in a few lines which local branch now holds the rebase, and that once they have checked the pull request is still open on ${baseBranch} they can push it to ${headBranch} themselves with \`${manualPush}\`, written out with that branch in place of <name> and the commit you recorded in step 4 in place of ${leaseCommit}: a plain push is refused because the rebase rewrote the branch's commits, and the lease refuses this one too if ${headBranch} moved on origin since step 4. They run it, not you. Or they sign in to \`gh\` and run Catch up again; ${stopAfterFetch}. Otherwise run \`${requestUnchanged}\`; unless that prints \`same\`, do not push: the pull request was closed, merged or retargeted, or could not be read; set the rebase aside as step 7 says; ${stopAfterFetch}. Then push only this pull request's branch: \`git push --no-follow-tags --force-with-lease=refs/heads/${headBranch}:${leaseCommit} origin HEAD:refs/heads/${headBranch}\`, writing the commit you recorded in step 4 in place of ${leaseCommit}. If this environment cannot push or the push is refused, set the rebase aside as step 7 says and say so. Do not push to any other branch or remote.`,
        cleanUp([head, base, pullRef]),
    ].join("\n");
};
