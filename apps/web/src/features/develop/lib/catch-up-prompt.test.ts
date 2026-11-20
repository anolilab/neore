import { describe, expect, it } from "vitest";

import { catchUpPrompt } from "./catch-up-prompt";

describe(catchUpPrompt, () => {
    it("rebases on the pull request's own base and pushes with a lease", () => {
        const prompt = catchUpPrompt({ baseBranch: "release/2.0", number: 42, repository: "octo/hello" });

        expect(prompt).toContain("octo/hello#42 is behind release/2.0");
        expect(prompt).toContain("`git fetch origin`");
        expect(prompt).toContain("`git rebase origin/release/2.0`");
        expect(prompt).toContain("intent of both sides");
        expect(prompt).toContain("build and the tests");
        expect(prompt).toContain("--force-with-lease");
        expect(prompt).not.toContain("origin/main");
    });
});
