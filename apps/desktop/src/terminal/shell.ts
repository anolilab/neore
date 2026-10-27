import { accessSync, constants, statSync } from "node:fs";
import { userInfo } from "node:os";
import path from "node:path";

export type Availability = { available: false; reason: string } | { available: true };

/**
 * The pseudo-terminal API differs on Windows (ConPTY), and its tests are a separate slice, so a
 * terminal is offered on macOS and Linux only. Nothing loads the native module before this says yes.
 */
export const terminalAvailability = (platform: NodeJS.Platform = process.platform): Availability =>
    platform === "darwin" || platform === "linux" ? { available: true } : { available: false, reason: "The terminal is not available on this platform yet." };

const isExecutable = (file: string): boolean => {
    try {
        accessSync(file, constants.X_OK);

        return statSync(file).isFile();
    } catch {
        return false;
    }
};

/**
 * The user's login shell: `$SHELL`, else the account's shell, else the platform default. Only an
 * absolute path to an executable file counts, so a stray value never becomes a command lookup.
 */
export const resolveShell = (
    env: NodeJS.ProcessEnv = process.env,
    accountShell: () => string | undefined = () => userInfo().shell ?? undefined,
    platform: NodeJS.Platform = process.platform,
    executable: (file: string) => boolean = isExecutable,
): { args: string[]; file: string } => {
    const fallback = platform === "darwin" ? "/bin/zsh" : "/bin/sh";
    const candidates = [env.SHELL, accountShell(), fallback, "/bin/sh"];
    const file = candidates.find((candidate): candidate is string => typeof candidate === "string" && path.isAbsolute(candidate) && executable(candidate));

    if (file === undefined) {
        throw new Error("terminal: no shell was found on this computer");
    }

    // A login shell reads the user's profile, so their tools are on the path even when the app was started from the dock.
    return { args: ["-l"], file };
};

/** Names the app itself runs under. A shell inheriting them would run its own Node or Electron tools as the app. */
const APP_ONLY = /^(?:ELECTRON_.*|NEORE_.*|NODE_OPTIONS|NODE_CHANNEL_FD|ORIGINAL_XDG_CURRENT_DESKTOP|CHROME_.*)$/u;

/** The environment the shell would have when started from the app, minus what only the app needs. No secret is added. */
export const shellEnvironment = (env: NodeJS.ProcessEnv = process.env): Record<string, string> => {
    const result: Record<string, string> = {};

    for (const [key, value] of Object.entries(env)) {
        if (value !== undefined && !APP_ONLY.test(key)) {
            result[key] = value;
        }
    }

    result.TERM = "xterm-256color";
    result.COLORTERM = "truecolor";

    return result;
};

const isDirectory = (file: string): boolean => {
    try {
        return statSync(file).isDirectory();
    } catch {
        return false;
    }
};

/** The folder a terminal opens in: an absolute path to an existing directory. */
export const readFolder = (value: unknown): string => {
    if (typeof value !== "string" || value.length === 0 || value.length > 4096 || !path.isAbsolute(value)) {
        throw new Error("terminal: the folder is invalid");
    }

    if (!isDirectory(value)) {
        throw new Error("terminal: the folder does not exist");
    }

    return path.normalize(value);
};
