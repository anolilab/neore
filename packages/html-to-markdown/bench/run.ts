import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";

import UpstreamTurndown from "turndown";

import TurndownService from "../src/index";

/*
 * `pnpm test:bench`: this port against upstream turndown 7.2.5 (the devDependency),
 * on real paste fixtures, a large synthetic page, and adversarial inputs.
 * Prints a table of median milliseconds; paste the numbers into pull request descriptions.
 * Not part of `pnpm test`: timings are not asserted.
 */

const MIN_SAMPLES = 5;
const MAX_SAMPLES = 60;
const MIN_TIME_MS = 1000;

const here = dirname(fileURLToPath(import.meta.url));
const fixtureDirectory = join(here, "fixtures");

const fixtures = Object.fromEntries(
    readdirSync(fixtureDirectory)
        .filter((file) => file.endsWith(".html"))
        .map((file) => [file, readFileSync(join(fixtureDirectory, file), "utf8")]),
);

const pasteSample = fixtures["google-docs-list.html"] ?? "";
const tableSample = fixtures["github-readme-table.html"] ?? "";

// About 5 MB: the Google Docs and GitHub table fixtures repeated, as one long document.
const largeDocument = (pasteSample + tableSample).repeat(700);

// Inputs in the shape of the ReDoS reports (#505, #506) and the linear-time
// concerns: long runs of spaces and line breaks, deep nesting, long code spans.
const adversarial: Record<string, string> = {
    "alternating space and line break": `<p>${" \n".repeat(40_000)}z</p>`,
    "deep emphasis nesting": `${"<em>".repeat(400)}x${"</em>".repeat(400)}`,
    "long code span with backticks": `<code>${"`a ".repeat(20_000)}</code>`,
    "many link attributes with breaks": `<a href="x" title="${"\n  ".repeat(20_000)}t">y</a>`,
    "runs of spaces around text": `<p>x${" ".repeat(50_000)}y${" ".repeat(50_000)}</p>`,
    "trailing whitespace after text": `<p>word${" \n\t".repeat(30_000)}</p>`,
};

const cases: [string, string][] = [
    ...Object.entries(fixtures).map(([name, html]): [string, string] => [`fixture ${name}`, html]),
    ["large document (~5 MB)", largeDocument],
    ...Object.entries(adversarial).map(([name, html]): [string, string] => [`adversarial: ${name}`, html]),
];

function print(line: string): void {
    process.stdout.write(`${line}\n`);
}

function median(values: number[]): number {
    const sorted = values.toSorted((a, b) => a - b);

    return sorted[Math.floor(sorted.length / 2)] ?? NaN;
}

/** Runs `task` after a warm-up, until both the minimum time and sample count are reached. */
function measure(task: () => void): number {
    task();

    const samples: number[] = [];
    const started = performance.now();

    while (samples.length < MAX_SAMPLES && (samples.length < MIN_SAMPLES || performance.now() - started < MIN_TIME_MS)) {
        const begin = performance.now();

        task();
        samples.push(performance.now() - begin);
    }

    return median(samples);
}

const upstream = new UpstreamTurndown();
const port = new TurndownService();

print("| case | input chars | this port (ms) | turndown 7.2.5 (ms) | port / upstream |");
print("| --- | ---: | ---: | ---: | ---: |");

for (const [name, html] of cases) {
    const portMs = measure(() => port.turndown(html));
    const upstreamMs = measure(() => upstream.turndown(html));

    print(`| ${name} | ${html.length.toLocaleString("en-US")} | ${portMs.toFixed(2)} | ${upstreamMs.toFixed(2)} | ${(portMs / upstreamMs).toFixed(2)} |`);
}
