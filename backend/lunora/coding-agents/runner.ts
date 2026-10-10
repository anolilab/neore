/**
 * One coding-agent run against an abstract sandbox, as three short steps.
 *
 * A run takes up to 20 minutes, and nothing on our side may hold on for that
 * long: a scheduled action is dispatched from the SchedulerDO's alarm, which
 * Cloudflare caps at 15 minutes of wall time
 * (https://developers.cloudflare.com/workers/platform/limits/), and the chat
 * agent loop must not block on it. So the work happens INSIDE the sandbox, in a
 * detached script (`buildRunScript`), and the backend only:
 *
 * 1. {@link startRun} — creates the sandbox, writes the script, the prompt and
 *    the GitHub credential, and launches the script in the background;
 * 2. {@link pollRun} — reads the log from a byte offset, formats and redacts
 *    it, and reports whether the script finished;
 * 3. {@link finalizeRun} — collects the diff and summary and kills the sandbox.
 *
 * Each step takes seconds. Kept free of Lunora and E2B so the lifecycle is
 * testable against a fake sandbox: `sandbox-provider.ts` supplies the real one,
 * `execute.ts` the persistence and scheduling. Every byte that leaves the
 * sandbox goes through `redactSecrets`, and every step that ends the run kills
 * the sandbox on every exit path.
 */
import { formatClaudeStreamLine } from "./agent-output";
import type { CodingAgentId, ParsedRepo, RunStatus } from "./commands";
import {
    agentEnv,
    BASE_INFO_PATH,
    buildAgentPrompt,
    buildDiffCommand,
    buildDiffStatCommand,
    buildPollCommand,
    buildPullRequestScript,
    buildRunScript,
    CODEX_LAST_MESSAGE_PATH,
    DIFF_MAX_BYTES,
    GIT_AUTH_PATH,
    githubBasicCredential,
    parsePullRequestStatus,
    parseRunStatus,
    PATCH_PATH,
    PR_LOG_PATH,
    PR_SCRIPT_PATH,
    PR_STATUS_COMMAND,
    prBranchName,
    PROMPT_PATH,
    READ_CHUNK_BYTES,
    REPO_DIR,
    RUN_LOG_PATH,
    RUN_SCRIPT_PATH,
    TIMEOUT_EXIT_CODE,
} from "./commands";
import { expandSecrets, redactSecrets } from "./redact";

export interface CommandOutcome {
    exitCode: number;
    stderr: string;
    stdout: string;
}

export interface RunCommandOptions {
    cwd?: string;
    envs?: Record<string, string>;
    timeoutMs: number;
}

/** The slice of a sandbox a run needs. A non-zero exit resolves; only transport failures reject. */
export interface SandboxHandle {
    readonly id: string;
    kill: () => Promise<void>;
    readFile: (path: string) => Promise<string>;
    run: (command: string, options: RunCommandOptions) => Promise<CommandOutcome>;
    /** Start a command that keeps running after this call returns — and after the calling action ends. */
    startDetached: (command: string, options: { cwd?: string; envs?: Record<string, string> }) => Promise<void>;
    writeFile: (path: string, content: string) => Promise<void>;
}

export interface SandboxProvider {
    /** Reattach to a running sandbox; rejects when it is gone (killed or timed out). */
    connect: (sandboxId: string) => Promise<SandboxHandle>;
    create: (options: { metadata: Record<string, string>; timeoutMs: number }) => Promise<SandboxHandle>;
}

export interface RunSpec {
    agent: CodingAgentId;
    branch?: string;
    githubToken?: string;
    prompt: string;
    providerKey: string;
    repo: ParsedRepo;
    runId: string;
    /** Wall-clock budget for the whole run; also the sandbox's own lifetime. */
    timeoutMs: number;
}

export interface RunOutcome {
    baseBranch?: string;
    baseSha?: string;
    diff?: string;
    diffStat?: string;
    diffTruncated?: boolean;
    error?: string;
    exitCode?: number;
    status: "cancelled" | "failed" | "succeeded";
    summary?: string;
}

const COMMAND_TIMEOUT_MS = 60 * 1000;

/** Left for the script to wrap up and be polled after the agent's own budget. */
const WRAP_UP_MS = 2 * 60 * 1000;

const describeFailure = (step: string, outcome: CommandOutcome): string => {
    const detail = (outcome.stderr || outcome.stdout).trim().split("\n").slice(-5).join("\n");

    return `${step} failed (exit ${String(outcome.exitCode)})${detail ? `: ${detail}` : ""}`;
};

const errorText = (error: unknown): string => (error instanceof Error ? error.message : String(error));

export interface StartResult {
    error?: string;
    sandboxId?: string;
    status: "cancelled" | "failed" | "started";
}

/**
 * Create the sandbox and launch the run script. The sandbox id is persisted
 * (`onSandbox`) BEFORE anything is launched, so a cancel or an account deletion
 * racing this step can still find and kill it.
 */
export const startRun = async (
    spec: RunSpec,
    dependencies: { onSandbox: (sandboxId: string) => Promise<{ cancelled: boolean }>; sandboxes: SandboxProvider },
): Promise<StartResult> => {
    const secrets = expandSecrets([spec.providerKey, spec.githubToken]);
    let sandbox: SandboxHandle | undefined;

    try {
        sandbox = await dependencies.sandboxes.create({ metadata: { purpose: "coding-agent", runId: spec.runId }, timeoutMs: spec.timeoutMs });

        const registered = await dependencies.onSandbox(sandbox.id);

        if (registered.cancelled) {
            await sandbox.kill().catch(() => {});

            return { sandboxId: sandbox.id, status: "cancelled" };
        }

        const script = buildRunScript({
            agent: spec.agent,
            ...(spec.branch !== undefined && { branch: spec.branch }),
            repo: spec.repo,
            timeoutSeconds: (spec.timeoutMs - WRAP_UP_MS) / 1000,
        });

        await sandbox.writeFile(RUN_SCRIPT_PATH, script);
        await sandbox.writeFile(PROMPT_PATH, buildAgentPrompt(spec.prompt));

        if (spec.githubToken) {
            await sandbox.writeFile(GIT_AUTH_PATH, githubBasicCredential(spec.githubToken));
        }

        // The provider key is the one secret the script's environment carries:
        // the agent needs it, and it is the user's own key for the agent they chose.
        await sandbox.startDetached(`bash ${RUN_SCRIPT_PATH} > ${RUN_LOG_PATH} 2>&1 < /dev/null`, {
            cwd: "/home/user",
            envs: agentEnv(spec.agent, spec.providerKey),
        });

        return { sandboxId: sandbox.id, status: "started" };
    } catch (error) {
        await sandbox?.kill().catch(() => {});

        return { error: redactSecrets(errorText(error), secrets).slice(0, 2000), ...(sandbox && { sandboxId: sandbox.id }), status: "failed" };
    }
};

export interface PollResult {
    /** Byte offset to resume from next time. */
    offset: number;
    /** Set once the script has written its status. */
    status?: RunStatus;
    /** Claude's final `result` text, when this chunk carried it. */
    summary?: string;
    /** Formatted, redacted log text to append. */
    text: string;
}

const utf8Length = (text: string): number => new TextEncoder().encode(text).length;

const formatClaudeChunk = (chunk: string): { summary?: string; text: string } => {
    let summary: string | undefined;
    const lines: string[] = [];

    for (const line of chunk.split("\n")) {
        if (!line) {
            continue;
        }

        const formatted = formatClaudeStreamLine(line);

        if (formatted.summary !== undefined) {
            summary = formatted.summary;
        }

        if (formatted.text) {
            lines.push(formatted.text);
        }
    }

    return { ...(summary !== undefined && { summary }), text: lines.length > 0 ? `${lines.join("\n")}\n` : "" };
};

/**
 * Read what the script logged since `offset`. Only whole lines are consumed —
 * the rest is re-read next poll — so neither a secret nor a JSON event is ever
 * split across two polls. The exceptions: a line longer than a whole read, and
 * the tail once the script has ended.
 */
export const pollRun = async (
    sandbox: Pick<SandboxHandle, "run">,
    input: { agent: CodingAgentId; offset: number; secrets: ReadonlyArray<string> },
): Promise<PollResult> => {
    const result = await sandbox.run(buildPollCommand(input.offset), { cwd: "/home/user", timeoutMs: COMMAND_TIMEOUT_MS });
    const newline = result.stdout.indexOf("\n");
    const status = parseRunStatus(newline === -1 ? result.stdout : result.stdout.slice(0, newline));
    const chunk = newline === -1 ? "" : result.stdout.slice(newline + 1);
    const lastNewline = chunk.lastIndexOf("\n");
    let consumed = chunk;

    if (!status && lastNewline !== -1) {
        consumed = chunk.slice(0, lastNewline + 1);
    } else if (!status && utf8Length(chunk) < READ_CHUNK_BYTES) {
        consumed = "";
    }

    const redacted = redactSecrets(consumed, input.secrets);
    const rendered = input.agent === "claude_code" ? formatClaudeChunk(redacted) : { text: redacted };

    return { offset: input.offset + utf8Length(consumed), ...(status && { status }), ...rendered };
};

/**
 * The script ended: turn its status into an outcome, collect diff and summary
 * on success, and kill the sandbox whatever happened.
 */
export const finalizeRun = async (
    sandbox: SandboxHandle,
    input: { agent: CodingAgentId; secrets: ReadonlyArray<string>; status: RunStatus; summary?: string; timeoutMs: number },
): Promise<RunOutcome> => {
    const redact = (text: string): string => redactSecrets(text, input.secrets);
    const outcome: RunOutcome = { status: "failed" };

    try {
        const baseInfo = await sandbox.readFile(BASE_INFO_PATH).catch(() => "");
        const [baseSha, baseBranch] = baseInfo.trim().split("\n", 2);

        if (baseSha?.trim()) {
            outcome.baseSha = baseSha.trim();
        }

        if (baseBranch?.trim()) {
            outcome.baseBranch = baseBranch.trim();
        }

        const { status } = input;

        if (status.kind === "setup-failed") {
            outcome.error = `Setup failed at step "${status.step}". See the log for details.`;

            return outcome;
        }

        outcome.exitCode = status.exitCode;

        const summary = input.agent === "codex" ? await sandbox.readFile(CODEX_LAST_MESSAGE_PATH).catch(() => undefined) : input.summary;

        if (summary?.trim()) {
            outcome.summary = redact(summary.trim()).slice(0, 20_000);
        }

        if (status.exitCode === TIMEOUT_EXIT_CODE) {
            outcome.error = `Timed out after ${String(Math.round(input.timeoutMs / 60_000))} minutes`;

            return outcome;
        }

        if (status.exitCode !== 0) {
            outcome.error = `The agent exited with code ${String(status.exitCode)}. See the log for details.`;

            return outcome;
        }

        if (outcome.baseSha) {
            const diff = await sandbox.run(buildDiffCommand(outcome.baseSha), { cwd: REPO_DIR, timeoutMs: COMMAND_TIMEOUT_MS });

            if (diff.exitCode !== 0) {
                outcome.error = redact(describeFailure("git diff", diff));

                return outcome;
            }

            const stat = await sandbox.run(buildDiffStatCommand(outcome.baseSha), { cwd: REPO_DIR, timeoutMs: COMMAND_TIMEOUT_MS });

            outcome.diffTruncated = diff.stdout.length > DIFF_MAX_BYTES;
            outcome.diff = redact(diff.stdout.slice(0, DIFF_MAX_BYTES));
            outcome.diffStat = redact(stat.stdout.trim());
        }

        outcome.status = "succeeded";

        return outcome;
    } catch (error) {
        outcome.error = redact(errorText(error)).slice(0, 2000);

        return outcome;
    } finally {
        await sandbox.kill().catch(() => {});
    }
};

export const pullRequestProblem = (input: { baseBranch?: string; diffTruncated?: boolean; githubToken?: string; repo: ParsedRepo }): string | undefined => {
    if (!input.repo.github) {
        return "pull requests are only supported for github.com repositories";
    }

    if (!input.githubToken) {
        return "connect GitHub in Settings → Connectors to open pull requests";
    }

    if (!input.baseBranch || input.baseBranch === "HEAD") {
        return "the base branch is unknown";
    }

    if (input.diffTruncated) {
        return "the change is too large to turn into a pull request here";
    }

    return undefined;
};

export interface PullRequestSpec {
    baseBranch: string;
    diff: string;
    githubToken: string;
    repo: ParsedRepo;
    runId: string;
    title: string;
}

/** Lifetime of the PR sandbox; the PR poller's deadline follows it. */
export const PR_SANDBOX_TIMEOUT_MS = 5 * 60 * 1000;

/**
 * Start turning a finished run's diff into a pushed branch — in a FRESH sandbox,
 * never the agent's own. The agent ran untrusted code there: it could have left
 * a git hook, a rewritten `.git/config` (a proxy, an `insteadOf`) or a process
 * reading other processes' environments, and the push is the one command that
 * carries the GitHub token. A patch cannot plant any of those.
 *
 * Like a run, the work is a detached script (`buildPullRequestScript`) the
 * backend polls with {@link checkPullRequest}, so no action holds the scheduler
 * while git clones and pushes. The token is written to a file the script reads
 * for clone and push only, never into any process's initial environment.
 */
export const startPullRequest = async (
    spec: PullRequestSpec,
    dependencies: { sandboxes: SandboxProvider },
): Promise<{ error?: string; sandboxId?: string }> => {
    const secrets = expandSecrets([spec.githubToken]);
    let sandbox: SandboxHandle | undefined;

    try {
        sandbox = await dependencies.sandboxes.create({ metadata: { purpose: "coding-agent-pr", runId: spec.runId }, timeoutMs: PR_SANDBOX_TIMEOUT_MS });

        await sandbox.writeFile(PATCH_PATH, spec.diff);
        await sandbox.writeFile(GIT_AUTH_PATH, githubBasicCredential(spec.githubToken));
        await sandbox.writeFile(
            PR_SCRIPT_PATH,
            buildPullRequestScript({ baseBranch: spec.baseBranch, branch: prBranchName(spec.runId), message: spec.title, repo: spec.repo }),
        );
        await sandbox.startDetached(`bash ${PR_SCRIPT_PATH} > ${PR_LOG_PATH} 2>&1 < /dev/null`, { cwd: "/home/user" });

        return { sandboxId: sandbox.id };
    } catch (error) {
        await sandbox?.kill().catch(() => {});

        return { error: redactSecrets(errorText(error), secrets).slice(0, 1000) };
    }
};

export type PullRequestCheck =
    { log: string; status: "pending" } | { error: string; log: string; status: "failed" } | { branch: string; log: string; status: "pushed" };

const PR_FAILURE: Record<string, string> = {
    apply: "The change no longer applies to the base branch.",
    clone: "Could not clone the repository with your GitHub connection.",
    commit: "Could not commit the change.",
    push: "Could not push the branch. Your GitHub connection may lack write access to this repository.",
};

/**
 * One poll of a PR script. Once it ended — pushed or failed — the sandbox is
 * killed here; the caller then opens the PR through the GitHub API (outside any
 * sandbox) or reports the failure.
 */
export const checkPullRequest = async (sandbox: SandboxHandle, input: { runId: string; secrets: ReadonlyArray<string> }): Promise<PullRequestCheck> => {
    const result = await sandbox.run(PR_STATUS_COMMAND, { cwd: "/home/user", timeoutMs: COMMAND_TIMEOUT_MS });
    const newline = result.stdout.indexOf("\n");
    const status = parsePullRequestStatus(newline === -1 ? result.stdout : result.stdout.slice(0, newline));
    const log = redactSecrets(newline === -1 ? "" : result.stdout.slice(newline + 1), input.secrets).trim();

    if (!status) {
        return { log, status: "pending" };
    }

    await sandbox.kill().catch(() => {});

    return status.kind === "pushed"
        ? { branch: prBranchName(input.runId), log, status: "pushed" }
        : { error: PR_FAILURE[status.step] ?? `The pull request step "${status.step}" failed.`, log, status: "failed" };
};

export interface PullRequestApi {
    /** The GitHub API call, made from the backend — never from the sandbox. */
    createPullRequest: (input: { base: string; body: string; head: string; owner: string; repo: string; title: string }) => Promise<string>;
}

/** The final, short step: open the PR for a pushed branch. */
export const openPullRequestForBranch = async (
    input: { baseBranch: string; body: string; branch: string; repo: ParsedRepo; title: string },
    dependencies: PullRequestApi,
): Promise<string> => {
    if (!input.repo.github) {
        throw new Error("Pull requests are only supported for github.com repositories");
    }

    return await dependencies.createPullRequest({
        base: input.baseBranch,
        body: input.body,
        head: input.branch,
        owner: input.repo.github.owner,
        repo: input.repo.github.repo,
        title: input.title,
    });
};
