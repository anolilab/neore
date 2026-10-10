/**
 * The E2B implementation of the runner's sandbox interface.
 *
 * Thin on purpose: everything worth testing is in `runner.ts`, against a fake.
 * E2B's `commands.run` throws `CommandExitError` on a non-zero exit; the
 * interface resolves instead, so the runner handles exit codes in one place.
 */
import { FETCH_TIMEOUT_MS } from "../lib/fetch-timeout";
import type { CommandOutcome, SandboxHandle, SandboxProvider } from "./runner";

/** Optional custom template with the agent CLIs preinstalled; the default template installs them per run. */
const TEMPLATE = process.env["CODING_AGENT_E2B_TEMPLATE"] || undefined;

/**
 * Connecting may EXTEND a sandbox's lifetime to this (E2B only ever lengthens
 * it), so keep it short: the run's budget is set at create, and the poller's
 * deadline and the reaper end a run that overstays.
 */
const CONNECT_TIMEOUT_MS = 60_000;

const toText = (content: unknown): string => (typeof content === "string" ? content : new TextDecoder().decode(content as ArrayBuffer));

type E2BSandbox = Awaited<ReturnType<(typeof import("e2b"))["Sandbox"]["create"]>>;

const toHandle = async (sandbox: E2BSandbox): Promise<SandboxHandle> => {
    const { CommandExitError } = await import("e2b");

    const run = async (
        command: string,
        { cwd, envs, timeoutMs }: { cwd?: string; envs?: Record<string, string>; timeoutMs: number },
    ): Promise<CommandOutcome> => {
        try {
            const result = await sandbox.commands.run(command, { cwd, envs, requestTimeoutMs: FETCH_TIMEOUT_MS, timeoutMs });

            return { exitCode: result.exitCode, stderr: result.stderr, stdout: result.stdout };
        } catch (error) {
            if (error instanceof CommandExitError) {
                return { exitCode: error.exitCode, stderr: error.stderr, stdout: error.stdout };
            }

            throw error;
        }
    };

    return {
        id: sandbox.sandboxId,
        kill: async () => {
            await sandbox.kill({ requestTimeoutMs: FETCH_TIMEOUT_MS });
        },
        readFile: async (path) => toText(await sandbox.files.read(path, { requestTimeoutMs: FETCH_TIMEOUT_MS })),
        run,
        // `setsid nohup … &` in a short foreground command, rather than E2B's
        // `background: true`: the script must outlive this action, its command
        // stream and any process-group cleanup, and a detached session does.
        startDetached: async (command, { cwd, envs }) => {
            const result = await run(`setsid nohup ${command} &`, { cwd, envs, timeoutMs: 30_000 });

            if (result.exitCode !== 0) {
                throw new Error(`Could not start the run (exit ${String(result.exitCode)})`);
            }
        },
        writeFile: async (path, content) => {
            await sandbox.files.write(path, content, { requestTimeoutMs: FETCH_TIMEOUT_MS });
        },
    };
};

export const createE2BSandboxProvider = (apiKey: string): SandboxProvider => {
    return {
        connect: async (sandboxId) => {
            const { Sandbox } = await import("e2b");

            return await toHandle(await Sandbox.connect(sandboxId, { apiKey, requestTimeoutMs: FETCH_TIMEOUT_MS, timeoutMs: CONNECT_TIMEOUT_MS }));
        },
        create: async ({ metadata, timeoutMs }) => {
            const { Sandbox } = await import("e2b");
            const options = { apiKey, metadata, requestTimeoutMs: FETCH_TIMEOUT_MS, timeoutMs };

            return await toHandle(TEMPLATE ? await Sandbox.create(TEMPLATE, options) : await Sandbox.create(options));
        },
    };
};

/** Kill by id, for cancel / timeout / account deletion. Never throws: most are already gone. */
export const killE2BSandbox = async (apiKey: string, sandboxId: string): Promise<void> => {
    try {
        const { Sandbox } = await import("e2b");

        await Sandbox.kill(sandboxId, { apiKey, requestTimeoutMs: FETCH_TIMEOUT_MS });
    } catch {
        // Already gone.
    }
};
