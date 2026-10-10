import { describe, expect, it, vi } from "vitest";

import {
    BASE_INFO_PATH,
    CODEX_LAST_MESSAGE_PATH,
    GIT_AUTH_PATH,
    githubBasicCredential,
    parseRepoUrl,
    PATCH_PATH,
    PR_SCRIPT_PATH,
    PROMPT_PATH,
    RUN_SCRIPT_PATH,
} from "./commands";
import { expandSecrets } from "./redact";
import type { CommandOutcome, RunCommandOptions, RunSpec, SandboxHandle, SandboxProvider } from "./runner";
import { checkPullRequest, finalizeRun, openPullRequestForBranch, pollRun, pullRequestProblem, startPullRequest, startRun } from "./runner";
import { fakeKey } from "./test-fixtures";

const PROVIDER_KEY = fakeKey("anthropic");
const GITHUB_TOKEN = fakeKey("github");
const BASE_SHA = "0123456789abcdef0123456789abcdef01234567";

interface FakeSandbox extends SandboxHandle {
    calls: { command: string; options: RunCommandOptions }[];
    detached: { command: string; envs?: Record<string, string> }[];
    files: Map<string, string>;
    killed: number;
}

const ok = (stdout = ""): CommandOutcome => {
    return { exitCode: 0, stderr: "", stdout };
};

/** A healthy sandbox; `override` answers a command first when it returns something. */
const fakeSandbox = (override?: (command: string) => CommandOutcome | undefined): FakeSandbox => {
    const sandbox: FakeSandbox = {
        calls: [],
        detached: [],
        files: new Map([
            [BASE_INFO_PATH, `${BASE_SHA}\nmain\n`],
            [CODEX_LAST_MESSAGE_PATH, "codex summary"],
        ]),
        id: "sbx-1",
        kill: vi.fn(async () => {
            sandbox.killed += 1;
        }),
        killed: 0,
        readFile: async (path) => {
            const content = sandbox.files.get(path);

            if (content === undefined) {
                throw new Error("missing");
            }

            return content;
        },
        run: async (command, options) => {
            sandbox.calls.push({ command, options });

            const answer = override?.(command);

            if (answer) {
                return answer;
            }

            if (command.startsWith("git add -A && git diff --cached --binary")) {
                return ok("diff --git a/x b/x\n+fixed\n");
            }

            if (command.startsWith("git diff --cached --stat")) {
                return ok(" x | 1 +\n");
            }

            return ok();
        },
        startDetached: async (command, options) => {
            sandbox.detached.push({ command, ...(options.envs && { envs: options.envs }) });
        },
        writeFile: async (path, content) => {
            sandbox.files.set(path, content);
        },
    };

    return sandbox;
};

const providerFor = (sandbox: FakeSandbox): SandboxProvider & { created: number } => {
    const provider = {
        connect: async () => sandbox,
        create: async () => {
            provider.created += 1;

            return sandbox;
        },
        created: 0,
    };

    return provider;
};

const spec = (overrides: Partial<RunSpec> = {}): RunSpec => {
    return {
        agent: "claude_code",
        githubToken: GITHUB_TOKEN,
        prompt: "Fix the failing test",
        providerKey: PROVIDER_KEY,
        repo: parseRepoUrl("anolilab/neore"),
        runId: "run123",
        timeoutMs: 20 * 60 * 1000,
        ...overrides,
    };
};

const notCancelled = async () => {
    return { cancelled: false };
};

/** A poll answer: status line, then the log bytes. */
const pollOutput = (status: string, log: string): CommandOutcome => ok(`${status}\n${log}`);

describe("startRun (the async hand-off)", () => {
    it("launches the run script detached and returns without waiting for the agent", async () => {
        const sandbox = fakeSandbox();
        const onSandbox = vi.fn(notCancelled);
        const result = await startRun(spec(), { onSandbox, sandboxes: providerFor(sandbox) });

        expect(result).toEqual({ sandboxId: "sbx-1", status: "started" });
        expect(onSandbox).toHaveBeenCalledWith("sbx-1");
        expect(sandbox.detached).toHaveLength(1);
        expect(sandbox.detached[0]?.command).toContain(RUN_SCRIPT_PATH);
        // Nothing ran in the foreground: the agent, clone and install are the script's.
        expect(sandbox.calls).toHaveLength(0);
        expect(sandbox.killed).toBe(0);
    });

    it("gives the script only the provider key; the GitHub credential goes to a file the clone deletes", async () => {
        const sandbox = fakeSandbox();

        await startRun(spec(), { onSandbox: notCancelled, sandboxes: providerFor(sandbox) });

        expect(sandbox.detached[0]?.envs?.["ANTHROPIC_API_KEY"]).toBe(PROVIDER_KEY);
        expect(JSON.stringify(sandbox.detached)).not.toContain(GITHUB_TOKEN);
        expect(JSON.stringify(sandbox.detached)).not.toContain(githubBasicCredential(GITHUB_TOKEN));
        expect(sandbox.files.get(GIT_AUTH_PATH)).toBe(githubBasicCredential(GITHUB_TOKEN));
        expect(sandbox.files.get(PROMPT_PATH)).toContain("Fix the failing test");
        expect(sandbox.files.get(RUN_SCRIPT_PATH)).not.toContain(GITHUB_TOKEN);
        expect(sandbox.files.get(RUN_SCRIPT_PATH)).not.toContain(PROVIDER_KEY);
    });

    it("writes no credential file without a GitHub token", async () => {
        const sandbox = fakeSandbox();

        await startRun(spec({ githubToken: undefined }), { onSandbox: notCancelled, sandboxes: providerFor(sandbox) });

        expect(sandbox.files.has(GIT_AUTH_PATH)).toBe(false);
    });

    it("kills the sandbox and launches nothing when the run was cancelled meanwhile", async () => {
        const sandbox = fakeSandbox();
        const result = await startRun(spec(), {
            onSandbox: async () => {
                return { cancelled: true };
            },
            sandboxes: providerFor(sandbox),
        });

        expect(result.status).toBe("cancelled");
        expect(sandbox.detached).toHaveLength(0);
        expect(sandbox.killed).toBe(1);
    });

    it("kills the sandbox and redacts the error when launching fails", async () => {
        const sandbox = fakeSandbox();

        sandbox.startDetached = async () => {
            throw new Error(`boom ${PROVIDER_KEY}`);
        };

        const result = await startRun(spec(), { onSandbox: notCancelled, sandboxes: providerFor(sandbox) });

        expect(result.status).toBe("failed");
        expect(result.error).not.toContain(PROVIDER_KEY);
        expect(sandbox.killed).toBe(1);
    });
});

describe("pollRun", () => {
    const secrets = expandSecrets([PROVIDER_KEY]);

    it("consumes whole lines only and advances the byte offset past them", async () => {
        const sandbox = fakeSandbox(() => pollOutput("", "$ git clone x\npartial li"));
        const result = await pollRun(sandbox, { agent: "codex", offset: 100, secrets });

        expect(result).toEqual({ offset: 100 + "$ git clone x\n".length, text: "$ git clone x\n" });
        expect(sandbox.calls[0]?.command).toContain("tail -c +101");
    });

    it("counts the offset in bytes, not characters", async () => {
        const sandbox = fakeSandbox(() => pollOutput("", "ünïcødé ✓\n"));
        const result = await pollRun(sandbox, { agent: "codex", offset: 0, secrets });

        expect(result.offset).toBe(new TextEncoder().encode("ünïcødé ✓\n").length);
    });

    it("formats Claude's stream-json, captures the summary, and redacts the key", async () => {
        const log = [
            JSON.stringify({ subtype: "init", type: "system" }),
            JSON.stringify({ message: { content: [{ text: `my key is ${PROVIDER_KEY}`, type: "text" }] }, type: "assistant" }),
            JSON.stringify({ result: `Done. (${PROVIDER_KEY})`, subtype: "success", type: "result" }),
            "",
        ].join("\n");
        const result = await pollRun(
            fakeSandbox(() => pollOutput("", log)),
            { agent: "claude_code", offset: 0, secrets },
        );

        expect(result.text).toContain("agent started");
        expect(result.text).not.toContain(PROVIDER_KEY);
        expect(result.summary).toBe("Done. ([REDACTED])");
    });

    it("reports the status and takes the unterminated tail once the script ended", async () => {
        const result = await pollRun(
            fakeSandbox(() => pollOutput("agent:0", "last words")),
            { agent: "codex", offset: 0, secrets },
        );

        expect(result.status).toEqual({ exitCode: 0, kind: "agent" });
        expect(result.text).toBe("last words");
    });
});

describe("finalizeRun", () => {
    const secrets = expandSecrets([PROVIDER_KEY]);
    const base = { secrets, timeoutMs: 20 * 60 * 1000 };

    it("collects diff, stat and summary on success, and kills the sandbox", async () => {
        const sandbox = fakeSandbox();
        const outcome = await finalizeRun(sandbox, { ...base, agent: "claude_code", status: { exitCode: 0, kind: "agent" }, summary: "Fixed it" });

        expect(outcome).toMatchObject({ baseBranch: "main", baseSha: BASE_SHA, diffStat: "x | 1 +", status: "succeeded", summary: "Fixed it" });
        expect(outcome.diff).toContain("+fixed");
        expect(sandbox.killed).toBe(1);
    });

    it("reads codex's summary from its last-message file", async () => {
        const outcome = await finalizeRun(fakeSandbox(), { ...base, agent: "codex", status: { exitCode: 0, kind: "agent" } });

        expect(outcome.summary).toBe("codex summary");
    });

    it.each([
        ["a setup failure", { kind: "setup-failed", step: "clone" } as const, 'Setup failed at step "clone"'],
        ["a timeout", { exitCode: 124, kind: "agent" } as const, "Timed out after 20 minutes"],
        ["a non-zero exit", { exitCode: 2, kind: "agent" } as const, "exited with code 2"],
    ])("fails on %s and still kills the sandbox", async (_label, status, error) => {
        const sandbox = fakeSandbox();
        const outcome = await finalizeRun(sandbox, { ...base, agent: "claude_code", status });

        expect(outcome.status).toBe("failed");
        expect(outcome.error).toContain(error);
        expect(outcome.diff).toBeUndefined();
        expect(sandbox.killed).toBe(1);
    });

    it("kills the sandbox when reading the diff throws", async () => {
        const sandbox = fakeSandbox((command) => {
            if (command.startsWith("git add")) {
                throw new Error("connection reset");
            }

            return undefined;
        });
        const outcome = await finalizeRun(sandbox, { ...base, agent: "claude_code", status: { exitCode: 0, kind: "agent" } });

        expect(outcome).toMatchObject({ error: "connection reset", status: "failed" });
        expect(sandbox.killed).toBe(1);
    });

    it("redacts the key from the summary", async () => {
        const outcome = await finalizeRun(fakeSandbox(), {
            ...base,
            agent: "claude_code",
            status: { exitCode: 0, kind: "agent" },
            summary: `key ${PROVIDER_KEY}`,
        });

        expect(outcome.summary).toBe("key [REDACTED]");
    });
});

describe("pull requests (async: start, poll, then the API)", () => {
    const prSpec = {
        baseBranch: "main",
        diff: "diff --git a/x b/x\n",
        githubToken: GITHUB_TOKEN,
        repo: parseRepoUrl("anolilab/neore"),
        runId: "run123",
        title: "Coding agent: fix",
    };
    const secrets = expandSecrets([GITHUB_TOKEN]);

    it("starts the PR script detached in a FRESH sandbox and returns without running git", async () => {
        const sandbox = fakeSandbox();
        const provider = providerFor(sandbox);
        const result = await startPullRequest(prSpec, { sandboxes: provider });

        expect(result).toEqual({ sandboxId: "sbx-1" });
        expect(provider.created).toBe(1);
        expect(sandbox.files.get(PATCH_PATH)).toBe(prSpec.diff);
        expect(sandbox.files.get(PR_SCRIPT_PATH)).toContain("git' 'apply'");
        expect(sandbox.detached).toHaveLength(1);
        expect(sandbox.calls).toHaveLength(0);
        expect(sandbox.killed).toBe(0);
    });

    it("keeps the token out of every environment and the script — it is a file the script reads", async () => {
        const sandbox = fakeSandbox();

        await startPullRequest(prSpec, { sandboxes: providerFor(sandbox) });

        expect(sandbox.detached[0]?.envs).toBeUndefined();
        expect(sandbox.files.get(GIT_AUTH_PATH)).toBe(githubBasicCredential(GITHUB_TOKEN));
        expect(sandbox.files.get(PR_SCRIPT_PATH)).not.toContain(GITHUB_TOKEN);
        expect(sandbox.files.get(PR_SCRIPT_PATH)).not.toContain(githubBasicCredential(GITHUB_TOKEN));
    });

    it("kills the sandbox and redacts the error when starting fails", async () => {
        const sandbox = fakeSandbox();

        sandbox.startDetached = async () => {
            throw new Error(`boom ${GITHUB_TOKEN}`);
        };

        const result = await startPullRequest(prSpec, { sandboxes: providerFor(sandbox) });

        expect(result.error).toContain("boom");
        expect(result.error).not.toContain(GITHUB_TOKEN);
        expect(sandbox.killed).toBe(1);
    });

    it("reports pending while the script runs, and leaves the sandbox alone", async () => {
        const sandbox = fakeSandbox(() => pollOutput("", "$ git clone ..."));
        const check = await checkPullRequest(sandbox, { runId: "run123", secrets });

        expect(check.status).toBe("pending");
        expect(sandbox.killed).toBe(0);
    });

    it("reports the pushed branch and kills the sandbox", async () => {
        const sandbox = fakeSandbox(() => pollOutput("pushed", `$ git push origin neore/agent-run123 ${GITHUB_TOKEN}`));
        const check = await checkPullRequest(sandbox, { runId: "run123", secrets });

        expect(check).toMatchObject({ branch: "neore/agent-run123", status: "pushed" });
        expect(check.log).not.toContain(GITHUB_TOKEN);
        expect(sandbox.killed).toBe(1);
    });

    it("explains a failed step and kills the sandbox", async () => {
        const sandbox = fakeSandbox(() => pollOutput("failed:apply", "error: patch failed"));
        const check = await checkPullRequest(sandbox, { runId: "run123", secrets });

        expect(check).toMatchObject({ error: "The change no longer applies to the base branch.", status: "failed" });
        expect(sandbox.killed).toBe(1);
    });

    it("opens the PR through the API for the pushed branch", async () => {
        const createPullRequest = vi.fn(async () => "https://github.com/anolilab/neore/pull/1");
        const url = await openPullRequestForBranch(
            { baseBranch: "main", body: "summary", branch: "neore/agent-run123", repo: parseRepoUrl("anolilab/neore"), title: "t" },
            { createPullRequest },
        );

        expect(url).toBe("https://github.com/anolilab/neore/pull/1");
        expect(createPullRequest).toHaveBeenCalledWith({
            base: "main",
            body: "summary",
            head: "neore/agent-run123",
            owner: "anolilab",
            repo: "neore",
            title: "t",
        });
    });
});

describe("pullRequestProblem", () => {
    it("needs a GitHub repo, a token, a base branch and a complete diff", () => {
        const repo = parseRepoUrl("anolilab/neore");

        expect(pullRequestProblem({ baseBranch: "main", githubToken: "t", repo })).toBeUndefined();
        expect(pullRequestProblem({ baseBranch: "main", githubToken: "t", repo: parseRepoUrl("https://gitlab.com/a/b") })).toContain("github.com");
        expect(pullRequestProblem({ baseBranch: "main", repo })).toContain("Connectors");
        expect(pullRequestProblem({ baseBranch: "HEAD", githubToken: "t", repo })).toContain("base branch");
        expect(pullRequestProblem({ baseBranch: "main", diffTruncated: true, githubToken: "t", repo })).toContain("too large");
    });
});
