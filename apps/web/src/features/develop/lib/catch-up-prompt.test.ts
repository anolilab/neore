import { stripHiddenText } from "@neore/ai/utils";
import { describe, expect, it } from "vitest";

import { catchUpPrompt, hostOfPullRequestUrl, isPlainBranchName, isPlainRepo } from "./catch-up-prompt";

const PULL = { baseBranch: "release/2.0", headBranch: "feat/x", host: "git.example", number: 42, repository: "octo/hello" };

/** Every `git push` command in a prompt, as written between backticks. */
const pushes = (prompt: string): string[] => [...prompt.matchAll(/`(git push[^`]*)`/gu)].map((match) => match[1] ?? "");

describe(catchUpPrompt, () => {
    it("for a head in the base repository, checks origin and the branch, rebases on its own base and pushes only that branch", () => {
        const prompt = catchUpPrompt({ ...PULL, headInBaseRepository: true });

        expect(prompt).toContain("octo/hello#42 is behind release/2.0");
        // The push goes to origin's push URL, which may differ from its fetch URL: both are checked.
        expect(prompt).toContain("`git remote get-url --all origin` and `git remote get-url --push --all origin` each print exactly one URL");
        expect(prompt).toContain("both are octo/hello on git.example");
        // A single-branch clone has no other ref after a bare `git fetch origin`; each is fetched by name.
        // Each into a flat name of its own outside refs/remotes/origin: a stale origin/release cannot block release/2.0, and a
        // branch of origin named pr-42 cannot overwrite the pull request's head.
        expect(prompt).toContain("`git fetch origin +refs/heads/release/2.0:refs/neore/pull-42-base`");
        expect(prompt).toContain("`git fetch origin +refs/heads/feat/x:refs/neore/pull-42-branch`");
        expect(prompt).toContain("`git fetch origin +refs/pull/42/head:refs/neore/pull-42-head`");
        expect(prompt).not.toContain("refs/remotes/origin");
        expect(prompt).toContain("`git rev-parse refs/neore/pull-42-branch` differs from `git rev-parse refs/neore/pull-42-head`, stop");
        // The lease is the commit checked here: another run's fetch of refs/neore/pull-42-head after this step cannot move it.
        expect(prompt).toContain(
            "Otherwise record the commit `git rev-parse refs/neore/pull-42-head` printed and say it: step 7 leases on that commit. Then run `git switch --no-guess feat/x`",
        );
        // Not --track: a ref outside refs/remotes is no upstream, and git refuses to track it.
        expect(prompt).toContain("(`git switch -c feat/x refs/neore/pull-42-branch` when there is no local branch of that name)");
        expect(prompt.indexOf("`git switch --no-guess feat/x`")).toBeLessThan(prompt.indexOf("`git rebase refs/neore/pull-42-base`"));
        expect(prompt).toContain("`git merge --ff-only refs/neore/pull-42-branch`");
        // A local branch ahead of origin merges as "Already up to date": only comparing the commits catches it.
        expect(prompt).toContain("or `git rev-parse HEAD` then differs from `git rev-parse refs/neore/pull-42-branch`");
        expect(prompt).toContain("intent of both sides");
        expect(prompt).toContain("build and the tests");
        expect(pushes(prompt)).toEqual(["git push --no-follow-tags --force-with-lease=refs/heads/feat/x:<commit from step 3> origin HEAD:refs/heads/feat/x"]);
        expect(prompt).toContain("`, writing the commit you recorded in step 3 in place of <commit from step 3>.");
        expect(prompt).not.toContain("--force-with-lease=refs/heads/feat/x:refs/neore/");
        expect(prompt).toContain("Do not push to any other branch or remote.");
        // A delegated cloud coding-agent run never pushes: the steps say to run them where git has the person's own access.
        expect(prompt).toContain("Do not hand them to a cloud coding agent run: it cannot push");
        expect(prompt).not.toContain("gh pr checkout");
        expect(prompt).not.toContain("origin/main");
        // The composer stores a prompt without hidden characters: this one is stored as written, so its code spans stay whole.
        expect(stripHiddenText(prompt).text).toBe(prompt);
    });

    it("for a fork, even one whose branch has origin's name and commit, rebases a local branch and holds no push", () => {
        const prompt = catchUpPrompt({ ...PULL, headInBaseRepository: false });

        expect(prompt).toContain("comes from a fork");
        expect(prompt).toContain("both are octo/hello on git.example");
        expect(prompt).toContain("`git fetch origin +refs/heads/release/2.0:refs/neore/pull-42-base`");
        expect(prompt).toContain("`git fetch origin +refs/pull/42/head:refs/neore/pull-42-head`");
        expect(prompt).toContain("`git switch -c pr-42 refs/neore/pull-42-head`");
        expect(prompt).toContain("`git rebase refs/neore/pull-42-base`");
        // Origin's branch of the head's name is never fetched, switched to or compared: it may be another branch entirely.
        expect(prompt).not.toContain("refs/heads/feat/x");
        expect(prompt).not.toContain("pull-42-branch");
        expect(prompt).not.toContain("`git switch feat/x`");
        expect(pushes(prompt)).toEqual([]);
        expect(prompt).toContain("Do not push to any branch or remote.");
    });

    it("for a head named like the pull request's own ref, still pushes only that branch and keeps the pull request's head apart", () => {
        const prompt = catchUpPrompt({ ...PULL, headBranch: "pr-42", headInBaseRepository: true });

        expect(prompt).toContain("`git fetch origin +refs/heads/pr-42:refs/neore/pull-42-branch`");
        expect(prompt).toContain("`git fetch origin +refs/pull/42/head:refs/neore/pull-42-head`");
        expect(pushes(prompt)).toEqual(["git push --no-follow-tags --force-with-lease=refs/heads/pr-42:<commit from step 3> origin HEAD:refs/heads/pr-42"]);
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
