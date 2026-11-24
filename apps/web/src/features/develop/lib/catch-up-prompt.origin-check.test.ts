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

/** Step 1's first check without its `git remote get-url`: what it does with the URL list git would print. */
const FILTER = (/`git remote get-url --all origin \| ([^`]+)`/u.exec(PROMPT)?.[1] ?? "").trim();

/** A user and password in an address, built here so no literal in this file reads as a credential. */
const USERINFO = ["someone", "placeholder-value"].join(":");

const check = (urls: string[]): string => execFileSync("/bin/sh", ["-c", FILTER], { encoding: "utf8", input: urls.map((url: string) => `${url}\n`).join("") });

describe("catchUpPrompt's origin check", () => {
    it("has a filter to run", () => {
        expect(FILTER).not.toBe("");
    });

    it.each([
        "https://git.example/octo/hello.git",
        "https://GIT.example/Octo/Hello/",
        `https://${USERINFO}@git.example/octo/hello.git`,
        "git@git.example:octo/hello.git",
        "ssh://git@git.example:2222/octo/hello.git",
    ])("prints only match for %s", (url: string) => {
        expect(check([url])).toBe("match\n");
    });

    it.each([
        ["another repository", ["https://git.example/octo/other.git"]],
        ["another host", ["https://git.example.evil/octo/hello.git"]],
        ["the host as the user of another", ["https://git.example@evil.example/octo/hello.git"]],
        ["a path holding the host", ["https://evil.example/git.example/octo/hello"]],
        ["two URLs", ["https://git.example/octo/hello.git", "git@git.example:octo/hello.git"]],
        ["no URL", []],
    ])("prints only mismatch for %s", (_name: string, urls: string[]) => {
        expect(check(urls)).toBe("mismatch\n");
    });

    it("never prints a credential, on a match or a mismatch", () => {
        for (const url of [`https://${USERINFO}@git.example/octo/hello.git`, `https://${USERINFO}@evil.example/octo/hello.git`]) {
            expect(check([url])).not.toContain("placeholder-value");
        }
    });
});
