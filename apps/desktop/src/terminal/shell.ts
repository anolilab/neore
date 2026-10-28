import { accessSync, constants, realpathSync, statSync } from "node:fs";
import { release as osRelease, userInfo } from "node:os";
import path from "node:path";

export type Availability = { available: false; reason: string } | { available: true };

/** Windows 10 version 1903. `node-pty` uses ConPTY from here; below it falls back to winpty, whose helper binaries are not unpacked from the app. */
const CONPTY_MIN_BUILD = 18_362;
const WINDOWS_RELEASE = /^\d+\.\d+\.(?<build>\d+)/u;

/** The terminal is offered on macOS, Linux and Windows with ConPTY. Nothing loads the native module before this says yes. */
export const terminalAvailability = (platform: NodeJS.Platform = process.platform, release: string = osRelease()): Availability => {
    if (platform === "win32") {
        const build = Number(WINDOWS_RELEASE.exec(release)?.groups?.build ?? 0);

        return build >= CONPTY_MIN_BUILD ? { available: true } : { available: false, reason: "The terminal needs Windows 10 version 1903 or later." };
    }

    return platform === "darwin" || platform === "linux" ? { available: true } : { available: false, reason: "The terminal is not available on this platform." };
};

const isExecutable = (file: string): boolean => {
    try {
        accessSync(file, constants.X_OK);

        return statSync(file).isFile();
    } catch {
        return false;
    }
};

/** `%SystemRoot%\\System32`. A relative root would resolve against the app's working directory, so only an absolute one is believed. */
export const windowsSystem32 = (env: NodeJS.ProcessEnv = process.env): string => {
    const configuredRoot = env.SystemRoot ?? env.SYSTEMROOT;
    const systemRoot = configuredRoot !== undefined && path.win32.isAbsolute(configuredRoot) ? configuredRoot : String.raw`C:\Windows`;

    return path.win32.join(systemRoot, "System32");
};

/**
 * Windows has no `$SHELL` and no login shell. Windows PowerShell comes with every Windows 10 and later and is what the
 * system's own terminal opens, so it goes first; `%ComSpec%` (cmd.exe) is the fallback. Both are looked up by absolute
 * path under `%SystemRoot%`, never by name on the `PATH`, which a folder in the user's `PATH` could shadow.
 */
const resolveWindowsShell = (env: NodeJS.ProcessEnv, executable: (file: string) => boolean): { args: string[]; file: string } => {
    const system32 = windowsSystem32(env);
    const powershell = path.win32.join(system32, "WindowsPowerShell", "v1.0", "powershell.exe");

    if (executable(powershell)) {
        return { args: ["-NoLogo"], file: powershell };
    }

    const comspec = env.ComSpec ?? env.COMSPEC;
    const command = [comspec, path.win32.join(system32, "cmd.exe")].find((candidate): candidate is string => typeof candidate === "string" && path.win32.isAbsolute(candidate) && executable(candidate));

    if (command === undefined) {
        throw new Error("terminal: no shell was found on this computer");
    }

    return { args: [], file: command };
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
    if (platform === "win32") {
        return resolveWindowsShell(env, executable);
    }

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

    // Electron on Linux rewrites the desktop name for itself and keeps the user's in this one.
    if (env.ORIGINAL_XDG_CURRENT_DESKTOP !== undefined) {
        result.XDG_CURRENT_DESKTOP = env.ORIGINAL_XDG_CURRENT_DESKTOP;
    }

    result.TERM = "xterm-256color";
    result.COLORTERM = "truecolor";

    return result;
};

/** The `ssh` the terminal runs: the first one on the path, as an absolute path, so the pseudo-terminal does no lookup of its own. */
export const resolveSsh = (env: NodeJS.ProcessEnv = process.env, executable: (file: string) => boolean = isExecutable): string => {
    const directories = [...(env.PATH ?? "").split(path.delimiter), "/usr/bin", "/bin"];
    const found = directories.map((directory) => path.join(directory, "ssh")).find((candidate) => path.isAbsolute(candidate) && executable(candidate));

    if (found === undefined) {
        throw new Error("terminal: ssh was not found on this computer");
    }

    return found;
};

/** What ssh needs of the local environment: where things are, who is asking and the locale. Nothing else is handed on. */
const SSH_ENVIRONMENT = /^(?:HOME|LANG|LC_.*|LOGNAME|PATH|TMPDIR|USER)$/u;

/** The environment of the local `ssh` of a terminal on a server. `TERM` is the one thing ssh passes on, in its request for a terminal. */
export const sshEnvironment = (env: NodeJS.ProcessEnv = process.env): Record<string, string> => {
    const result: Record<string, string> = {};

    for (const [key, value] of Object.entries(env)) {
        if (value !== undefined && SSH_ENVIRONMENT.test(key)) {
            result[key] = value;
        }
    }

    result.TERM = "xterm-256color";

    return result;
};

/**
 * The folder a terminal opens in: an absolute path to an existing directory, with symlinks and `..` resolved, so
 * `/w`, `/w/` and `/a/link/..` name one folder (and one window) and the shell starts where the title says.
 */
export const readFolder = (value: unknown): string => {
    if (typeof value !== "string" || value.length === 0 || value.length > 4096 || !path.isAbsolute(value)) {
        throw new Error("terminal: the folder is invalid");
    }

    try {
        const resolved = realpathSync(value);

        if (statSync(resolved).isDirectory()) {
            return resolved;
        }
    } catch {
        // Missing, unreadable or a dangling link: reported below.
    }

    throw new Error("terminal: the folder does not exist");
};
