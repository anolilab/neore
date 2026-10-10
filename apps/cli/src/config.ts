/**
 * Where `neore login` keeps the API key.
 *
 * One JSON file in the OS config directory. The key is a bearer credential, so
 * the directory is created 0700 and the file written 0600 — and re-chmodded on
 * every write, because `writeFile`'s `mode` only applies when the file is
 * CREATED: a pre-existing 0644 file would otherwise stay world-readable.
 *
 * `NEORE_API_KEY` / `NEORE_API_URL` override the file, for CI.
 */
import { chmod, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, posix, win32 } from "node:path";

export interface CliConfig {
    apiKey?: string;
    apiUrl?: string;
}

export const CONFIG_FILE_MODE = 0o600;

export const CONFIG_DIR_MODE = 0o700;

/**
 * `$XDG_CONFIG_HOME/neore`, `~/Library/Application Support/neore`, or `%APPDATA%\neore`.
 * Joined with `platform`'s separator, not the host's, so the result depends only on the arguments.
 */
export const configDirectory = (env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform, home: string = homedir()): string => {
    if (platform === "win32") {
        return win32.join(env["APPDATA"] ?? win32.join(home, "AppData", "Roaming"), "neore");
    }

    if (platform === "darwin" && !env["XDG_CONFIG_HOME"]) {
        return posix.join(home, "Library", "Application Support", "neore");
    }

    return posix.join(env["XDG_CONFIG_HOME"] || posix.join(home, ".config"), "neore");
};

export const configPath = (directory: string = configDirectory()): string => join(directory, "config.json");

export const readConfig = async (path: string = configPath()): Promise<CliConfig> => {
    let text: string;

    try {
        text = await readFile(path, "utf8");
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
            return {};
        }

        throw error;
    }

    try {
        const parsed = JSON.parse(text) as unknown;

        if (!parsed || typeof parsed !== "object") {
            return {};
        }

        const { apiKey, apiUrl } = parsed as Record<string, unknown>;

        return { ...(typeof apiKey === "string" && { apiKey }), ...(typeof apiUrl === "string" && { apiUrl }) };
    } catch {
        throw new Error(`${path} is not valid JSON. Delete it and run \`neore login\` again.`);
    }
};

export const writeConfig = async (config: CliConfig, path: string = configPath()): Promise<void> => {
    const directory = join(path, "..");

    await mkdir(directory, { mode: CONFIG_DIR_MODE, recursive: true });
    await writeFile(path, `${JSON.stringify(config, null, 2)}\n`, { encoding: "utf8", mode: CONFIG_FILE_MODE });

    if (process.platform !== "win32") {
        await chmod(path, CONFIG_FILE_MODE);
    }
};

export const deleteConfig = async (path: string = configPath()): Promise<void> => {
    await rm(path, { force: true });
};

/** Non-null when the file is readable by group or others (POSIX only). */
export const insecurePermissions = async (path: string = configPath()): Promise<string | null> => {
    if (process.platform === "win32") {
        return null;
    }

    try {
        const { mode } = await stat(path);

        return (mode & 0o077) === 0 ? null : `0${(mode & 0o777).toString(8)}`;
    } catch {
        return null;
    }
};

/** Environment first, then the file. */
export const resolveCredentials = (file: CliConfig, env: NodeJS.ProcessEnv = process.env): CliConfig => {
    return {
        apiKey: env["NEORE_API_KEY"] || file.apiKey,
        apiUrl: env["NEORE_API_URL"] || file.apiUrl,
    };
};
