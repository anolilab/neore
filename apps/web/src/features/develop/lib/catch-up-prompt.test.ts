import { describe, expect, it } from "vitest";

import { catchUpPrompt } from "./catch-up-prompt";

describe(catchUpPrompt, () => {
    it("checks out the pull request's head branch, rebases on its own base and pushes with a lease", () => {
        const prompt = catchUpPrompt({ baseBranch: "release/2.0", headBranch: "feat/x", number: 42, repository: "octo/hello" });

        expect(prompt).toContain("octo/hello#42 is behind release/2.0");
        expect(prompt).toContain("`git fetch origin`, then `git switch feat/x`");
        expect(prompt.indexOf("`git switch feat/x`")).toBeLessThan(prompt.indexOf("`git rebase origin/release/2.0`"));
        expect(prompt).toContain("`git rebase origin/release/2.0`");
        expect(prompt).toContain("intent of both sides");
        expect(prompt).toContain("build and the tests");
        expect(prompt).toContain("`git push --force-with-lease`");
        expect(prompt).toContain("`gh pr checkout 42 --repo octo/hello`");
        expect(prompt).toContain("leave the rebased commits in place");
        expect(prompt).not.toContain("origin/main");
    });
});
