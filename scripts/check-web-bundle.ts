/**
 * Fails a pull request when the web client's first-load JavaScript grows past its
 * budget. Reads the Vite manifest of a finished `apps/web` client build (run
 * `vite build` first) and measures the entry chunk plus everything it imports
 * statically, which is what every page downloads before it can run. Dynamic
 * imports are left out on purpose: they load on demand.
 *
 * The check runs on pull requests (`.github/workflows/bundle.yml`). The Worker
 * upload cap is a different, deploy-time check (`check-web-size.ts`).
 */
import { appendFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { gzipSync } from "node:zlib";

const CLIENT_DIRECTORY = "apps/web/dist/client";
const MANIFEST = join(CLIENT_DIRECTORY, ".vite", "manifest.json");

/** gzip KiB. Set just above the measured size, so a regression is caught and a
 * small change is not. Raise it in the same commit as the change that grows it. */
const ENTRY_GZIP_BUDGET_KIB = 320;
const CLOSURE_GZIP_BUDGET_KIB = 640;

interface ManifestChunk {
    file: string;
    imports?: string[];
    isEntry?: boolean;
}

const manifest = JSON.parse(readFileSync(MANIFEST, "utf8")) as Record<string, ManifestChunk>;
const entryKey = Object.keys(manifest).find((key) => manifest[key]?.isEntry);

if (!entryKey) {
    throw new Error(`No entry chunk in ${MANIFEST}. Run \`vite build\` in apps/web first.`);
}

const gzipKiB = (file: string): number => gzipSync(readFileSync(join(CLIENT_DIRECTORY, file))).length / 1024;

const closure = new Set<string>();
const visit = (key: string): void => {
    const chunk = manifest[key];

    if (!chunk || closure.has(key)) {
        return;
    }

    closure.add(key);

    for (const imported of chunk.imports ?? []) {
        visit(imported);
    }
};

visit(entryKey);

const entryGzip = gzipKiB(manifest[entryKey]!.file);
const closureGzip = [...closure].reduce((sum, key) => sum + gzipKiB(manifest[key]!.file), 0);

const rows = [
    ["Entry chunk (gzip)", entryGzip, ENTRY_GZIP_BUDGET_KIB],
    [`Static closure, ${String(closure.size)} chunks (gzip)`, closureGzip, CLOSURE_GZIP_BUDGET_KIB],
] as const;

const table = [
    "| Measure | Size (KiB gzip) | Budget (KiB gzip) | Status |",
    "| --- | ---: | ---: | --- |",
    ...rows.map(([label, size, budget]) => `| ${label} | ${size.toFixed(1)} | ${String(budget)} | ${size > budget ? "over budget" : "ok"} |`),
].join("\n");

console.log(table);

if (process.env.GITHUB_STEP_SUMMARY) {
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, `## Web client bundle\n\n${table}\n`);
}

const overBudget = rows.filter(([, size, budget]) => size > budget);

if (overBudget.length > 0) {
    console.error(`Web client bundle is over budget: ${overBudget.map(([label]) => label).join("; ")}.`);
    process.exit(1);
}
