/**
 * Where `node` and `npm` are installed, as absolute paths. An npm agent is installed with npm and started with
 * node by the paths found here and recorded: the agent's own command is never looked up on `PATH`, at install or
 * at launch. A GUI app on macOS and Linux starts with a short `PATH`, so the usual package-manager folders are
 * searched too.
 */

import { accessSync, constants, statSync } from "node:fs";
import path from "node:path";

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
