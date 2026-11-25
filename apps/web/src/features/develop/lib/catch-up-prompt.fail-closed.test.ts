// @vitest-environment node
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { catchUpPrompt } from "./catch-up-prompt";

const PULL = { baseBranch: "main", headBranch: "feat/x", host: "git.example", repository: "octo/hello", run: "a1b2c3d4" };

const REF_PREFIX = "refs/neore/pull-42-a1b2c3d4";

/** Git with no global or system config, so the person's hooks, signing and aliases cannot change what these commands do. */
const GIT_ENV = {
    ...process.env,
    GIT_AUTHOR_EMAIL: "test@example.invalid",
    GIT_AUTHOR_NAME: "Test",
    GIT_COMMITTER_EMAIL: "test@example.invalid",
    GIT_COMMITTER_NAME: "Test",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
};

/** The first command between backticks that starts with `prefix`, exactly as the prompt writes it. */
const commandOf = (prompt: string, prefix: string): string => {
    const command = prompt.split("`").find((part: string) => part.startsWith(prefix));

    if (command === undefined) {
        throw new Error(`no command starting with ${prefix}`);
    }

    return command;
};

/** Git through the same shell the prompt's commands run in, with each argument passed as is. */
const git = (cwd: string, ...args: string[]): string =>
    execFileSync("/bin/sh", ["-c", 'git "$@"', "git", ...args], { cwd, encoding: "utf8", env: GIT_ENV }).trim();

/** Runs one of the prompt's commands as an agent's shell would. */
const sh = (cwd: string, command: string): { output: string; status: number | null } => {
    const result = spawnSync("/bin/sh", ["-c", command], { cwd, encoding: "utf8", env: GIT_ENV });

    return { output: result.stdout, status: result.status };
};

const root = mkdtempSync(join(tmpdir(), "catch-up-fail-closed-"));

/** A checkout of an origin whose `main` is behind `feat/x`, the head of pull request 42 (`refs/pull/42/head`). */
const cloneOrigin = (name: string): string => {
    const work = join(root, name);

    git(root, "clone", "--quiet", join(root, "origin.git"), work);

    return work;
};

beforeAll(() => {
    const seed = join(root, "seed");

    git(root, "init", "--quiet", "-b", "main", seed);
    git(seed, "commit", "--quiet", "--allow-empty", "-m", "base");
    git(seed, "switch", "--quiet", "-c", "feat/x");
    git(seed, "commit", "--quiet", "--allow-empty", "-m", "change");
    git(seed, "update-ref", "refs/pull/42/head", "HEAD");
    git(seed, "switch", "--quiet", "main");
    git(seed, "commit", "--quiet", "--allow-empty", "-m", "landed on main");
    git(root, "clone", "--quiet", "--bare", seed, join(root, "origin.git"));
    git(join(root, "origin.git"), "update-ref", "refs/pull/42/head", git(seed, "rev-parse", "refs/pull/42/head"));
});

afterAll(() => {
    rmSync(root, { force: true, recursive: true });
});

describe("catchUpPrompt's fetch and switch, run against a scratch origin", () => {
    describe("for a fork", () => {
        const prompt = catchUpPrompt({ ...PULL, headInBaseRepository: false, number: 42 });
        const fetch = (): string => commandOf(prompt, "git fetch origin ");
        const switchTo = (): string => commandOf(prompt, "git switch -c <name> ").replaceAll("<name>", "pr-42-a1b2c3d4");

        it("fails the fetch as a whole when the pull request's head is gone, and then the switch makes nothing and prints no ready", () => {
            const work = cloneOrigin("fork-missing-head");

            git(join(root, "origin.git"), "update-ref", "-d", "refs/pull/42/head", git(work, "rev-parse", "origin/feat/x"));

            try {
                expect(sh(work, fetch()).status).not.toBe(0);
                expect(sh(work, switchTo()).output).toBe("");
                expect(sh(work, switchTo()).status).not.toBe(0);
                expect(git(work, "symbolic-ref", "HEAD")).toBe("refs/heads/main");
                expect(git(work, "for-each-ref", "refs/heads/pr-42-a1b2c3d4")).toBe("");
            } finally {
                git(join(root, "origin.git"), "update-ref", "refs/pull/42/head", git(work, "rev-parse", "origin/feat/x"));
            }
        });

        it("prints ready only on the new branch at the fetched head", () => {
            const work = cloneOrigin("fork-ok");

            expect(sh(work, fetch()).status).toBe(0);
            expect(sh(work, switchTo())).toStrictEqual({ output: "ready\n", status: 0 });
            expect(git(work, "rev-parse", "HEAD")).toBe(git(work, "rev-parse", `${REF_PREFIX}-head`));
            // Run again: the branch exists now, so the switch fails and nothing is ready.
            expect(sh(work, switchTo()).output).toBe("");
        });
    });

    describe("for a head in the base repository", () => {
        const prompt = catchUpPrompt({ ...PULL, headInBaseRepository: true, number: 42 });
        const fetch = (): string => commandOf(prompt, "git fetch origin ");
        const switchExisting = (): string => commandOf(prompt, "git switch --no-guess ");
        const switchNew = (): string => commandOf(prompt, "git switch -c feat/x ");
        const ready = (): string => commandOf(prompt, "[ ");

        it("fails the fetch when origin no longer has the branch", () => {
            const work = cloneOrigin("same-missing-branch");
            const missing = catchUpPrompt({ ...PULL, headBranch: "feat/gone", headInBaseRepository: true, number: 42 });

            expect(sh(work, commandOf(missing, "git fetch origin ")).status).not.toBe(0);
        });

        it("never fast-forwards the branch already checked out when the switch fails, and prints no ready", () => {
            const work = cloneOrigin("same-switch-fails");
            const main = git(work, "rev-parse", "main");

            expect(sh(work, fetch()).status).toBe(0);
            // Another linked worktree has feat/x checked out, so git refuses the switch; main is an ancestor of the head and
            // would fast-forward if the merge ran anyway.
            git(work, "worktree", "add", "--quiet", join(root, "same-other-worktree"), "-b", "feat/x", `${REF_PREFIX}-branch`);

            expect(sh(work, switchExisting()).status).not.toBe(0);
            expect(git(work, "rev-parse", "main")).toBe(main);
            expect(sh(work, ready()).output).toBe("");
        });

        it("prints no ready when the local branch has commits origin does not", () => {
            const work = cloneOrigin("same-ahead");

            expect(sh(work, fetch()).status).toBe(0);
            git(work, "branch", "feat/x", `${REF_PREFIX}-branch`);
            git(work, "switch", "--quiet", "feat/x");
            git(work, "commit", "--quiet", "--allow-empty", "-m", "local only");
            git(work, "switch", "--quiet", "main");

            expect(sh(work, switchExisting()).status).toBe(0);
            expect(sh(work, ready()).output).toBe("");
        });

        it("prints no ready on a lookalike branch for a name with a dot, at the same commit, and ready on the branch itself", () => {
            const work = cloneOrigin("same-lookalike");
            const dotted = catchUpPrompt({ ...PULL, headBranch: "release-1.x", headInBaseRepository: true, number: 42 });
            const dottedReady = commandOf(dotted, "[ ");

            // The switch to release-1.x failed and left release-1-x, a `.` apart, checked out at the pull request's head.
            git(work, "update-ref", `${REF_PREFIX}-head`, "origin/feat/x");
            git(work, "switch", "--quiet", "-c", "release-1-x", "origin/feat/x");

            expect(sh(work, dottedReady)).toStrictEqual({ output: "", status: 1 });

            git(work, "switch", "--quiet", "-c", "release-1.x", "origin/feat/x");

            expect(sh(work, dottedReady)).toStrictEqual({ output: "ready\n", status: 0 });
        });

        it("prints ready once the new branch is at the pull request's head", () => {
            const work = cloneOrigin("same-ok");

            expect(sh(work, fetch()).status).toBe(0);
            expect(sh(work, switchNew()).status).toBe(0);
            expect(sh(work, ready())).toStrictEqual({ output: "ready\n", status: 0 });
        });
    });

    describe("step 7's set-aside, for a head in the base repository", () => {
        const prompt = catchUpPrompt({ ...PULL, headInBaseRepository: true, number: 42 });
        const setAside = (name: string, lease: string): string =>
            commandOf(prompt, "git switch -c <name> && ")
                .replaceAll("<name>", () => name)
                .replaceAll("<commit from step 4>", () => lease);

        /** A clone on feat/x with one commit past origin's, as a rebase leaves it; `lease` is origin's commit step 4 recorded. */
        const rebased = (name: string): { lease: string; tip: string; work: string } => {
            const work = cloneOrigin(name);
            const lease = git(work, "rev-parse", "origin/feat/x");

            git(work, "switch", "--quiet", "feat/x");
            git(work, "commit", "--quiet", "--allow-empty", "-m", "change, rebased");

            return { lease, tip: git(work, "rev-parse", "HEAD"), work };
        };

        it.each([
            ["a name that already exists", "pr-42-a1b2c3d4", true],
            ["an invalid name", "pr-42..a1b2c3d4", false],
        ])("stops without moving the pull request's branch when the switch fails for %s", (_case: string, name: string, exists: boolean) => {
            const { lease, tip, work } = rebased(`set-aside-${exists ? "taken" : "invalid"}`);

            if (exists) {
                git(work, "branch", name, lease);
            }

            expect(sh(work, setAside(name, lease)).status).not.toBe(0);
            expect(git(work, "rev-parse", "refs/heads/feat/x")).toBe(tip);
            expect(git(work, "symbolic-ref", "HEAD")).toBe("refs/heads/feat/x");
        });

        it("moves the pull request's branch back to origin's commit once the new branch holds the rebase", () => {
            const { lease, tip, work } = rebased("set-aside-ok");

            expect(sh(work, setAside("pr-42-a1b2c3d4", lease)).status).toBe(0);
            expect(git(work, "rev-parse", "refs/heads/pr-42-a1b2c3d4")).toBe(tip);
            expect(git(work, "symbolic-ref", "HEAD")).toBe("refs/heads/pr-42-a1b2c3d4");
            expect(git(work, "rev-parse", "refs/heads/feat/x")).toBe(lease);
        });
    });

    describe("step 8's base re-check, for a head in the base repository", () => {
        const prompt = catchUpPrompt({ ...PULL, headInBaseRepository: true, number: 42 });
        const BASE = `${REF_PREFIX}-base`;

        /** A clone of an origin of its own, fetched as step 3 does, on a rebase of the branch onto the base it recorded. */
        const rebased = (name: string): { origin: string; recorded: string; work: string } => {
            const origin = join(root, `${name}.git`);

            git(root, "clone", "--quiet", "--bare", join(root, "origin.git"), origin);
            git(origin, "update-ref", "refs/pull/42/head", git(origin, "rev-parse", "refs/heads/feat/x"));

            const work = join(root, name);

            git(root, "clone", "--quiet", origin, work);

            expect(sh(work, commandOf(prompt, "git fetch origin +refs/heads/feat/x:")).status).toBe(0);

            const recorded = sh(work, commandOf(prompt, `git rev-parse ${BASE}`)).output.trim();

            git(work, "switch", "--quiet", "-c", "feat/x", recorded);
            git(work, "commit", "--quiet", "--allow-empty", "-m", "change, rebased");

            return { origin, recorded, work };
        };

        const refetchBase = (work: string): number | null => sh(work, commandOf(prompt, "git fetch origin +refs/heads/main:")).status;
        const stillHolds = (work: string, recorded: string): number | null =>
            sh(
                work,
                commandOf(prompt, "git merge-base --is-ancestor <base commit from step 3> ").replaceAll("<base commit from step 3>", () => recorded),
            ).status;
        const baseInHead = (work: string): number | null => sh(work, commandOf(prompt, `git merge-base --is-ancestor ${BASE} HEAD`)).status;

        it("fails the base check when the base was force-pushed back past the commit the rebase was built on", () => {
            const { origin, recorded, work } = rebased("base-rewritten");

            git(origin, "update-ref", "refs/heads/main", `${recorded}~1`);

            expect(refetchBase(work)).toBe(0);
            // The rebase still contains the rewound base, so the ancestry check alone would let the dropped commit into the push.
            expect(baseInHead(work)).toBe(0);
            expect(stillHolds(work, recorded)).not.toBe(0);
        });

        it("passes the base check for a base that only moved on, and the ancestry check sends the run back to rebase", () => {
            const { origin, recorded, work } = rebased("base-advanced");

            git(
                origin,
                "update-ref",
                "refs/heads/main",
                git(origin, "commit-tree", "-p", recorded, "-m", "landed later", git(origin, "show", "--no-patch", "--format=%T", recorded)),
            );

            expect(refetchBase(work)).toBe(0);
            expect(stillHolds(work, recorded)).toBe(0);
            expect(baseInHead(work)).not.toBe(0);
        });
    });

    describe("step 8's pull request re-check, for a head in the base repository", () => {
        const prompt = catchUpPrompt({ ...PULL, headInBaseRepository: true, number: 42 });
        const headCheck = (lease: string): string =>
            commandOf(prompt, "if git fetch --quiet origin +refs/pull/42/head:").replaceAll("<commit from step 4>", () => lease);

        /** A clone of an origin of its own, and the pull request's head that step 4 recorded. */
        const fetched = (name: string): { lease: string; origin: string; work: string } => {
            const origin = join(root, `${name}.git`);

            git(root, "clone", "--quiet", "--bare", join(root, "origin.git"), origin);
            git(origin, "update-ref", "refs/pull/42/head", git(origin, "rev-parse", "refs/heads/feat/x"));

            const work = join(root, name);

            git(root, "clone", "--quiet", origin, work);

            return { lease: git(origin, "rev-parse", "refs/pull/42/head"), origin, work };
        };

        it("prints same while the pull request's head is the commit step 4 recorded", () => {
            const { lease, work } = fetched("pull-unchanged");

            expect(sh(work, headCheck(lease))).toStrictEqual({ output: "same\n", status: 0 });
        });

        it("prints changed once the pull request's head moved, though origin's branch did not", () => {
            const { lease, origin, work } = fetched("pull-moved");

            git(
                origin,
                "update-ref",
                "refs/pull/42/head",
                git(origin, "commit-tree", "-p", lease, "-m", "pushed elsewhere", git(origin, "show", "--no-patch", "--format=%T", lease)),
            );

            expect(sh(work, headCheck(lease))).toStrictEqual({ output: "changed\n", status: 0 });
            expect(git(origin, "rev-parse", "refs/heads/feat/x")).toBe(lease);
        });

        it("prints changed, and nothing else, when the pull request's head can no longer be fetched", () => {
            const { lease, origin, work } = fetched("pull-gone");

            git(origin, "update-ref", "-d", "refs/pull/42/head");

            const { output } = spawnSync("/bin/sh", ["-c", headCheck(lease)], { cwd: work, encoding: "utf8", env: GIT_ENV });

            expect(output.filter(Boolean).join("")).not.toContain(origin);
            expect(sh(work, headCheck(lease))).toStrictEqual({ output: "changed\n", status: 0 });
        });
    });
});
