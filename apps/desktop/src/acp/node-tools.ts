/**
 * Where `node` and `npm` are installed, as absolute paths. An npm agent is installed with npm and started with
 * node by the paths found here and recorded: the agent's own command is never looked up on `PATH`, at install or
 * at launch. A GUI app on macOS and Linux starts with a short `PATH`, so the usual package-manager folders are
 * searched too.
 */

import { execFile } from "node:child_process";
import { accessSync, constants, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

export interface NodeTools {
    node: string;
    npm: string;
}

const USUAL_DIRS = ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin"];

const isExecutableFile = (file: string): boolean => {
    try {
        accessSync(file, constants.X_OK);

        return statSync(file).isFile();
    } catch {
        return false;
    }
};

/** The first folder that holds both programs, so the npm that runs is the one that belongs to the node recorded. */
export const findNodeTools = (searchPath: string | undefined = process.env.PATH, isFile: (file: string) => boolean = isExecutableFile): NodeTools | undefined => {
    const directories = [...(searchPath ?? "").split(path.delimiter), ...USUAL_DIRS].filter((directory) => path.isAbsolute(directory));

    for (const directory of directories) {
        const node = path.join(directory, "node");
        const npm = path.join(directory, "npm");

        if (isFile(node) && isFile(npm)) {
            return { node, npm };
        }
    }

    return undefined;
};

/** The oldest npm with `--allow-git`, which keeps a git dependency (and the git its `.npmrc` can name) out of an install. */
const MIN_NPM: readonly [number, number] = [11, 10];
const RUN_TIMEOUT_MS = 15_000;

/** Runs `program` with `args` and returns what it printed. */
export type RunTool = (program: string, args: string[]) => Promise<string>;

const execFileAsync = promisify(execFile);

const runTool: RunTool = async (program, args) => {
    const env = { ...process.env };

    // Neither reaches the person's node: Electron's own settings, and options that would load code into it.
    delete env.ELECTRON_RUN_AS_NODE;
    delete env.NODE_OPTIONS;

    const { stdout } = await execFileAsync(program, args, { cwd: os.homedir(), encoding: "utf8", env, timeout: RUN_TIMEOUT_MS });

    return stdout;
};

const olderThan = (version: string, [major, minor]: readonly [number, number]): boolean => {
    const [gotMajor = 0, gotMinor = 0] = version.split(".").map((part) => Number.parseInt(part, 10));

    return gotMajor < major || (gotMajor === major && gotMinor < minor);
};

/**
 * The Node.js binary behind `found.node` and the npm next to it. A version manager's `node` (Volta, mise, asdf) is a
 * shim that picks a version from the person's own configuration each time it runs. Run once here, as the person would
 * run it, it names the binary it chose (`process.execPath`); the install and the agent then use that binary, and no
 * manager configuration takes part in either. Refuses an npm older than 11.10.
 */
export const resolveNodeTools = async (found: NodeTools, run: RunTool = runTool, isFile: (file: string) => boolean = isExecutableFile): Promise<NodeTools> => {
    let node: string;

    try {
        node = (await run(found.node, ["-p", "process.execPath"])).trim();
    } catch {
        throw new Error(`${found.node} did not run. Check that Node.js works in a terminal, then try again.`);
    }

    if (!path.isAbsolute(node) || !isFile(node)) {
        throw new Error(`${found.node} did not name the Node.js binary it runs. Check that Node.js works in a terminal, then try again.`);
    }

    const npm = path.join(path.dirname(node), "npm");

    if (!isFile(npm)) {
        throw new Error(`npm was not found next to Node.js (${node}). Install npm with that Node.js, then try again.`);
    }

    let version: string;

    try {
        version = (await run(node, [npm, "--version"])).trim();
    } catch {
        throw new Error(`npm (${npm}) did not run. Check that npm works in a terminal, then try again.`);
    }

    if (olderThan(version, MIN_NPM)) {
        throw new Error(`npm ${version} is older than ${MIN_NPM.join(".")}, the first that can keep git dependencies out of an install. Update npm (npm install --global npm), then try again.`);
    }

    return { node, npm };
};
