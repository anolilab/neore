/**
 * Fails the deploy BEFORE the upload when the web Worker's modules would exceed
 * Cloudflare's 64 MiB uncompressed cap (`alchemy.run.ts` uploads
 * `apps/web/dist/server` filtered by `WEB_UPLOAD_RULES`). The upload takes minutes to
 * reach that rejection; this takes a second.
 */
import { readdirSync, statSync } from "node:fs";
import { extname, join } from "node:path";

import { WEB_CLIENT_ONLY_CHUNKS, WEB_UPLOAD_EXTENSIONS } from "./worker-bundle";

const LIMIT_MIB = 64;
/** Headroom, so the build that crosses the line is caught here, not at the upload. */
const BUDGET_MIB = 60;
const SERVER_DIRECTORY = "apps/web/dist/server";

const isUploaded = (file: string): boolean => {
    const name = file.slice(file.lastIndexOf("/") + 1);

    return (
        (WEB_UPLOAD_EXTENSIONS as readonly string[]).includes(extname(file)) &&
        !(extname(file) === ".js" && WEB_CLIENT_ONLY_CHUNKS.some((chunk) => name.startsWith(`${chunk}-`)))
    );
};

const walk = (directory: string): string[] => {
    return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
        const path = join(directory, entry.name);

        return entry.isDirectory() ? walk(path) : [path];
    });
};

const uploaded = walk(SERVER_DIRECTORY).filter((file) => isUploaded(file));
const bytes = uploaded.reduce((sum, file) => sum + statSync(file).size, 0);
const mebibytes = bytes / 1024 / 1024;

console.log(`web Worker upload: ${uploaded.length} modules, ${mebibytes.toFixed(1)} MiB of ${LIMIT_MIB} MiB (budget ${BUDGET_MIB}).`);

if (mebibytes > BUDGET_MIB) {
    const largest = uploaded
        .map((file) => ({ file, size: statSync(file).size }))
        .toSorted((a, b) => b.size - a.size)
        .slice(0, 8)
        .map(({ file, size }) => `  ${(size / 1024 / 1024).toFixed(1)} MiB  ${file}`);

    console.error(`Over budget. The largest modules:\n${largest.join("\n")}\nAdd browser-only ones to WEB_CLIENT_ONLY_CHUNKS in scripts/worker-bundle.ts.`);
    process.exitCode = 1;
}
