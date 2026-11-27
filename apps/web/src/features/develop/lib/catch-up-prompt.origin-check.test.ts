// @vitest-environment node
import { execFileSync } from "node:child_process";

import { describe, expect, it } from "vitest";

import { catchUpPrompt } from "./catch-up-prompt";

const PROMPT = catchUpPrompt({
    baseBranch: "main",
    headBranch: "feat/x",
    headInBaseRepository: true,
    host: "git.example",
    number: 42,
    repository: "Octo/hello",
    run: "a1b2c3d4",
});

/** Step 1's push check without its `git remote get-url --push --all`: the same filter, on where git would push. */
const PUSH_FILTER = (/`git remote get-url --push --all origin \| ([^`]+)`/u.exec(PROMPT)?.[1] ?? "").trim();

/** Step 1's first check without its `git remote get-url`: what it does with the URL list git would print. */
const FILTER = (/`git remote get-url --all origin \| ([^`]+)`/u.exec(PROMPT)?.[1] ?? "").trim();

/** A user and password in an address, built here so no literal in this file reads as a credential. */
const USERINFO = ["someone", "placeholder-value"].join(":");

/** The unencrypted scheme the check must refuse, built here because a literal one reads as a mistake to the linter. */
const HTTP = ["http", "//"].join(":");

const check = (urls: string[], filter: string = FILTER): string =>
    execFileSync("/bin/sh", ["-c", filter], { encoding: "utf8", input: urls.map((url: string) => `${url}\n`).join("") });

describe("catchUpPrompt's origin check", () => {
    it("has a filter to run", () => {
        expect(FILTER).not.toBe("");
    });

    it.each([
        "https://git.example/octo/hello.git",
        "https://GIT.example/Octo/Hello/",
        `https://${USERINFO}@git.example/octo/hello.git`,
        "https://git.example:443/octo/hello.git",
        "git@git.example:octo/hello.git",
        "git@GIT.EXAMPLE:Octo/Hello",
        "ssh://git@git.example/octo/hello.git",
        "ssh://git@git.example:22/octo/hello.git",
    ])("prints only match for %s", (url: string) => {
        expect(check([url])).toBe("match\n");
    });

    it.each([
        ["another repository", ["https://git.example/octo/other.git"]],
        ["another host", ["https://git.example.evil/octo/hello.git"]],
        ["the host as the user of another", ["https://git.example@evil.example/octo/hello.git"]],
        ["a path holding the host", ["https://evil.example/git.example/octo/hello"]],
        ["the http scheme", [`${HTTP}git.example/octo/hello.git`]],
        ["http on another port", [`${HTTP}git.example:444/octo/hello.git`]],
        ["https on another port", ["https://git.example:444/octo/hello.git"]],
        ["https on the ssh port", ["https://git.example:22/octo/hello.git"]],
        ["ssh on another port", ["ssh://git@git.example:2222/octo/hello.git"]],
        ["ssh on the https port", ["ssh://git@git.example:443/octo/hello.git"]],
        ["ssh with another user", ["ssh://deploy@git.example/octo/hello.git"]],
        ["ssh without a user", ["ssh://git.example/octo/hello.git"]],
        ["scp-like with another user", ["deploy@git.example:octo/hello.git"]],
        ["scp-like with a port", ["git@git.example:22/octo/hello.git"]],
        ["the git scheme", ["git://git.example/octo/hello.git"]],
        ["git over ssh's scheme alias", ["git+ssh://git@git.example/octo/hello.git"]],
        ["a file URL", ["file:///srv/git.example/octo/hello.git"]],
        ["a local path", ["/srv/git.example/octo/hello.git"]],
        ["a relative path", ["git.example/octo/hello.git"]],
        ["a credential on an http URL", [`${HTTP}${USERINFO}@git.example/octo/hello.git`]],
        ["one good URL beside an http one", ["https://git.example/octo/hello.git", `${HTTP}git.example/octo/hello.git`]],
        ["two URLs", ["https://git.example/octo/hello.git", "git@git.example:octo/hello.git"]],
        ["no URL", []],
    ])("prints only mismatch for %s", (_name: string, urls: string[]) => {
        expect(check(urls)).toBe("mismatch\n");
    });

    it("checks where git pushes the same way", () => {
        expect(PUSH_FILTER).toBe(FILTER);
        expect(check(["https://git.example/octo/hello.git"], PUSH_FILTER)).toBe("match\n");
        expect(check([`${HTTP}git.example:444/octo/hello.git`], PUSH_FILTER)).toBe("mismatch\n");
    });

    it("never prints a credential, on a match or a mismatch", () => {
        for (const url of [
            `https://${USERINFO}@git.example/octo/hello.git`,
            `https://${USERINFO}@evil.example/octo/hello.git`,
            `${HTTP}${USERINFO}@git.example:444/octo/hello.git`,
        ]) {
            expect(check([url])).not.toContain("placeholder-value");
        }
    });
});
