/**
 * Shell commands a coding-agent run executes inside its sandbox.
 *
 * Everything here is pure so the escaping can be tested without a sandbox. The
 * rule the whole file follows: **no secret is ever part of a command string.**
 * A command string is logged (our audit log, the sandbox's process table, the
 * provider's own telemetry); an environment variable is not. Secrets therefore
 * travel only through {@link agentEnv} / {@link gitAuthEnv}, and every argument
 * that carries user text goes through {@link shellQuote}.
 */

export type CodingAgentId = "claude_code" | "codex";

export type ProviderKeyId = "anthropic" | "openai";

export interface CodingAgentDefinition {
    binary: string;
    /** The environment variable the CLI reads its API key from in non-interactive mode. */
    envVar: string;
    label: string;
    npmPackage: string;
    /**
     * Exact version installed in the sandbox. Pinned so a CLI release cannot
     * change flags or output under us; bump deliberately and re-check the flags
     * in {@link buildAgentCommand} against the docs cited there.
     */
    npmVersion: string;
    /** `aiUserPreferences.providerApiKeys` entry holding the user's own key. */
    providerKey: ProviderKeyId;
    providerLabel: string;
}

export const CODING_AGENTS: Readonly<Record<CodingAgentId, CodingAgentDefinition>> = {
    claude_code: {
        binary: "claude",
        envVar: "ANTHROPIC_API_KEY",
        label: "Claude Code",
        npmPackage: "@anthropic-ai/claude-code",
        npmVersion: "2.1.280",
        providerKey: "anthropic",
        providerLabel: "Anthropic",
    },
    codex: {
        binary: "codex",
        // `codex exec` authenticates from CODEX_API_KEY in CI
        // (https://learn.chatgpt.com/docs/non-interactive-mode, "Authentication").
        envVar: "CODEX_API_KEY",
        label: "OpenAI Codex",
        npmPackage: "@openai/codex",
        npmVersion: "0.156.1",
        providerKey: "openai",
        providerLabel: "OpenAI",
    },
};

/** Wall-clock budget of one run, sandbox included. */
export const RUN_TIMEOUT_MS = 20 * 60 * 1000;

export const missingKeyMessage = (agent: CodingAgentId): string => {
    const { label, providerLabel } = CODING_AGENTS[agent];

    return `${label} runs on your own ${providerLabel} API key. Add it in Settings → API keys, then try again.`;
};

export const isCodingAgentId = (value: unknown): value is CodingAgentId => value === "claude_code" || value === "codex";

/** Where the repository is cloned. Fixed, so no path ever comes from input. */
export const REPO_DIR = "/home/user/repo";

/** Codex writes its final message here (`--output-last-message`); it becomes the run summary. */
export const CODEX_LAST_MESSAGE_PATH = "/tmp/neore-agent-last-message.txt";

/** Where a stored diff is written before `git apply` when a PR is opened later. */
export const PATCH_PATH = "/tmp/neore-agent.patch";

export const PROMPT_MAX = 20_000;

/** Bytes of diff kept. A larger change is reported as truncated and cannot be turned into a PR. */
export const DIFF_MAX_BYTES = 256 * 1024;

/**
 * Quote one argument for bash. Single quotes disable every expansion; the only
 * character that needs handling inside them is the single quote itself.
 * A NUL byte cannot be passed through a shell at all, so it is refused rather
 * than silently truncating the argument.
 */
export const shellQuote = (value: string): string => {
    if (value.includes("\0")) {
        throw new Error("Argument contains a NUL byte");
    }

    return `'${value.replaceAll("'", String.raw`'\''`)}'`;
};

export const shellJoin = (argv: ReadonlyArray<string>): string => argv.map((argument) => shellQuote(argument)).join(" ");

// ─── Repository ──────────────────────────────────────────────────────────────

export interface ParsedRepo {
    /** Clone URL, normalised; never carries credentials. */
    cloneUrl: string;
    /** Set for github.com repositories — the only host a connector token or a PR applies to. */
    github?: { owner: string; repo: string };
    host: string;
    /** The origin a credential for this repository may be sent to. Never another host's. */
    origin: string;
}

/** The origin a GitHub connector token belongs to: the one place it is ever offered. */
export const GITHUB_CREDENTIAL_ORIGIN = "https://github.com";

const GITHUB_SHORTHAND = /^[\w.-]+\/[\w.-]+$/u;

const DOT_GIT_SUFFIX = /\.git$/u;
/** `path` without trailing slashes; a loop, not a regex, so a long run of slashes stays linear. */
const withoutTrailingSlashes = (path: string): string => {
    let end = path.length;

    while (end > 0 && path[end - 1] === "/") {
        end -= 1;
    }

    return path.slice(0, end);
};

const COMMIT_SHA = /^[0-9a-f]{40}$/u;

const GITHUB_SEGMENT = /^[A-Za-z0-9][\w.-]{0,99}$/u;

/**
 * Validate and normalise a repository URL. HTTPS only (no `ssh://`, `file://`,
 * `ext::` transports — git's `ext` transport runs arbitrary commands), no
 * credentials in the URL (they would land in logs and `.git/config`), and
 * GitHub shorthand `owner/repo` is accepted.
 */
export const parseRepoUrl = (raw: string): ParsedRepo => {
    const input = raw.trim();

    if (GITHUB_SHORTHAND.test(input)) {
        return parseRepoUrl(`https://github.com/${input}`);
    }

    let url: URL;

    try {
        url = new URL(input);
    } catch {
        throw new Error("Repository must be an https:// URL or GitHub owner/repo");
    }

    if (url.protocol !== "https:") {
        throw new Error("Only https:// repository URLs are supported");
    }

    if (url.username || url.password) {
        throw new Error("Do not put credentials in the repository URL; connect GitHub in Settings → Connectors instead");
    }

    if (url.search || url.hash) {
        throw new Error("Repository URL must not have a query string or fragment");
    }

    const host = url.hostname.toLowerCase();

    if (host === "github.com" || host === "www.github.com") {
        // Trailing slashes go first, so `web.git/` loses its `.git` too and never stores as `web.git.git`.
        const segments = withoutTrailingSlashes(url.pathname).replace(DOT_GIT_SUFFIX, "").split("/").filter(Boolean);
        const [owner, repo] = segments;

        if (segments.length !== 2 || !owner || !repo || !GITHUB_SEGMENT.test(owner) || !GITHUB_SEGMENT.test(repo)) {
            throw new Error("GitHub repository URL must look like https://github.com/owner/repo");
        }

        return { cloneUrl: `https://github.com/${owner}/${repo}.git`, github: { owner, repo }, host: "github.com", origin: GITHUB_CREDENTIAL_ORIGIN };
    }

    return { cloneUrl: url.href, host, origin: url.origin };
};

const BRANCH = /^[\w./-]{1,200}$/u;

/** A path component git refuses: one that starts with a dot, or ends in `.lock`. */
const BAD_COMPONENT = /(?:^|\/)\.|\.lock(?:\/|$)/u;

/**
 * A branch name safe to hand to git, within `BRANCH`'s character set and the rules `git check-ref-format --branch`
 * applies to it (`BRANCH` is narrower than git, so some names git accepts are refused): no leading dash (an option),
 * no `..` or `//`, no component starting with a dot or ending in `.lock`, no trailing dot or slash. `@` and `{`
 * are outside the character set, so `@{` cannot occur.
 */
export const isValidBranchName = (branch: string): boolean =>
    BRANCH.test(branch) &&
    !branch.startsWith("-") &&
    !branch.startsWith("/") &&
    !branch.endsWith("/") &&
    !branch.endsWith(".") &&
    !branch.includes("..") &&
    !branch.includes("//") &&
    !BAD_COMPONENT.test(branch);

// ─── Environment ─────────────────────────────────────────────────────────────

/** The Basic credential git sends for a GitHub token. Also a redaction target. */
export const githubBasicCredential = (token: string): string => btoa(`x-access-token:${token}`);

/** The git config key that carries a credential for one origin, and for no other. */
export const extraheaderKey = (origin: string): string => `http.${origin}/.extraheader`;

/**
 * The credential for `repo`, and only when the token was saved for that repository's own origin. A token connected for
 * github.com is never offered to a clone of another host, even though the same run may have asked for both.
 */
export const credentialFor = (token: string | undefined, repo: ParsedRepo, savedOrigin = GITHUB_CREDENTIAL_ORIGIN): string | undefined =>
    token && repo.origin === savedOrigin ? githubBasicCredential(token) : undefined;

/**
 * Git configuration that authenticates the origin the token was saved for without the token ever touching a command
 * line, a remote URL or `.git/config`: `GIT_CONFIG_*` (git >= 2.31) injects one config entry per process. Cleartext
 * `http` never gets it.
 */
export const gitAuthEnv = (githubToken: string | undefined, origin = GITHUB_CREDENTIAL_ORIGIN): Record<string, string> => {
    const env: Record<string, string> = { GIT_TERMINAL_PROMPT: "0" };

    if (githubToken && origin.startsWith("https://")) {
        env["GIT_CONFIG_COUNT"] = "1";
        env["GIT_CONFIG_KEY_0"] = extraheaderKey(origin);
        env["GIT_CONFIG_VALUE_0"] = `AUTHORIZATION: basic ${githubBasicCredential(githubToken)}`;
    }

    return env;
};

/**
 * The run script's environment: nothing of ours and no secret. The user's provider key reaches the agent CLI alone,
 * after the repository's setup script has ended ({@link AGENT_KEY_PATH}). Claude Code also names neore as its
 * entrypoint, which it sends in its `User-Agent`.
 */
export const agentEnv = (agent: CodingAgentId): Record<string, string> => {
    return {
        CI: "1",
        ...(agent === "claude_code" && { CLAUDE_CODE_ENTRYPOINT: "neore" }),
        DISABLE_AUTOUPDATER: "1",
        DISABLE_TELEMETRY: "1",
        NO_COLOR: "1",
    };
};

// ─── Commands ────────────────────────────────────────────────────────────────

export const buildCloneCommand = (repo: ParsedRepo, branch?: string): string => {
    if (branch !== undefined && !isValidBranchName(branch)) {
        throw new Error("Invalid branch name");
    }

    const argv = ["git", "clone", "--depth", "50", "--single-branch", ...(branch ? ["--branch", branch] : []), "--", repo.cloneUrl, REPO_DIR];

    return shellJoin(argv);
};

/** Where the pinned CLIs are installed: a user-owned npm prefix, since the sandbox user cannot write the global one. */
export const NPM_PREFIX = "/home/user/.neore-agents";

/** Install the pinned CLI unless that exact version is already present (a custom template may ship it). */
export const buildInstallCommand = (agent: CodingAgentId): string => {
    const { npmPackage, npmVersion } = CODING_AGENTS[agent];
    const spec = shellQuote(`${npmPackage}@${npmVersion}`);

    return `npm ls -g --prefix ${NPM_PREFIX} --depth=0 ${spec} >/dev/null 2>&1 || npm install -g --prefix ${NPM_PREFIX} --no-fund --no-audit ${spec}`;
};

/** What the agent is told on top of the user's request. Never starts with `-`, so it cannot read as an option. */
export const buildAgentPrompt = (task: string): string =>
    [
        `You are working in the git repository checked out at ${REPO_DIR}.`,
        "Make the change described below. Leave your changes in the working tree; do not push.",
        "When you are done, reply with a short summary of what you changed and why.",
        "",
        "Task:",
        task,
    ].join("\n");

/** The prompt is written here and read by the run script, so it never passes through a command line. */
export const PROMPT_PATH = "/tmp/neore-agent-prompt.txt";

/**
 * The non-interactive agent invocation, as it appears in the run script. The
 * prompt comes from {@link PROMPT_PATH}, never from the command string.
 *
 * Claude Code — https://code.claude.com/docs/en/headless and
 * https://code.claude.com/docs/en/cli-reference:
 * - `--bare`: skip auto-discovery of hooks, skills, plugins, MCP servers and
 *   CLAUDE.md. Without it a `-p` session RUNS the hooks in the repository's
 *   `.claude/settings.json` and connects its `.mcp.json` servers, with no trust
 *   prompt — untrusted repository content executing with the API key in env.
 *   Bare mode authenticates from `ANTHROPIC_API_KEY` only.
 * - `-p <prompt>`: non-interactive; `--output-format stream-json` needs `--verbose`.
 * - `--permission-mode bypassPermissions` (≡ `--dangerously-skip-permissions`):
 *   nobody is there to answer a prompt; the E2B sandbox is the boundary.
 * - `--no-session-persistence`: nothing written for `--resume`.
 * - Working directory: the process cwd (the script `cd`s into the repo).
 *
 * Codex — https://learn.chatgpt.com/docs/non-interactive-mode and
 * https://learn.chatgpt.com/docs/developer-commands?surface=cli:
 * - `--dangerously-bypass-approvals-and-sandbox`: no approvals and no Codex
 *   sandbox, "only in isolated environments" — Codex's own sandbox may fail
 *   inside containers, and E2B is the isolation.
 * - `--skip-git-repo-check`, `--ephemeral` (no session files),
 *   `--ignore-user-config`, `-C <dir>`, `-o <file>` (final message → summary).
 * - `-` reads the prompt from stdin.
 */
export const buildAgentCommand = (agent: CodingAgentId): string => {
    if (agent === "claude_code") {
        return `claude --bare -p "$(cat ${PROMPT_PATH})" ${shellJoin(["--output-format", "stream-json", "--verbose", "--permission-mode", "bypassPermissions", "--no-session-persistence"])}`;
    }

    return `${shellJoin([
        "codex",
        "exec",
        "--dangerously-bypass-approvals-and-sandbox",
        "--skip-git-repo-check",
        "--ephemeral",
        "--ignore-user-config",
        "-C",
        REPO_DIR,
        "-o",
        CODEX_LAST_MESSAGE_PATH,
        "-",
    ])} < ${PROMPT_PATH}`;
};

// ─── Run script ──────────────────────────────────────────────────────────────

/** The run script's combined output, read incrementally by the poller. */
export const RUN_LOG_PATH = "/tmp/neore-run.log";

/**
 * Private to the sandbox user (mode 0700): the repository's setup script runs as another user and can neither forge
 * a status nor reach the key here.
 */
export const RUN_DIR = "/home/user/.neore-run";

/** Written once, last: `agent:<exit code>` or `setup-failed:<step>`. Its presence means the script ended. */
export const RUN_STATUS_PATH = `${RUN_DIR}/status`;

/** Present while the script waits for the provider key; the poller then writes {@link AGENT_KEY_PATH}. */
export const KEY_WANTED_PATH = `${RUN_DIR}/key-wanted`;

/** The provider key, written by the poller once setup has ended, read into the agent's environment and deleted. */
export const AGENT_KEY_PATH = `${RUN_DIR}/agent-key`;

export const RUN_SCRIPT_PATH = "/tmp/neore-run.sh";

/** The GitHub Basic credential, read and deleted by the clone step before the agent starts. */
export const GIT_AUTH_PATH = "/tmp/neore-git-auth";

/** Base commit and branch of the clone, one per line. */
export const BASE_INFO_PATH = "/tmp/neore-base";

/** The repository's own setup script, relative to its root. Executed directly when executable, else with bash. */
export const REPO_SETUP_FILE = ".neore/setup";

/** Its output, kept apart from the run log; the agent is pointed at it when setup did not finish. */
export const SETUP_LOG_PATH = "/tmp/neore-setup.log";

/** The unprivileged user the repository's setup script runs as: no sudo, no access to the sandbox user's files. */
export const SETUP_USER = "neore-setup";

/** Setup's own budget, inside the run's 20 minutes. */
export const SETUP_TIMEOUT_S = 300;

const CLONE_TIMEOUT_S = 180;
const INSTALL_TIMEOUT_S = 300;
/** How long the script waits for the poller (every 4s) to hand over the key. */
const KEY_WAIT_S = 60;

/** Readable names of the steps a `setup-failed:<step>` status names, for the run's error. */
export const SETUP_STEP_LABELS: Readonly<Record<string, string>> = {
    "agent-key": "handing your API key to the agent",
    clone: "cloning the repository",
    install: "installing the agent CLI",
    "repo-setup": "taking the repository back after its setup script (.neore/setup)",
    "rev-parse": "reading the cloned commit",
};

/**
 * Runs {@link REPO_SETUP_FILE}, when the repository has one, as {@link SETUP_USER} with an empty environment apart from
 * the hints below. At that point no secret exists in the sandbox: the clone has deleted the git credential, and the
 * provider key has not been delivered yet. The setup user owns the working tree but not `.git`. Before the key is
 * requested, every process it left is killed, the tree is taken back, and `.git` must still be the inode the clone
 * made: owning the working tree is enough to swap `.git` for one whose config runs a command in the next `git` call.
 * A sandbox without passwordless sudo cannot separate the users, so setup is skipped there rather than run as the
 * agent's user. Files the agent writes later in `/tmp` exist before setup, so setup cannot take them over.
 *
 * A failure or timeout does not fail the run: whatever setup did install stays, and the agent is told.
 */
const repoSetupLines = (): string[] => {
    const owner = '"$(id -u):$(id -g)"';
    const run = `cd ${REPO_DIR} && if [ -x ${REPO_SETUP_FILE} ]; then exec ./${REPO_SETUP_FILE}; else exec bash ./${REPO_SETUP_FILE}; fi`;
    const env = [
        "env -i",
        `HOME=/home/${SETUP_USER}`,
        'PATH="$BASE_PATH"',
        "LANG=C.UTF-8",
        "TERM=dumb",
        "CI=1",
        "NEORE=1",
        "NEORE_SETUP=fresh",
        `NEORE_REPO_DIR=${REPO_DIR}`,
        // `.git` belongs to another user; git refuses such a repository without this (command-line scope).
        "GIT_CONFIG_COUNT=1",
        "GIT_CONFIG_KEY_0=safe.directory",
        `GIT_CONFIG_VALUE_0=${REPO_DIR}`,
    ].join(" ");
    const limit = `${String(SETUP_TIMEOUT_S / 60)}-minute`;
    /** Appends a note to the agent's prompt; `%s` in `text` takes the exit code. */
    const note = (text: string): string => `printf ${shellQuote(String.raw`\n\n${text}\n`)} "$setup_exit" >> ${PROMPT_PATH}`;
    const takeBack = "finish setup-failed:repo-setup";

    return [
        `if [ -f ${REPO_SETUP_FILE} ]; then`,
        `  echo ${shellQuote(`$ ${REPO_SETUP_FILE} (repository setup as ${SETUP_USER}, without secrets, up to ${String(SETUP_TIMEOUT_S / 60)} min)`)}`,
        "  git_id=$(stat -c %i:%u .git)",
        `  : > ${CODEX_LAST_MESSAGE_PATH}`,
        `  if sudo -n true 2>/dev/null && { id -u ${SETUP_USER} >/dev/null 2>&1 || sudo -n useradd -m -s /bin/bash ${SETUP_USER}; } && chmod o+x /home/user; then`,
        `    if timeout 180 sudo -n chown -R ${SETUP_USER}: ${REPO_DIR} && timeout 180 sudo -n chown -R ${owner} ${REPO_DIR}/.git; then`,
        `      timeout -k 10 ${String(SETUP_TIMEOUT_S)} sudo -n -u ${SETUP_USER} -- ${env} bash -c ${shellQuote(run)} > ${SETUP_LOG_PATH} 2>&1 < /dev/null`,
        "      setup_exit=$?",
        "    else",
        `      setup_exit=1; echo 'could not hand the working tree to the setup user' > ${SETUP_LOG_PATH}`,
        "    fi",
        `    for _ in 1 2 3 4 5; do sudo -n pkill -KILL -u ${SETUP_USER} || break; sleep 1; done`,
        `    sudo -n pgrep -u ${SETUP_USER} >/dev/null && ${takeBack}`,
        `    timeout 180 sudo -n chown -R ${owner} ${REPO_DIR} || ${takeBack}`,
        `    [ "$(stat -c %i:%u .git 2>/dev/null)" = "$git_id" ] || ${takeBack}`,
        '    case "$setup_exit" in',
        "      0)",
        '        echo "repository setup finished after $SECONDS s of the run"',
        `        ${note(`The repository's setup script (${REPO_SETUP_FILE}) ran before you started (exit code %s); its output is in ${SETUP_LOG_PATH}.`)} ;;`,
        "      124 | 137)",
        `        tail -n 20 ${SETUP_LOG_PATH}`,
        `        echo 'repository setup hit its ${limit} limit; the agent starts anyway'`,
        `        ${note(`Note: the repository's setup script (${REPO_SETUP_FILE}) was stopped at its ${limit} limit (exit code %s). Its output is in ${SETUP_LOG_PATH}. Dependencies may be missing or only partly installed.`)} ;;`,
        "      *)",
        `        tail -n 20 ${SETUP_LOG_PATH}`,
        '        echo "repository setup exited with $setup_exit; the agent starts anyway"',
        `        ${note(`Note: the repository's setup script (${REPO_SETUP_FILE}) failed (exit code %s). Its output is in ${SETUP_LOG_PATH}. Dependencies may be missing or only partly installed.`)} ;;`,
        "    esac",
        "  else",
        `    echo 'repository setup skipped: this sandbox cannot run it as a separate user'`,
        `    setup_exit=skipped; ${note(`Note: the repository's setup script (${REPO_SETUP_FILE}) was not run (%s); dependencies are not installed.`)}`,
        "  fi",
        "fi",
    ];
};

/**
 * The script that performs a whole run inside the sandbox, detached from any
 * backend action: clone, install the pinned CLI, run the repository's setup
 * script, receive the provider key, run the agent, record the outcome. The
 * backend only starts it, polls its files, and hands over the key when asked.
 *
 * No secret is in the script's own environment — a process's initial
 * environment stays readable in `/proc/<pid>/environ` for its whole life. The
 * clone runs in a subshell that reads the GitHub credential from
 * {@link GIT_AUTH_PATH}, deletes it, and exports it only to `git`. The provider
 * key is requested only after repository setup ended ({@link KEY_WANTED_PATH}),
 * read from {@link AGENT_KEY_PATH}, deleted, and exported to the agent alone.
 * The agent's timeout is what is left of `timeoutSeconds` since the script began.
 * `skipRepoSetup` leaves the repository's setup script out; the key hand-off stays.
 */
export const buildRunScript = (input: {
    agent: CodingAgentId;
    branch?: string;
    repo: ParsedRepo;
    /** Leave out {@link REPO_SETUP_FILE}, e.g. for a run that fixes a failed repository setup. */
    skipRepoSetup?: boolean;
    timeoutSeconds: number;
}): string => {
    const { envVar, label } = CODING_AGENTS[input.agent];
    const budgetSeconds = Math.max(60, Math.floor(input.timeoutSeconds));

    return [
        "#!/bin/bash",
        "set -u",
        `mkdir -p -m 700 ${RUN_DIR} && chmod 700 ${RUN_DIR} || exit 1`,
        `chmod 600 ${PROMPT_PATH}`,
        'BASE_PATH="$PATH"',
        `export PATH=${NPM_PREFIX}/bin:$PATH GIT_TERMINAL_PROMPT=0`,
        `finish() { echo "$1" > ${RUN_STATUS_PATH}; exit 0; }`,
        "cd /home/user",
        `echo ${shellQuote(`$ git clone ${input.repo.cloneUrl}${input.branch ? ` (branch ${input.branch})` : ""}`)}`,
        `( if [ -s ${GIT_AUTH_PATH} ]; then export GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=${shellQuote(extraheaderKey(input.repo.origin))} GIT_CONFIG_VALUE_0="AUTHORIZATION: basic $(cat ${GIT_AUTH_PATH})"; fi; rm -f ${GIT_AUTH_PATH}; timeout ${String(CLONE_TIMEOUT_S)} ${buildCloneCommand(input.repo, input.branch)} ) || { rm -f ${GIT_AUTH_PATH}; finish setup-failed:clone; }`,
        `rm -f ${GIT_AUTH_PATH}`,
        `cd ${REPO_DIR} || finish setup-failed:clone`,
        `{ git rev-parse HEAD && git rev-parse --abbrev-ref HEAD; } > ${BASE_INFO_PATH} || finish setup-failed:rev-parse`,
        `echo ${shellQuote(`$ install ${label} ${CODING_AGENTS[input.agent].npmVersion}`)}`,
        `timeout ${String(INSTALL_TIMEOUT_S)} bash -c ${shellQuote(buildInstallCommand(input.agent))} > /tmp/neore-install.log 2>&1 || { tail -n 20 /tmp/neore-install.log; finish setup-failed:install; }`,
        ...(input.skipRepoSetup ? [`echo ${shellQuote(`repository setup (${REPO_SETUP_FILE}) skipped for this run`)}`] : repoSetupLines()),
        `touch ${KEY_WANTED_PATH}`,
        `waited=0; while [ ! -s ${AGENT_KEY_PATH} ]; do [ "$waited" -ge ${String(KEY_WAIT_S)} ] && finish setup-failed:agent-key; sleep 1; waited=$((waited + 1)); done`,
        `rm -f ${KEY_WANTED_PATH}; agent_key=$(cat ${AGENT_KEY_PATH}); rm -f ${AGENT_KEY_PATH}`,
        `agent_s=$((${String(budgetSeconds)} - SECONDS)); [ "$agent_s" -lt 30 ] && agent_s=30`,
        `echo ${shellQuote(`$ ${label}`)}`,
        `${envVar}="$agent_key" timeout "$agent_s" ${buildAgentCommand(input.agent)} 2>&1`,
        'finish "agent:$?"',
        "",
    ].join("\n");
};

export type RunStatus = { exitCode: number; kind: "agent" } | { kind: "setup-failed"; step: string };

/** Parses {@link RUN_STATUS_PATH}; `undefined` while the script is still running. */
export const parseRunStatus = (raw: string): RunStatus | undefined => {
    const value = raw.trim();

    if (value.startsWith("agent:")) {
        const exitCode = Number.parseInt(value.slice("agent:".length), 10);

        return { exitCode: Number.isNaN(exitCode) ? 1 : exitCode, kind: "agent" };
    }

    if (value.startsWith("setup-failed:")) {
        return { kind: "setup-failed", step: value.slice("setup-failed:".length) || "setup" };
    }

    return undefined;
};

/** `timeout(1)` exits 124 when it killed the command. */
export const TIMEOUT_EXIT_CODE = 124;

export const READ_CHUNK_BYTES = 256 * 1024;

/** Header line on a poll while the script waits for the provider key. */
export const KEY_WANTED_MARK = "key-wanted";

/**
 * The status (possibly empty), {@link KEY_WANTED_MARK} or an empty line, and up to {@link READ_CHUNK_BYTES} of log from
 * byte `offset`.
 */
export const buildPollCommand = (offset: number): string => {
    if (!Number.isSafeInteger(offset) || offset < 0) {
        throw new Error("Invalid log offset");
    }

    return `cat ${RUN_STATUS_PATH} 2>/dev/null; echo; [ -e ${KEY_WANTED_PATH} ] && [ ! -e ${AGENT_KEY_PATH} ] && printf ${KEY_WANTED_MARK}; echo; tail -c +${String(offset + 1)} ${RUN_LOG_PATH} 2>/dev/null | head -c ${String(READ_CHUNK_BYTES)}`;
};

/** Stage everything (the agent may also have committed) and diff against the clone's HEAD. */
export const buildDiffCommand = (baseSha: string): string => {
    if (!COMMIT_SHA.test(baseSha)) {
        throw new Error("Invalid base commit");
    }

    return `git add -A && git diff --cached --binary ${baseSha} | head -c ${String(DIFF_MAX_BYTES + 1)}`;
};

export const buildDiffStatCommand = (baseSha: string): string => {
    if (!COMMIT_SHA.test(baseSha)) {
        throw new Error("Invalid base commit");
    }

    return `git diff --cached --stat ${baseSha} | tail -n 60`;
};

/** The branch a run's PR is pushed to. Derived from the run id, never from input. */
const NON_ALPHANUMERIC = /[^A-Za-z0-9]/gu;

export const prBranchName = (runId: string): string => `neore/agent-${runId.replaceAll(NON_ALPHANUMERIC, "").slice(-12).toLowerCase()}`;

/** Hooks never run in a PR checkout: the patch is untrusted, and the push carries the token. */
const NO_HOOKS = ["-c", "core.hooksPath=/dev/null"];

/** The agent's own identity: the fixed bot author, and the co-author when a person is the author. */
const AGENT_IDENTITY = { email: "agent@users.noreply.neore.chat", name: "Neore Agent" } as const;

/** The person a commit is made as (opt-in). Absent: the agent is the author. */
export type CommitAuthor = { email: string; name: string };

/**
 * Commit the applied patch on {@link prBranchName}. By default the author is the
 * fixed agent identity. With a `person`, the commit is made as them and the agent
 * is named as co-author in the message trailer. The message is quoted like any input.
 */
export const buildCommitCommand = (branch: string, message: string, person?: CommitAuthor): string => {
    if (!isValidBranchName(branch)) {
        throw new Error("Invalid branch name");
    }

    const author = person ?? AGENT_IDENTITY;
    const fullMessage = person ? `${message}\n\nCo-authored-by: ${AGENT_IDENTITY.name} <${AGENT_IDENTITY.email}>` : message;

    return [
        shellJoin(["git", "checkout", "-q", "-B", branch]),
        shellJoin(["git", ...NO_HOOKS, "-c", `user.name=${author.name}`, "-c", `user.email=${author.email}`, "commit", "-q", "-m", fullMessage]),
    ].join(" && ");
};

export const buildPushCommand = (branch: string): string => {
    if (!isValidBranchName(branch)) {
        throw new Error("Invalid branch name");
    }

    return shellJoin(["git", ...NO_HOOKS, "push", "--quiet", "origin", `HEAD:refs/heads/${branch}`]);
};

export const buildApplyPatchCommand = (): string => shellJoin(["git", "apply", "--index", "--whitespace=nowarn", PATCH_PATH]);

// ─── Pull-request script ─────────────────────────────────────────────────────

export const PR_SCRIPT_PATH = "/tmp/neore-pr.sh";

export const PR_LOG_PATH = "/tmp/neore-pr.log";

/** Written once, last: `pushed` or `failed:<step>`. */
export const PR_STATUS_PATH = "/tmp/neore-pr.status";

/**
 * Turn a stored diff into a pushed branch, inside a FRESH sandbox, detached
 * from any backend action (the backend polls {@link PR_STATUS_PATH}).
 *
 * The sandbox holds nothing untrusted beyond the patch: no agent ever ran in
 * it. Still, the credential stays out of the script's own environment — it is
 * read from {@link GIT_AUTH_PATH} into a subshell for exactly the two commands
 * that talk to GitHub (clone, push), hooks are disabled for commit and push,
 * and the file is deleted on every exit path.
 */
export const buildPullRequestScript = (input: { baseBranch: string; branch: string; message: string; person?: CommitAuthor; repo: ParsedRepo }): string => {
    const withAuth = (command: string): string =>
        `( export GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=${shellQuote(extraheaderKey(input.repo.origin))} GIT_CONFIG_VALUE_0="AUTHORIZATION: basic $(cat ${GIT_AUTH_PATH})"; timeout ${String(CLONE_TIMEOUT_S)} ${command} )`;

    return [
        "#!/bin/bash",
        "set -u",
        "export GIT_TERMINAL_PROMPT=0",
        `finish() { rm -f ${GIT_AUTH_PATH}; echo "$1" > ${PR_STATUS_PATH}; exit 0; }`,
        "cd /home/user",
        `echo ${shellQuote(`$ git clone ${input.repo.cloneUrl} (branch ${input.baseBranch})`)}`,
        `${withAuth(buildCloneCommand(input.repo, input.baseBranch))} || finish failed:clone`,
        `cd ${REPO_DIR} || finish failed:clone`,
        "echo '$ git apply'",
        `${buildApplyPatchCommand()} || finish failed:apply`,
        `echo ${shellQuote(`$ git commit on ${input.branch}`)}`,
        `${buildCommitCommand(input.branch, input.message, input.person)} || finish failed:commit`,
        `echo ${shellQuote(`$ git push origin ${input.branch}`)}`,
        `${withAuth(buildPushCommand(input.branch))} || finish failed:push`,
        "finish pushed",
        "",
    ].join("\n");
};

export type PullRequestScriptStatus = { kind: "pushed" } | { kind: "failed"; step: string };

/** Parses {@link PR_STATUS_PATH}; `undefined` while the script is still running. */
export const parsePullRequestStatus = (raw: string): PullRequestScriptStatus | undefined => {
    const value = raw.trim();

    if (value === "pushed") {
        return { kind: "pushed" };
    }

    if (value.startsWith("failed:")) {
        return { kind: "failed", step: value.slice("failed:".length) || "unknown" };
    }

    return undefined;
};

export const PR_STATUS_COMMAND = `cat ${PR_STATUS_PATH} 2>/dev/null; echo; tail -c 4000 ${PR_LOG_PATH} 2>/dev/null`;
