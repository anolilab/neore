import { stripHiddenText } from "@neore/ai/utils";
import { describe, expect, it } from "vitest";

import { catchUpPrompt, catchUpRunId, hostOfPullRequestUrl, isPlainBranchName, isPlainRepo } from "./catch-up-prompt";

const PULL = { baseBranch: "release/2.0", headBranch: "feat/x", host: "git.example", number: 42, repository: "octo/hello", run: "a1b2c3d4" };

const RUN_TAG = /^[\da-f]{8}$/u;

/** The fork branch without a run tag, as a former run named it. */
const BARE_FORK_BRANCH = /\bpr-42\b(?!-)/u;

const STEP = /^(\d)\. /u;

const GIT_COMMAND = /`(git [^`]+)`/gu;

const FETCH = /^git fetch origin \+[^:]+:(\S+)$/u;

const DELETE_REF = /^git update-ref -d (\S+)$/u;

/** The ref a push leases on, and the value it expects that ref to hold. */
const LEASE = /--force-with-lease=([^:\s]+):(\S+)/u;

const LAST_STEP = /^9\. /u;

const STEP_EIGHT_GATE = /^8\. Only once step 7 passed/u;

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

/** Every `git …` command the prompt writes between backticks, in the order it names them, with the step it is in. */
const commandsOf = (prompt: string): Command[] =>
    [...stepsOf(prompt)].flatMap(([step, text]: [number, string]) =>
        [...text.matchAll(GIT_COMMAND)].map((match: RegExpExecArray) => {
            return { command: match[1] ?? "", step };
        }),
    );

const firstIndex = (commands: Command[], prefix: string): number => commands.findIndex(({ command }: Command) => command.startsWith(prefix));

const commandsMatching = (commands: Command[], prefix: string): Command[] => commands.filter(({ command }: Command) => command.startsWith(prefix));

const fetchedRefs = (commands: Command[]): string[] => [
    ...new Set(commands.map(({ command }: Command) => FETCH.exec(command)?.[1]).filter((ref?: string) => ref !== undefined)),
];

const SAME_REPO = catchUpPrompt({ ...PULL, headInBaseRepository: true });

const FORK = catchUpPrompt({ ...PULL, headInBaseRepository: false });

describe(catchUpPrompt, () => {
    describe.each([
        ["a head in the base repository", SAME_REPO, "git switch --no-guess feat/x"],
        ["a fork", FORK, "git switch -c pr-42-a1b2c3d4 "],
    ])("for %s", (_name: string, prompt: string, firstSwitch: string) => {
        const commands = commandsOf(prompt);

        it("checks origin's fetch and push URLs, then that the checkout is clean, before any fetch or switch", () => {
            const fetch = firstIndex(commands, "git fetch ");

            expect(firstIndex(commands, "git remote get-url --all origin")).toBe(0);
            expect(firstIndex(commands, "git remote get-url --push --all origin")).toBe(1);
            expect(prompt).toContain("both are octo/hello on git.example");
            expect(firstIndex(commands, "git status --porcelain")).toBe(2);
            expect(commandsMatching(commands, "git status --porcelain")[0]?.step).toBe(2);
            expect(fetch).toBeGreaterThan(2);
            expect(firstIndex(commands, firstSwitch)).toBeGreaterThan(fetch);
        });

        it("fetches every ref by name into this run's own refs, outside origin's tracking refs", () => {
            expect(commandsMatching(commands, "git fetch ").every(({ command }: Command) => FETCH.test(command))).toBe(true);
            expect(fetchedRefs(commands).every((ref: string) => ref.startsWith("refs/neore/pull-42-a1b2c3d4-"))).toBe(true);
            expect(prompt).not.toContain("refs/remotes/origin");
        });

        it("rebases with --no-update-refs, and finishes or aborts a conflicted rebase", () => {
            // Step 8 goes back to step 5 when the base moves: that one rebase command serves the repeat too.
            expect(commandsMatching(commands, "git rebase ").map(({ command, step }: Command) => [step, command])).toEqual([
                [5, "git rebase --no-update-refs refs/neore/pull-42-a1b2c3d4-base"],
                [6, "git rebase --continue"],
                [6, "git rebase --abort"],
            ]);
        });

        it("deletes exactly the refs it fetched, last, and every stop after the fetch goes through that step", () => {
            const steps = stepsOf(prompt);
            const deleted = commands.filter(({ step }: Command) => step === 9).map(({ command }: Command) => DELETE_REF.exec(command)?.[1] ?? command);

            expect(deleted.toSorted(byName)).toEqual(fetchedRefs(commands).toSorted(byName));
            expect(prompt.split("\n").at(-1)).toMatch(LAST_STEP);

            for (const step of [4, 5, 6, 7, 8]) {
                const text = steps.get(step) ?? "";

                expect(text.match(STOP)?.length ?? 0).toBe(text.match(STOP_THROUGH_CLEANUP)?.length ?? 0);
            }

            expect([0, 1, 2].some((step: number) => steps.get(step)?.includes("step 9"))).toBe(false);
        });

        it("is stored as written: the composer strips hidden characters, and none are there", () => {
            expect(stripHiddenText(prompt).text).toBe(prompt);
        });
    });

    it("for a head in the base repository, checks the branch is the pull request's head and checks other worktrees before the switch", () => {
        const commands = commandsOf(SAME_REPO);
        const switchTo = firstIndex(commands, "git switch --no-guess feat/x");

        expect(commandsMatching(commands, "git rev-parse refs/neore/").slice(0, 2)).toEqual([
            { command: "git rev-parse refs/neore/pull-42-a1b2c3d4-branch", step: 4 },
            { command: "git rev-parse refs/neore/pull-42-a1b2c3d4-head", step: 4 },
        ]);
        expect(firstIndex(commands, "git worktree list --porcelain")).toBeLessThan(switchTo);
        expect(firstIndex(commands, "git rev-parse --show-toplevel")).toBeLessThan(switchTo);
        // Not --track: a ref outside refs/remotes is no upstream, and git refuses to track it.
        expect(commands.slice(switchTo, switchTo + 3).map(({ command }: Command) => command)).toEqual([
            "git switch --no-guess feat/x",
            "git switch -c feat/x refs/neore/pull-42-a1b2c3d4-branch",
            "git merge --ff-only refs/neore/pull-42-a1b2c3d4-branch",
        ]);
        // A local branch ahead of origin merges as "Already up to date": only comparing the commits catches it.
        expect(commands.slice(switchTo + 3, switchTo + 5).map(({ command }: Command) => command)).toEqual([
            "git rev-parse HEAD",
            "git rev-parse refs/neore/pull-42-a1b2c3d4-branch",
        ]);
        expect(firstIndex(commands, "git rebase ")).toBeGreaterThan(switchTo);
    });

    it("for a head in the base repository, pushes only its branch, after step 7 and the base re-check, on the commit step 4 recorded", () => {
        const commands = commandsOf(SAME_REPO);
        const push = firstIndex(commands, "git push");
        const stepEight = commands.filter(({ step }: Command) => step === 8).map(({ command }: Command) => command);

        expect(commandsMatching(commands, "git push")).toEqual([
            { command: "git push --no-follow-tags --force-with-lease=refs/heads/feat/x:<commit from step 4> origin HEAD:refs/heads/feat/x", step: 8 },
        ]);
        expect(stepsOf(SAME_REPO).get(8)).toMatch(STEP_EIGHT_GATE);
        // The base can move during the rebase and the checks: it is fetched again, and a moved base sends the run back to step 5.
        expect(stepEight.slice(0, 4)).toEqual([
            "git status --porcelain",
            "git fetch origin +refs/heads/release/2.0:refs/neore/pull-42-a1b2c3d4-base",
            "git merge-base --is-ancestor refs/neore/pull-42-a1b2c3d4-base HEAD",
            commands[push]?.command,
        ]);
        expect(stepsOf(SAME_REPO).get(8)).toContain("go back to step 5 once");
        // The lease is a commit, not a ref: a background fetch or another run can move this run's refs after step 4.
        const [, leasedRef, expected = ""] = LEASE.exec(commands[push]?.command ?? "") ?? [];

        expect(leasedRef).toBe("refs/heads/feat/x");
        expect(expected).not.toMatch(A_REF);
        expect(stepsOf(SAME_REPO).get(4)).toContain("step 8 leases on that commit");
        expect(SAME_REPO).toContain(`in place of ${expected}`);
    });

    it("for a fork, even one whose branch has origin's name and commit, holds no push and never touches origin's branch of that name", () => {
        const commands = commandsOf(FORK);

        expect(commandsMatching(commands, "git push")).toEqual([]);
        expect(commandsMatching(commands, "git switch")).toEqual([{ command: "git switch -c pr-42-a1b2c3d4 refs/neore/pull-42-a1b2c3d4-head", step: 4 }]);
        expect(commandsMatching(commands, "git worktree")).toEqual([]);
        expect(FORK).not.toContain("refs/heads/feat/x");
        expect(fetchedRefs(commands).toSorted(byName)).toEqual(["refs/neore/pull-42-a1b2c3d4-base", "refs/neore/pull-42-a1b2c3d4-head"]);
    });

    it("for a fork, makes a branch of this run's own, so the branch a former run left for the person does not stop the next", () => {
        const next = catchUpPrompt({ ...PULL, headInBaseRepository: false, run: "0f0f0f0f" });

        expect(commandsMatching(commandsOf(next), "git switch")[0]?.command).toBe("git switch -c pr-42-0f0f0f0f refs/neore/pull-42-0f0f0f0f-head");
        expect(next).not.toContain("pr-42-a1b2c3d4");
        expect(next).not.toMatch(BARE_FORK_BRANCH);
    });

    it("for a head named like the pull request's own ref, still pushes only that branch and keeps the pull request's head apart", () => {
        const commands = commandsOf(catchUpPrompt({ ...PULL, headBranch: "pr-42", headInBaseRepository: true }));

        expect(
            commandsMatching(commands, "git fetch ")
                .slice(0, 3)
                .map(({ command }: Command) => command),
        ).toEqual([
            "git fetch origin +refs/heads/pr-42:refs/neore/pull-42-a1b2c3d4-branch",
            "git fetch origin +refs/heads/release/2.0:refs/neore/pull-42-a1b2c3d4-base",
            "git fetch origin +refs/pull/42/head:refs/neore/pull-42-a1b2c3d4-head",
        ]);
        expect(commandsMatching(commands, "git push").map(({ command }: Command) => command)).toEqual([
            "git push --no-follow-tags --force-with-lease=refs/heads/pr-42:<commit from step 4> origin HEAD:refs/heads/pr-42",
        ]);
    });

    it("says to run the steps where git has the person's own access, not in a cloud coding agent run", () => {
        expect(stepsOf(SAME_REPO).get(0)).toContain("cloud coding agent");
        expect(stepsOf(FORK).get(0)).toContain("cloud coding agent");
    });
});

describe(catchUpRunId, () => {
    it("makes a short plain tag, new for each control, so two controls' runs fetch into refs of their own", () => {
        const first = catchUpRunId();

        expect(first).toMatch(RUN_TAG);
        expect(catchUpRunId()).not.toBe(first);
    });

    it("puts the run in every ref the prompt fetches, so two runs share none", () => {
        const fetched = (run: string): string[] =>
            [...catchUpPrompt({ ...PULL, headInBaseRepository: true, run }).matchAll(/`git fetch origin \+[^:`]+:([^`]+)`/gu)].map((match) => match[1] ?? "");

        // The base is fetched again before the push (step 8), into the same ref.
        expect(fetched("a1b2c3d4")).toEqual([
            "refs/neore/pull-42-a1b2c3d4-branch",
            "refs/neore/pull-42-a1b2c3d4-base",
            "refs/neore/pull-42-a1b2c3d4-head",
            "refs/neore/pull-42-a1b2c3d4-base",
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
