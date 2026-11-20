/**
 * Splits a project's test files across CI shards by how long each file took last time, so the shards finish
 * together. Vitest's own `--shard` gives each shard an equal count of files, and the backend's files take from
 * 20 milliseconds to almost 20 seconds.
 *
 * Each project with a `test:coverage` target and more test files than shards spreads `timeSharding(import.meta.url)`
 * into its `test` config; Vitest refuses more shards than files. It does nothing until one of two variables is set:
 *
 * - `VITEST_SHARD=2/3` runs that shard. Files are dealt out longest first, each to the shard with the least
 *   time so far.
 * - `VITEST_RECORD_TIMINGS=1` writes how long each file took to `timings/<project>.json`, half old and half
 *   new so one slow run does not swing the split. `full-test.yml` records on `main`, and `test.yml` restores
 *   the latest record from the Actions cache. The committed files are the seed for a cache miss.
 *
 * A file with no record weighs the project's average.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

import type { Reporter, TestModule, TestSpecification } from "vitest/node";
import { BaseSequencer } from "vitest/node";

type Timings = Record<string, number>;

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));

const posix = (path: string): string => path.split(sep).join("/");

const timingsFile = (projectRoot: string): string =>
    join(repoRoot, "scripts/vitest/timings", `${posix(relative(repoRoot, projectRoot)).replaceAll("/", "-")}.json`);

const readTimings = (file: string): Timings => {
    if (!existsSync(file)) {
        return {};
    }

    return JSON.parse(readFileSync(file, "utf8")) as Timings;
};

/** Longest first; equal weights fall back to the id so every shard computes the same order. */
const longestFirst = <T>(items: readonly T[], weigh: (item: T) => number, id: (item: T) => string): T[] =>
    items.toSorted((a, b) => weigh(b) - weigh(a) || id(a).localeCompare(id(b)));

/** Deals the items into `count` buckets, each to the lightest so far. Pure, so every shard agrees on the split. */
export const partition = <T>(items: readonly T[], count: number, weigh: (item: T) => number, id: (item: T) => string): T[][] => {
    const buckets = Array.from({ length: count }, () => ({ items: [] as T[], load: 0 }));

    for (const item of longestFirst(items, weigh, id)) {
        // `<`, not `<=`: on a tie the first bucket wins, so every shard picks the same one.
        const lightest = buckets.reduce((min, bucket) => (bucket.load < min.load ? bucket : min));

        lightest.load += weigh(item);
        lightest.items.push(item);
    }

    return buckets.map((bucket) => bucket.items);
};

/**
 * A weigher over recorded milliseconds; an unrecorded file weighs the average of the recorded ones. Every file
 * weighs at least 1, so the first files dealt each land in an empty shard and no shard is left without one.
 */
export const weigher = (timings: Timings): ((key: string) => number) => {
    const known = Object.values(timings);
    const fallback = known.length > 0 ? known.reduce((sum, ms) => sum + ms, 0) / known.length : 1;

    return (key) => Math.max(1, timings[key] ?? fallback);
};

class TimeSequencer extends BaseSequencer {
    readonly #root = this.ctx.config.root;

    readonly #weigh = weigher(readTimings(timingsFile(this.#root)));

    readonly #key = (spec: TestSpecification): string => posix(relative(this.#root, spec.moduleId));

    readonly #weight = (spec: TestSpecification): number => this.#weigh(this.#key(spec));

    override shard(specs: TestSpecification[]): Promise<TestSpecification[]> {
        const { count, index } = this.ctx.config.shard!;

        // Vitest has already checked that `index` is between 1 and `count`.
        return Promise.resolve(partition(specs, count, this.#weight, this.#key)[index - 1] ?? []);
    }

    override sort(specs: TestSpecification[]): Promise<TestSpecification[]> {
        return Promise.resolve(longestFirst(specs, this.#weight, this.#key));
    }
}

/** Records each file's whole cost: environment, harness, import, setup files and the tests themselves. */
class TimingsReporter implements Reporter {
    readonly #root: string;

    constructor(root: string) {
        this.#root = root;
    }

    onTestRunEnd(modules: ReadonlyArray<TestModule>): void {
        const file = timingsFile(this.#root);
        const timings = readTimings(file);

        for (const module of modules) {
            const d = module.diagnostic();
            const ms = d.environmentSetupDuration + d.prepareDuration + d.collectDuration + d.setupDuration + d.duration;
            const key = posix(relative(this.#root, module.moduleId));
            const old = timings[key];

            timings[key] = Math.round(old === undefined ? ms : (old + ms) / 2);
        }

        // Sorted, one key per line, and pruned of deleted files, so a refresh diffs cleanly.
        const kept = Object.keys(timings)
            .filter((key) => existsSync(join(this.#root, key)))
            .toSorted();

        mkdirSync(dirname(file), { recursive: true });
        writeFileSync(file, `${JSON.stringify(Object.fromEntries(kept.map((key) => [key, timings[key]])), undefined, 4)}\n`);
    }
}

/** `configUrl` is the vitest config's `import.meta.url`; its directory is the project root. */
export const timeSharding = (configUrl: string) => {
    const projectRoot = fileURLToPath(new URL(".", configUrl));
    const shard = process.env.VITEST_SHARD;

    return {
        sequence: { sequencer: TimeSequencer },
        ...(shard ? { shard } : {}),
        ...(process.env.VITEST_RECORD_TIMINGS
            ? { reporters: ["default", ...(process.env.GITHUB_ACTIONS ? ["github-actions"] : []), new TimingsReporter(projectRoot)] }
            : {}),
    };
};
