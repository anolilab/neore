import { stripHiddenText } from "@neore/ai/utils";
import { describe, expect, it } from "vitest";

import { catchUpPrompt, catchUpRunId, hostOfPullRequestUrl, isPlainBranchName, isPlainRepo } from "./catch-up-prompt";

const PULL = { baseBranch: "release/2.0", headBranch: "feat/x", host: "git.example", number: 42, repository: "octo/hello", run: "a1b2c3d4" };

const RUN_TAG = /^[\da-f]{8}$/u;

/** The fork branch without a run tag, as a former run named it. */
const BARE_FORK_BRANCH = /\bpr-42\b(?!-)/u;

const STEP = /^(\d)\. /u;

// A command is a `git …` call, or a test of what git prints (`[ "$(git …)" = … ]`).
const GIT_COMMAND = /`((?:git |\[ "\$\(git )[^`]+)`/gu;

const FETCH_FROM_ORIGIN = "git fetch origin ";

/** One forced refspec: `+<source>:<destination>`. */
const REFSPEC = /^\+[^:]+:[^:]+$/u;

const DELETE_REF = /^git update-ref -d (\S+)$/u;

/** The ref a push leases on, and the value it expects that ref to hold. */
const LEASE = /--force-with-lease=([^:\s]+):(\S+)/u;

const SET_ASIDE_AS_STEP_SEVEN = /set the rebase aside as step 7 says/gu;

/** A command that moves or deletes a branch whatever it holds. */
const FORCED_BRANCH_MOVE = /git (?:reset|branch -[fD])\b/u;

const LAST_STEP = /^9\. /u;

const STATUS = "git status --porcelain --untracked-files=all --ignore-submodules=none";

// Untracked files and submodules are listed whatever the config says, and a dirty checkout sets the rebase aside unpushed.
const STEP_EIGHT_GATE =
    /^8\. Unless `git status --porcelain --untracked-files=all --ignore-submodules=none` succeeds and prints nothing, do not push: list what it shows, set the rebase aside as step 7 says/u;

const A_REF = /^refs\//u;

const STOP = /\bstop\b/gu;

const STOP_THROUGH_CLEANUP = /do step 9, then stop\b/gu;

const byName = (left: string, right: string): number => left.localeCompare(right);

/** Each step's lines, by number; 0 holds the lines before step 1. */
const stepsOf = (prompt: string): Map<number, string> => {
    const steps = new Map<number, string>();
    let step = 0;

    for (const line of prompt.split("\n")) {
        step = Number(STEP.exec(line)?.[1] ?? step);
        steps.set(step, `${steps.get(step) ?? ""}${line}\n`);
    }

    return steps;
};

interface Command {
    readonly command: string;
    readonly step: number;
}

/** Every git command the prompt writes between backticks, in the order it names them, with the step it is in. */
const commandsOf = (prompt: string): Command[] =>
    [...stepsOf(prompt)].flatMap(([step, text]: [number, string]) =>
        [...text.matchAll(GIT_COMMAND)].map((match: RegExpExecArray) => {
            return { command: match[1] ?? "", step };
        }),
    );

const firstIndex = (commands: Command[], prefix: string): number => commands.findIndex(({ command }: Command) => command.startsWith(prefix));

const commandsMatching = (commands: Command[], prefix: string): Command[] => commands.filter(({ command }: Command) => command.startsWith(prefix));

/** A fetch of one or more forced refspecs from origin, each into a ref of its own. */
const isForcedFetch = (command: string): boolean =>
    command.startsWith(FETCH_FROM_ORIGIN) &&
    command
        .slice(FETCH_FROM_ORIGIN.length)
        .split(" ")
        .every((refspec: string) => REFSPEC.test(refspec));

/** The refs a fetch writes: the destination of each of its refspecs. */
const destinationsOf = (fetch: string): string[] =>
    fetch
        .slice(FETCH_FROM_ORIGIN.length)
        .split(" ")
        .map((refspec: string) => refspec.split(":", 2)[1] ?? "");

const fetchedRefs = (commands: Command[]): string[] => [
    ...new Set(commands.filter(({ command }: Command) => isForcedFetch(command)).flatMap(({ command }: Command) => destinationsOf(command))),
];

const SAME_REPO = catchUpPrompt({ ...PULL, headInBaseRepository: true });

const FORK = catchUpPrompt({ ...PULL, headInBaseRepository: false });

describe(catchUpPrompt, () => {
    // Only a run that pushes checks where origin pushes to: a fork's run fetches from origin and never pushes.
    describe.each([
        [
            "a head in the base repository",
            SAME_REPO,
            "git switch --no-guess feat/x",
            ["git remote get-url --all origin", "git remote get-url --push --all origin"],
        ],
        ["a fork", FORK, "git switch -c <name> ", ["git remote get-url --all origin"]],
    ])("for %s", (_name: string, prompt: string, firstSwitch: string, originReads: string[]) => {
        const commands = commandsOf(prompt);

        it("checks origin's URLs, then that the checkout is clean, before any fetch or switch", () => {
            const fetch = firstIndex(commands, "git fetch ");
            const clean = originReads.length;

            expect(originReads.map((read: string) => firstIndex(commands, read))).toEqual(originReads.map((_read: string, index: number) => index));
            expect(stepsOf(prompt).get(1)).toContain("`match`");
            expect(commandsMatching(commands, "git status ")[0]).toEqual({ command: STATUS, step: 2 });
            expect(firstIndex(commands, "git status ")).toBe(clean);
            expect(fetch).toBeGreaterThan(clean);
            expect(firstIndex(commands, firstSwitch)).toBeGreaterThan(fetch);
        });

        it("fetches every ref by name into this run's own refs, outside origin's tracking refs", () => {
            expect(commandsMatching(commands, "git fetch ").every(({ command }: Command) => isForcedFetch(command))).toBe(true);
            expect(fetchedRefs(commands).every((ref: string) => ref.startsWith("refs/worktree/neore/pull-42-a1b2c3d4-"))).toBe(true);
            expect(prompt).not.toContain("refs/remotes/origin");
        });

        it("rebases with --no-update-refs, and finishes or aborts a conflicted rebase", () => {
            // Step 8 goes back to step 5 when the base moves: that one rebase command serves the repeat too.
            expect(commandsMatching(commands, "git rebase ").map(({ command, step }: Command) => [step, command])).toEqual([
                [5, "git rebase --no-update-refs refs/worktree/neore/pull-42-a1b2c3d4-base"],
                [6, "git rebase --continue"],
                [6, "git rebase --abort"],
            ]);
        });

        it("stops before any rebase when the pull request's head has merge commits, and suggests merging the base", () => {
            const merges = commandsMatching(commands, "git rev-list --merges ");

            expect(merges).toEqual([
                { command: "git rev-list --merges refs/worktree/neore/pull-42-a1b2c3d4-base..refs/worktree/neore/pull-42-a1b2c3d4-head", step: 4 },
            ]);
            expect(commands.indexOf(merges[0] as Command)).toBeLessThan(firstIndex(commands, firstSwitch));
            expect(stepsOf(prompt).get(4)).toContain("do not rebase: do step 9, then stop");
            expect(stepsOf(prompt).get(4)).toContain("suggest merging release/2.0 into it instead");
            expect(prompt).not.toContain("--rebase-merges");
        });

        it("deletes exactly the refs it fetched, last, and every stop after the fetch goes through that step", () => {
            const steps = stepsOf(prompt);
            const deleted = commands.filter(({ step }: Command) => step === 9).map(({ command }: Command) => DELETE_REF.exec(command)?.[1] ?? command);

            expect(deleted.toSorted(byName)).toEqual(fetchedRefs(commands).toSorted(byName));
            expect(prompt.split("\n").at(-1)).toMatch(LAST_STEP);

            for (const step of [3, 4, 5, 6, 7, 8]) {
                const text = steps.get(step) ?? "";

                expect(text.match(STOP)?.length ?? 0).toBe(text.match(STOP_THROUGH_CLEANUP)?.length ?? 0);
            }

            expect([0, 1, 2].some((step: number) => steps.get(step)?.includes("step 9"))).toBe(false);
        });

        it("prints none of origin's URLs: each URL list goes through a filter that prints only match or mismatch", () => {
            const urlReads = commands.filter(
                ({ command }: Command) => command.includes("get-url") || command.startsWith("git remote") || command.startsWith("git config"),
            );

            expect(urlReads.map(({ command, step }: Command) => [step, command.split(" | ", 1)[0]])).toEqual(originReads.map((read: string) => [1, read]));

            for (const { command } of urlReads) {
                expect(command.split(" | ").at(-1)).toContain('print (n == 1 && !bad) ? "match" : "mismatch"');
                expect(command).toContain("awk -v h='git.example' -v r='octo/hello'");
            }
        });

        it("is stored as written: the composer strips hidden characters, and none are there", () => {
            expect(stripHiddenText(prompt).text).toBe(prompt);
        });
    });

    it("for a head in the base repository, checks the branch is the pull request's head and checks other worktrees before the switch", () => {
        const commands = commandsOf(SAME_REPO);
        const switchTo = firstIndex(commands, "git switch --no-guess feat/x");

        expect(commandsMatching(commands, "git rev-parse refs/worktree/neore/").slice(0, 3)).toEqual([
            { command: "git rev-parse refs/worktree/neore/pull-42-a1b2c3d4-base", step: 3 },
            { command: "git rev-parse refs/worktree/neore/pull-42-a1b2c3d4-branch", step: 4 },
            { command: "git rev-parse refs/worktree/neore/pull-42-a1b2c3d4-head", step: 4 },
        ]);
        expect(firstIndex(commands, "git worktree list --porcelain")).toBeLessThan(switchTo);
        expect(firstIndex(commands, "git rev-parse --show-toplevel")).toBeLessThan(switchTo);
        // Not --track: a ref outside refs/remotes is no upstream, and git refuses to track it.
        // The fast-forward runs only once the switch succeeded: a failed switch must not move the branch already checked out.
        expect(commands.slice(switchTo - 1, switchTo + 2).map(({ command }: Command) => command)).toEqual([
            "git show-ref --verify --quiet refs/heads/feat/x",
            "git switch --no-guess feat/x && git merge --ff-only refs/worktree/neore/pull-42-a1b2c3d4-branch",
            "git switch -c feat/x refs/worktree/neore/pull-42-a1b2c3d4-branch",
        ]);
        // A local branch ahead of origin merges as "Already up to date", and a failed switch leaves another branch checked
        // out: only checking the branch and the commit HEAD holds catches both, and the rebase waits for that check.
        expect(commands[switchTo + 2]?.command).toBe(
            '[ "$(git symbolic-ref -q HEAD)" = "refs/heads/feat/x" ] && [ "$(git rev-parse --verify -q HEAD)" = "$(git rev-parse --verify -q refs/worktree/neore/pull-42-a1b2c3d4-head)" ] && echo ready',
        );
        expect(firstIndex(commands, "git rebase ")).toBe(switchTo + 3);
    });

    it("for a head in the base repository, pushes only its branch, after step 7 and the base re-check, on the commit step 4 recorded", () => {
        const commands = commandsOf(SAME_REPO);
        const push = firstIndex(commands, "git push");
        const stepEight = commands.filter(({ step }: Command) => step === 8).map(({ command }: Command) => command);

        expect(commandsMatching(commands, "git push")).toEqual([
            { command: "git push --no-follow-tags --force-with-lease=refs/heads/feat/x:<commit from step 4> origin HEAD:refs/heads/feat/x", step: 8 },
        ]);
        expect(stepsOf(SAME_REPO).get(8)).toMatch(STEP_EIGHT_GATE);
        // The base can move during the rebase and the checks: it is fetched again; a base that no longer holds the commit the
        // rebase was built on (recorded in step 3) stops the run, and one that only moved on sends it back to step 5.
        expect(stepEight.slice(0, 6)).toEqual([
            STATUS,
            "git fetch origin +refs/heads/release/2.0:refs/worktree/neore/pull-42-a1b2c3d4-base",
            "git merge-base --is-ancestor <base commit from step 3> refs/worktree/neore/pull-42-a1b2c3d4-base",
            "git merge-base --is-ancestor refs/worktree/neore/pull-42-a1b2c3d4-base HEAD",
            "git rev-parse refs/worktree/neore/pull-42-a1b2c3d4-base",
            commands[push]?.command,
        ]);
        expect(commandsMatching(commands, "git rev-parse refs/worktree/neore/pull-42-a1b2c3d4-base")[0]?.step).toBe(3);
        expect(stepsOf(SAME_REPO).get(8)).toContain("go back to step 5 once");
        // The lease is a commit, not a ref: a background fetch or another run can move this run's refs after step 4.
        const [, leasedRef, expected = ""] = LEASE.exec(commands[push]?.command ?? "") ?? [];

        expect(leasedRef).toBe("refs/heads/feat/x");
        expect(expected).not.toMatch(A_REF);
        expect(stepsOf(SAME_REPO).get(4)).toContain("step 8 leases on that commit");
        expect(SAME_REPO).toContain(`in place of ${expected}`);
    });

    it("for a head in the base repository, re-reads the pull request's head ref, and its state and base through a signed-in CLI, right before the push, and without one does not push", () => {
        const step = stepsOf(SAME_REPO).get(8) ?? "";
        const inBackticks = step.split("`").filter((_part: string, index: number) => index % 2 === 1);
        const headCheck = inBackticks.find((part: string) => part.startsWith("if git fetch --quiet origin +refs/pull/42/head:")) ?? "";
        const signedIn = inBackticks.find((part: string) => part.startsWith("gh auth status ")) ?? "";
        const view = inBackticks.find((part: string) => part.startsWith("gh pr view ")) ?? "";
        const order = [headCheck, signedIn, view, "git push "].map((part: string) => step.indexOf(`\`${part}`));

        expect(headCheck).toBe(
            'if git fetch --quiet origin +refs/pull/42/head:refs/worktree/neore/pull-42-a1b2c3d4-head 2>/dev/null && [ "$(git rev-parse --verify -q refs/worktree/neore/pull-42-a1b2c3d4-head)" = "<commit from step 4>" ]; then echo same; else echo changed; fi',
        );
        // Quiet: the status's output (account, token scopes) goes nowhere, only one word is printed.
        expect(signedIn).toBe("gh auth status --hostname git.example >/dev/null 2>&1 && echo signed-in || echo none");
        // Open, on the same base and head; a failed read prints `changed` too, so it stops the push.
        expect(view).toBe(
            'gh pr view 42 --repo git.example/octo/hello --json state,baseRefName,headRefName --jq \'if .state == "OPEN" and .baseRefName == "release/2.0" and .headRefName == "feat/x" then "same" else "changed" end\' 2>/dev/null || echo changed',
        );
        expect(order.every((index: number) => index > 0)).toBe(true);
        expect(order).toEqual(order.toSorted((left: number, right: number) => left - right));
        // Fail closed: anything but `signed-in` (a missing CLI prints `none` too) stops before the push and sets the rebase aside.
        const signedInAt = step.indexOf(`\`${signedIn}\``);
        const noCli = step.slice(signedInAt, step.indexOf(`\`${view}\``));

        expect(noCli).toContain("Unless it prints `signed-in`, do not push");
        expect(noCli).toContain("set the rebase aside as step 7 says");
        expect(noCli).toContain("do step 9, then stop");
        expect(noCli).not.toContain("git push");
        expect(step).not.toContain("go on");
        expect(FORK).not.toContain("gh ");
        expect(FORK).not.toContain("echo same");
    });

    it("for a head in the base repository, a run that does not push sets its rebase aside and puts the branch back on origin's commit", () => {
        const commands = commandsOf(SAME_REPO);
        const steps = stepsOf(SAME_REPO);
        const stepSeven = commands.filter(({ step }: Command) => step === 7).map(({ command }: Command) => command);

        // A branch of this run's own, numbered past any that exists, then the pull request's branch moved back only while it
        // still holds exactly the commits just set aside: the next run's fast-forward from origin's tip then works.
        expect(stepSeven).toEqual([
            "git show-ref --verify --quiet refs/heads/<name>",
            // One chain: the pull request's branch moves only once the new branch exists, is checked out and holds its commit.
            'git switch -c <name> && [ "$(git symbolic-ref -q HEAD)" = "refs/heads/<name>" ] && [ "$(git rev-parse --verify -q HEAD)" = "$(git rev-parse --verify -q refs/heads/feat/x)" ] && echo ready && git update-ref refs/heads/feat/x <commit from step 4> refs/heads/<name>',
            // Where the rebase is left when that chain fails.
            "git branch --show-current",
        ]);
        expect(steps.get(7)).toContain("If it fails at any point, do not move feat/x in any other way: leave the rebase where it is");
        expect(steps.get(7)).toContain("start with pr-42-a1b2c3d4,");
        expect(commands.filter(({ command }: Command) => command.includes("git update-ref refs/heads/"))).toHaveLength(1);
        // A dirty checkout, a failed re-fetch, a rewritten base, the base moving twice, a moved pull request head, no signed-in
        // CLI, a closed or retargeted pull request and a refused push all set the rebase aside the same way.
        expect(steps.get(8)?.match(SET_ASIDE_AS_STEP_SEVEN)).toHaveLength(8);
        expect(steps.get(6)).toContain("as step 7 says");
        expect(SAME_REPO).not.toContain("leave the rebased commits in place");
        expect(SAME_REPO).not.toMatch(FORCED_BRANCH_MOVE);
    });

    it("for a fork, checks only origin's fetch URL, so a checkout that pushes elsewhere still catches up", () => {
        const forkReads = commandsOf(FORK).filter(({ command }: Command) => command.includes("get-url"));

        expect(forkReads.map(({ command }: Command) => command.split(" | ", 1)[0])).toEqual(["git remote get-url --all origin"]);
        expect(FORK).not.toContain("--push --all");
        expect(commandsOf(SAME_REPO).some(({ command }: Command) => command.startsWith("git remote get-url --push --all origin"))).toBe(true);
    });

    it("for a fork, even one whose branch has origin's name and commit, holds no push and never touches origin's branch of that name", () => {
        const commands = commandsOf(FORK);

        expect(commandsMatching(commands, "git push")).toEqual([]);
        expect(commandsMatching(commands, "git switch")).toEqual([
            {
                command:
                    'git switch -c <name> refs/worktree/neore/pull-42-a1b2c3d4-head && [ "$(git symbolic-ref -q HEAD)" = "refs/heads/<name>" ] && [ "$(git rev-parse --verify -q HEAD)" = "$(git rev-parse --verify -q refs/worktree/neore/pull-42-a1b2c3d4-head)" ] && echo ready',
                step: 4,
            },
        ]);
        expect(commandsMatching(commands, "git worktree")).toEqual([]);
        expect(FORK).not.toContain("refs/heads/feat/x");
        expect(fetchedRefs(commands).toSorted(byName)).toEqual(["refs/worktree/neore/pull-42-a1b2c3d4-base", "refs/worktree/neore/pull-42-a1b2c3d4-head"]);
    });

    it("for a fork, makes a branch of this run's own, so the branch a former run left for the person does not stop the next", () => {
        const next = catchUpPrompt({ ...PULL, headInBaseRepository: false, run: "0f0f0f0f" });

        expect(stepsOf(next).get(4)).toContain("start with pr-42-0f0f0f0f,");
        expect(next).not.toContain("pr-42-a1b2c3d4");
        expect(next).not.toMatch(BARE_FORK_BRANCH);
    });

    it("for a fork, numbers past a branch that already exists, so retrying the same control does not stop, and names the branch it chose", () => {
        const commands = commandsOf(FORK);
        const stepFour = stepsOf(FORK).get(4) ?? "";

        // The existence check comes before the branch is made, and takes the next number instead of stopping.
        expect(firstIndex(commands, "git show-ref --verify --quiet refs/heads/<name>")).toBeLessThan(firstIndex(commands, "git switch -c <name> "));
        expect(stepFour).toContain("try pr-42-a1b2c3d4-2, pr-42-a1b2c3d4-3 and so on");
        expect(stepFour).not.toContain("already exists");
        expect(stepsOf(FORK).get(8)).toContain("the branch you chose in step 4");
    });

    it("for a head named like the pull request's own ref, still pushes only that branch and keeps the pull request's head apart", () => {
        const commands = commandsOf(catchUpPrompt({ ...PULL, headBranch: "pr-42", headInBaseRepository: true }));

        expect(commandsMatching(commands, "git fetch ")[0]?.command).toBe(
            "git fetch origin +refs/heads/pr-42:refs/worktree/neore/pull-42-a1b2c3d4-branch +refs/heads/release/2.0:refs/worktree/neore/pull-42-a1b2c3d4-base +refs/pull/42/head:refs/worktree/neore/pull-42-a1b2c3d4-head",
        );
        expect(commandsMatching(commands, "git push").map(({ command }: Command) => command)).toEqual([
            "git push --no-follow-tags --force-with-lease=refs/heads/pr-42:<commit from step 4> origin HEAD:refs/heads/pr-42",
        ]);
    });

    it.each([
        ["a head in the base repository", SAME_REPO],
        ["a fork", FORK],
    ])("for %s, fetches every ref in one command that stops the run when it fails, before any switch or rebase", (_name: string, prompt: string) => {
        const commands = commandsOf(prompt);

        expect(commandsMatching(commands, "git fetch ").filter(({ step }: Command) => step === 3)).toHaveLength(1);
        expect(stepsOf(prompt).get(3)).toContain("If it fails, do step 9, then stop");
        expect(commandsMatching(commands, "git switch").every(({ command }: Command) => !command.includes("git fetch"))).toBe(true);
    });

    it("says to run the steps where git has the person's own access, not in a cloud coding agent run", () => {
        expect(stepsOf(SAME_REPO).get(0)).toContain("cloud coding agent");
        expect(stepsOf(FORK).get(0)).toContain("cloud coding agent");
    });
});

describe(catchUpRunId, () => {
    it("makes a short plain tag", () => {
        expect(catchUpRunId()).toMatch(RUN_TAG);
    });

    it("puts the run in every ref the prompt fetches, so two runs share none", () => {
        const fetched = (run: string): string[] =>
            [...catchUpPrompt({ ...PULL, headInBaseRepository: true, run }).matchAll(/`(git fetch origin [^`]+)`/gu)].flatMap((match) =>
                destinationsOf(match[1] ?? ""),
            );

        // The base is fetched again before the push (step 8), into the same ref.
        expect(fetched("a1b2c3d4")).toEqual([
            "refs/worktree/neore/pull-42-a1b2c3d4-branch",
            "refs/worktree/neore/pull-42-a1b2c3d4-base",
            "refs/worktree/neore/pull-42-a1b2c3d4-head",
            "refs/worktree/neore/pull-42-a1b2c3d4-base",
        ]);
        expect(fetched("0f0f0f0f").filter((ref) => fetched("a1b2c3d4").includes(ref))).toEqual([]);
    });
});

describe(isPlainBranchName, () => {
    it.each(["main", "release/2.0", "feat/thread-pr-catch-up", "user_1/fix.v2"])("takes %s", (name) => {
        expect(isPlainBranchName(name)).toBe(true);
    });

    it.each(["main`; rm -rf ~ #", "a$(id)", "x;y", "-delete", "a..b", "with space", "", "feat\u{200B}/x", "feat/x\u{202E}", "f\u{EB}at"])(
        "refuses %j",
        (name) => {
            expect(isPlainBranchName(name)).toBe(false);
        },
    );
});

describe(isPlainRepo, () => {
    it.each(["octo/hello", "my-org/repo.js", "a_b/c-d"])("takes %s", (repo) => {
        expect(isPlainRepo(repo)).toBe(true);
    });

    it.each(["octo", "octo/hello/extra", "octo/hello`; id", "../x", "octo/hel lo"])("refuses %j", (repo) => {
        expect(isPlainRepo(repo)).toBe(false);
    });
});

describe(hostOfPullRequestUrl, () => {
    it("reads the host of an https address", () => {
        expect(hostOfPullRequestUrl("https://Git.Example/octo/hello/pull/7")).toBe("git.example");
    });

    it.each(["ssh://git.example/octo/hello", "not a url", "https://[::1]/x"])("refuses %j", (url) => {
        expect(hostOfPullRequestUrl(url)).toBeUndefined();
    });
});
