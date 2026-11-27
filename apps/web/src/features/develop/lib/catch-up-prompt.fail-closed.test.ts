// @vitest-environment node
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { catchUpPrompt } from "./catch-up-prompt";

const PULL = { baseBranch: "main", headBranch: "feat/x", host: "git.example", repository: "octo/hello", run: "a1b2c3d4" };

const REF_PREFIX = "refs/worktree/neore/pull-42-a1b2c3d4";

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

/** The same, with what the command writes to stderr. */
const shAll = (cwd: string, command: string): { status: number | null; stderr: string; stdout: string } => {
    const result = spawnSync("/bin/sh", ["-c", command], { cwd, encoding: "utf8", env: GIT_ENV });

    return { status: result.status, stderr: result.stderr, stdout: result.stdout };
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

            // Back to the commit feat/x branched from, so a merge that ran anyway would fast-forward main.
            git(work, "reset", "--quiet", "--hard", "HEAD~1");

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

    describe("step 2's clean check, the run's refs and step 5's rebase, for a head in the base repository", () => {
        const prompt = catchUpPrompt({ ...PULL, headInBaseRepository: true, number: 42 });
        const status = (): string => commandOf(prompt, "git status ");

        it.each([
            ["status.showUntrackedFiles", "no"],
            ["status.showUntrackedFiles", "normal"],
        ])("lists an untracked file in a new folder under %s=%s", (key: string, value: string) => {
            const work = cloneOrigin(`clean-${value}`);

            git(work, "config", key, value);
            mkdirSync(join(work, "out"));
            writeFileSync(join(work, "out", "result.txt"), "");

            expect(sh(work, status())).toStrictEqual({ output: "?? out/result.txt\n", status: 0 });
        });

        it("fetches into refs of each linked worktree's own, so one run's clean-up leaves the other's base", () => {
            const work = cloneOrigin("refs-worktree");
            const other = join(root, "refs-worktree-linked");
            const base = `${REF_PREFIX}-base`;

            git(work, "worktree", "add", "--quiet", "--detach", other);

            expect(sh(work, commandOf(prompt, "git fetch origin ")).status).toBe(0);
            expect(sh(other, commandOf(prompt, "git fetch origin ")).status).toBe(0);
            expect(sh(work, `git update-ref -d ${base}`).status).toBe(0);
            expect(git(other, "rev-parse", base)).toBe(git(other, "rev-parse", "origin/main"));
        });

        it("tells a rebase a hook refused, which started nothing, from one that stopped on a conflict", () => {
            const work = cloneOrigin("rebase-refused");
            const started = commandOf(prompt, "test -d ");

            expect(sh(work, commandOf(prompt, "git fetch origin ")).status).toBe(0);
            git(work, "switch", "--quiet", "-c", "feat/x", `${REF_PREFIX}-branch`);
            writeFileSync(join(work, ".git", "hooks", "pre-rebase"), "#!/bin/sh\nexit 1\n");
            chmodSync(join(work, ".git", "hooks", "pre-rebase"), 0o755);

            expect(sh(work, commandOf(prompt, "git rebase --no-update-refs ")).status).not.toBe(0);
            expect(sh(work, started).status).not.toBe(0);

            rmSync(join(work, ".git", "hooks", "pre-rebase"));
            git(work, "commit", "--quiet", "--allow-empty", "-m", "local");
            git(work, "-c", "sequence.editor=sed -i 1s/^pick/edit/", "rebase", "--quiet", "-i", "HEAD~1");

            expect(sh(work, started).status).toBe(0);
        });
    });

    describe.each([
        ["a head in the base repository", true, "feat/x"],
        ["a fork", false, "pr-42-a1b2c3d4"],
    ])("step 6's abort, for %s", (_name: string, inBase: boolean, branch: string) => {
        const prompt = catchUpPrompt({ ...PULL, headInBaseRepository: inBase, number: 42 });
        const started = (): string => commandOf(prompt, "test -d ");
        const conflicted = (): string => commandOf(prompt, "git diff --name-only --diff-filter=U");
        const abort = (start: string): string =>
            commandOf(prompt, "git rebase --abort && ")
                .replaceAll("<start commit from step 5>", () => start)
                .replaceAll("<name>", () => branch);

        /**
         * A linked worktree (whose `.git` is a file) on `branch` with a change to `file.txt` that conflicts with the base,
         * mid-rebase onto it after the conflict was resolved and staged; `start` is the commit HEAD held before step 5.
         */
        const resolvedConflict = (name: string): { start: string; work: string } => {
            const seed = join(root, `${name}-seed`);

            git(root, "init", "--quiet", "-b", "main", seed);
            writeFileSync(join(seed, "file.txt"), "base\n");
            git(seed, "add", "file.txt");
            git(seed, "commit", "--quiet", "-m", "base");
            git(seed, "switch", "--quiet", "-c", branch);
            writeFileSync(join(seed, "file.txt"), "change\n");
            git(seed, "commit", "--quiet", "-am", "change");
            git(seed, "switch", "--quiet", "main");
            writeFileSync(join(seed, "file.txt"), "landed\n");
            git(seed, "commit", "--quiet", "-am", "landed on main");
            git(seed, "update-ref", "refs/pull/42/head", branch);
            git(seed, "update-ref", "refs/heads/feat/x", branch);

            const work = join(root, name);

            git(seed, "worktree", "add", "--quiet", "--detach", work);
            git(work, "update-ref", `${REF_PREFIX}-base`, "main");
            git(work, "switch", "--quiet", branch);

            const start = git(work, "rev-parse", "HEAD");

            expect(sh(work, `${commandOf(prompt, "git rebase --no-update-refs ")} >/dev/null 2>&1`).status).not.toBe(0);
            expect(sh(work, started()).status).toBe(0);
            expect(sh(work, conflicted()).output).toBe("file.txt\n");

            writeFileSync(join(work, "file.txt"), "landed\nchange\n");
            git(work, "add", "file.txt");

            return { start, work };
        };

        // The rebase runs `prepare-commit-msg` when it commits the resolved files; `pre-commit` it skips.
        it("aborts a rebase whose continue a hook failed, back on the start commit", () => {
            const { start, work } = resolvedConflict(`abort-hook-${branch.replaceAll("/", "-")}`);
            const hook = join(git(work, "rev-parse", "--git-common-dir"), "hooks", "prepare-commit-msg");

            writeFileSync(hook, "#!/bin/sh\nexit 1\n");
            chmodSync(hook, 0o755);

            // The continue fails with the rebase in progress and nothing left to resolve: neither the conflict loop nor "no
            // rebase started" applies.
            expect(sh(work, "GIT_EDITOR=true git rebase --continue >/dev/null 2>&1").status).not.toBe(0);
            expect(sh(work, started()).status).toBe(0);
            expect(sh(work, conflicted()).output).toBe("");

            expect(sh(work, `${abort(start)} 2>/dev/null`)).toStrictEqual({ output: "ready\n", status: 0 });
            expect(sh(work, started()).status).not.toBe(0);
            expect(git(work, "symbolic-ref", "HEAD")).toBe(`refs/heads/${branch}`);
            expect(git(work, "rev-parse", "HEAD")).toBe(start);
        });

        it("prints no ready when HEAD is not the start commit after the abort", () => {
            const { work } = resolvedConflict(`abort-elsewhere-${branch.replaceAll("/", "-")}`);
            const elsewhere = git(work, "rev-parse", "main");

            expect(sh(work, `${abort(elsewhere)} 2>/dev/null`).output).toBe("");
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

            // Git's own error names the remote, whose URL can hold the person's credential: it goes nowhere.
            expect(shAll(work, headCheck(lease))).toStrictEqual({ status: 0, stderr: "", stdout: "changed\n" });
        });
    });

    describe("step 8's hand-off without a signed-in CLI, for a head in the base repository", () => {
        const prompt = catchUpPrompt({ ...PULL, headInBaseRepository: true, number: 42 });
        const handOff = (name: string, lease: string): string =>
            commandOf(prompt, "git push --no-follow-tags --force-with-lease=refs/heads/feat/x:<commit from step 4> origin refs/heads/<name>:")
                .replaceAll("<name>", () => name)
                .replaceAll("<commit from step 4>", () => lease);

        /**
         * A clone of an origin of its own whose `feat/x` the rebase rewrote, set aside on `pr-42-a1b2c3d4` as step 7 leaves it:
         * the rebase is not a fast-forward of origin's branch. `lease` is origin's commit that step 4 recorded.
         */
        const setAside = (name: string): { lease: string; origin: string; rebase: string; work: string } => {
            const origin = join(root, `${name}.git`);

            git(root, "clone", "--quiet", "--bare", join(root, "origin.git"), origin);

            const work = join(root, name);

            git(root, "clone", "--quiet", origin, work);

            const lease = git(work, "rev-parse", "origin/feat/x");

            git(work, "switch", "--quiet", "-c", "pr-42-a1b2c3d4", "origin/main");
            git(work, "commit", "--quiet", "--allow-empty", "-m", "change, rebased");

            return { lease, origin, rebase: git(work, "rev-parse", "HEAD"), work };
        };

        it("pushes the set-aside branch to the pull request's branch while origin's is still at the commit step 4 recorded, which a plain push cannot", () => {
            const { lease, origin, rebase, work } = setAside("hand-off-unchanged");

            // The rebase rewrote the branch: a push without the lease is refused as non-fast-forward.
            expect(sh(work, "git push --quiet origin refs/heads/pr-42-a1b2c3d4:refs/heads/feat/x 2>/dev/null").status).not.toBe(0);
            expect(sh(work, handOff("pr-42-a1b2c3d4", lease)).status).toBe(0);
            expect(git(origin, "rev-parse", "refs/heads/feat/x")).toBe(rebase);
        });

        it("is refused, and leaves origin's branch alone, once origin's branch moved after step 4", () => {
            const { lease, origin, work } = setAside("hand-off-moved");
            const moved = git(origin, "commit-tree", "-p", lease, "-m", "pushed elsewhere", git(origin, "show", "--no-patch", "--format=%T", lease));

            git(origin, "update-ref", "refs/heads/feat/x", moved);
            // The person's checkout has fetched since, so its tracking ref no longer stands in for the recorded commit.
            git(work, "fetch", "--quiet", "origin");

            expect(sh(work, `${handOff("pr-42-a1b2c3d4", lease)} 2>/dev/null`).status).not.toBe(0);
            expect(git(origin, "rev-parse", "refs/heads/feat/x")).toBe(moved);
        });
    });

    describe("step 8's signed-in check, for a head in the base repository", () => {
        const signedIn = commandOf(catchUpPrompt({ ...PULL, headInBaseRepository: true, number: 42 }), "gh auth status ");

        /** The check with only a stand-in `gh` that exits with `status` on the path, or no `gh` at all. */
        const withGh = (name: string, status?: number): { output: string; status: number | null } => {
            const bin = join(root, name);

            mkdirSync(bin);

            if (status !== undefined) {
                writeFileSync(join(bin, "gh"), `#!/bin/sh\necho account-details\nexit ${String(status)}\n`);
                chmodSync(join(bin, "gh"), 0o755);
            }

            const result = spawnSync("/bin/sh", ["-c", signedIn], { cwd: root, encoding: "utf8", env: { ...GIT_ENV, PATH: bin } });

            return { output: result.stdout, status: result.status };
        };

        it("prints none when the CLI is missing", () => {
            expect(withGh("gh-missing")).toStrictEqual({ output: "none\n", status: 0 });
        });

        it("prints none when the CLI is not signed in", () => {
            expect(withGh("gh-signed-out", 1)).toStrictEqual({ output: "none\n", status: 0 });
        });

        it("prints only signed-in when the CLI is signed in", () => {
            expect(withGh("gh-signed-in", 0)).toStrictEqual({ output: "signed-in\n", status: 0 });
        });
    });
});
