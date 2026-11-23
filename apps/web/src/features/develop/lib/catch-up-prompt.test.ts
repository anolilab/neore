import { describe, expect, it } from "vitest";

import { catchUpPrompt, isPlainBranchName } from "./catch-up-prompt";

describe(catchUpPrompt, () => {
    it("fetches every ref by name, checks out the pull request's head, rebases on its own base and pushes with a lease", () => {
        const prompt = catchUpPrompt({ baseBranch: "release/2.0", headBranch: "feat/x", number: 42, repository: "octo/hello" });

        expect(prompt).toContain("octo/hello#42 is behind release/2.0");
        // A single-branch clone has no other ref after a bare `git fetch origin`; the base is fetched on its own, so a head
        // missing from origin (a fork) cannot stop it.
        expect(prompt).toContain("`git fetch origin +refs/heads/release/2.0:refs/remotes/origin/release/2.0`");
        expect(prompt).toContain("`git fetch origin +refs/pull/42/head:refs/remotes/origin/pr-42`");
        expect(prompt).toContain("`git fetch origin +refs/heads/feat/x:refs/remotes/origin/feat/x`");
        // Origin's branch of that name is the pull request's only when it is the same commit: a fork's branch may share the name.
        expect(prompt).toContain("`git rev-parse origin/feat/x` equals `git rev-parse origin/pr-42`");
        expect(prompt).toContain("`git switch -c pr-42 origin/pr-42` and do not push");
        expect(prompt.indexOf("`git switch feat/x`")).toBeLessThan(prompt.indexOf("`git rebase origin/release/2.0`"));
        expect(prompt).toContain("`git merge --ff-only origin/feat/x`");
        expect(prompt).toContain("intent of both sides");
        expect(prompt).toContain("build and the tests");
        expect(prompt).toContain("`git push --force-with-lease origin HEAD:feat/x`");
        expect(prompt).not.toContain("gh pr checkout");
        expect(prompt).toContain("leave the rebased commits in place");
        expect(prompt).not.toContain("origin/main");
    });
});

describe(isPlainBranchName, () => {
    it.each(["main", "release/2.0", "feat/thread-pr-catch-up", "user_1/fix.v2"])("takes %s", (name) => {
        expect(isPlainBranchName(name)).toBe(true);
    });

    it.each(["main`; rm -rf ~ #", "a$(id)", "x;y", "-delete", "a..b", "with space", ""])("refuses %j", (name) => {
        expect(isPlainBranchName(name)).toBe(false);
    });
});
