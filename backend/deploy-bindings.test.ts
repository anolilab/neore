/**
 * `wrangler.jsonc` and the deploy must want the same Worker.
 *
 * Two files describe this Worker's bindings. `wrangler.jsonc` is hand-written
 * and drives local dev; `alchemy.run.ts` is what actually deploys. They drifted,
 * and nothing noticed: the deploy declared the D1 database, the R2 bucket and
 * ten Vectorize indexes, and declared NO Durable Objects, NO Workflows and NO
 * crons at all.
 *
 * None of those three fails loudly. A missing `SHARD`/`SCHEDULER` binding throws
 * on the first sharded read, on a Worker that deployed "successfully". Missing
 * workflow bindings leave GDPR export, account deletion and chat import with
 * nothing to run. Missing crons just means six scheduled jobs silently never
 * fire. The deploy has never been run, so all three were waiting.
 *
 * `alchemy.run.ts` now reads `lunora-bindings.json`, which
 * `lunora build --emit-bindings` derives from the source — so the deploy can no
 * longer disagree with the code. What it CAN still do is disagree with
 * `wrangler.jsonc`, which is hand-maintained and would then be wrong for local
 * dev while production is right (or the reverse, before someone rebuilds).
 *
 * This test is that missing check. It is deliberately cheap — it reads two
 * committed files and needs no build — so it runs in the normal suite rather
 * than being a deploy-time concern nobody remembers.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { compareStrings } from "./lunora/lib/collections";
import { queueBindingName } from "@lunora/queue";

import { JOBS_QUEUE_CONSUMER, JOBS_QUEUE_DEV_CONSUMER_OVERRIDES } from "./lunora/lib/job-queue-config";
import { jobs, jobsDeadLetters } from "./lunora/queues";

const HERE = import.meta.dirname;

interface EmittedBinding {
    binding: string;
    className?: string;
    resource?: string;
    type: string;
}

interface Manifest {
    bindings: EmittedBinding[];
    crons: string[];
}

const manifest = JSON.parse(readFileSync(join(HERE, "lunora-bindings.json"), "utf8")) as Manifest;

/**
 * `wrangler.jsonc` allows comments, and `JSON.parse` does not. Stripping them
 * with a regex is fine for a config file we control — there are no string
 * literals here containing `//`, and the alternative is a dependency for one
 * read. String contents are preserved so a `"https://…"` value cannot be eaten.
 */
const readJsonc = (path: string): unknown => {
    const text = readFileSync(path, "utf8");
    const stripped = text.replaceAll(/"(?:[^"\\]|\\.)*"|\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, (match) => (match.startsWith('"') ? match : ""));

    return JSON.parse(stripped);
};

const wrangler = readJsonc(join(HERE, "wrangler.jsonc")) as {
    durable_objects?: { bindings: { class_name: string; name: string }[] };
    env?: Record<string, { queues?: { producers?: { binding: string; queue: string }[] } }>;
    // Since `@lunora/workflow@alpha.69` / codegen alpha.240 a workflow is declared
    // as a wrangler `exports` entry keyed by its class name — the runtime looks it
    // up as `env[ClassName] ?? ctx.exports[ClassName]`, and `lunora dev` moves a
    // legacy `workflows[]` entry here on its own.
    exports?: Record<string, { name?: string; type: string }>;
    migrations?: { new_sqlite_classes?: string[]; tag: string }[];
    queues?: {
        consumers?: {
            dead_letter_queue?: string;
            max_batch_size?: number;
            max_batch_timeout?: number;
            max_concurrency?: number;
            max_retries?: number;
            queue: string;
            retry_delay?: number;
        }[];
        producers?: { binding: string; queue: string }[];
    };
    triggers?: { crons: string[] };
    workflows?: unknown[];
};

const ofType = (type: string): EmittedBinding[] => manifest.bindings.filter((binding) => binding.type === type);

describe("deploy bindings", () => {
    it("declares the same cron schedule in both files", () => {
        // Order is meaningful to nobody, so compare as sets — a reordering is not
        // a drift and should not fail.
        expect([...(wrangler.triggers?.crons ?? [])].toSorted(compareStrings)).toStrictEqual([...manifest.crons].toSorted(compareStrings));
    });

    it("declares the same Durable Objects in both files", () => {
        const fromWrangler = (wrangler.durable_objects?.bindings ?? []).map((binding) => `${binding.name}:${binding.class_name}`).toSorted(compareStrings);
        const fromManifest = ofType("durable_object")
            .map((binding) => `${binding.binding}:${binding.className ?? "?"}`)
            .toSorted(compareStrings);

        expect(fromWrangler).toStrictEqual(fromManifest);
    });

    it("declares the same Workflows in both files", () => {
        const fromWrangler = Object.entries(wrangler.exports ?? {})
            .filter(([, entry]) => entry.type === "workflow")
            .map(([className, entry]) => `${className}:${entry.name ?? "?"}`)
            .toSorted(compareStrings);
        const fromManifest = ofType("workflow")
            .map((binding) => `${binding.className ?? "?"}:${binding.resource ?? "?"}`)
            .toSorted(compareStrings);

        expect(fromWrangler).toStrictEqual(fromManifest);
        // The legacy array is gone; a stale entry there would bind a name nothing reads.
        expect(wrangler.workflows).toBeUndefined();
    });

    /*
     * alchemy.run.ts binds each workflow under the manifest's `binding`. The
     * runtime finds a workflow only as `env[<class name>]`, so the two must be
     * the same string — under the old `WORKFLOW_*` names, GDPR export, account
     * deletion and chat import would deploy with nothing to start.
     */
    it("binds every workflow under its class name", () => {
        for (const binding of ofType("workflow")) {
            expect(binding.binding).toBe(binding.className);
        }
    });

    /*
     * The jobs queue is declared in two sources that the deploy and dev must both
     * follow: the `defineQueue` exports (`lunora/queues.ts` — names, retries,
     * DLQ) and `JOBS_QUEUE_CONSUMER` (batch size, batch wait, concurrency).
     * alchemy.run.ts reads both directly, so checking dev against them covers
     * the deploy too.
     */
    it("declares the jobs queue producer and consumer as lunora/queues.ts and JOBS_QUEUE_CONSUMER say", () => {
        expect(wrangler.queues?.producers).toContainEqual({ binding: queueBindingName("jobs"), queue: jobs.name });
        expect(wrangler.queues?.producers).toContainEqual({ binding: queueBindingName("jobsDeadLetters"), queue: jobsDeadLetters.name });

        const consumer = wrangler.queues?.consumers?.find((entry) => entry.queue === jobs.name);

        // The deploy's settings, with exactly the documented dev-only overrides on top.
        expect(consumer).toStrictEqual({
            dead_letter_queue: jobsDeadLetters.name,
            max_batch_size: JOBS_QUEUE_CONSUMER.batchSize,
            max_batch_timeout: JOBS_QUEUE_CONSUMER.maxWaitTimeMs / 1000,
            max_concurrency: JOBS_QUEUE_CONSUMER.maxConcurrency,
            max_retries: jobs.maxRetries,
            queue: jobs.name,
            retry_delay: jobs.retryDelay,
            ...JOBS_QUEUE_DEV_CONSUMER_OVERRIDES,
        });
        expect(jobs.deadLetterQueue).toBe(jobsDeadLetters.name);
        expect(wrangler.queues?.consumers?.find((entry) => entry.queue === jobsDeadLetters.name)?.max_retries).toBe(jobsDeadLetters.maxRetries);
    });

    /*
     * A preview deploy names its queues `<name>-preview` (alchemy.run.ts). The
     * generated consumer routes a batch by queue name, and learns a renamed
     * queue only from a producer in `wrangler.jsonc` mapping the queue's binding
     * to it. Without these, every preview job is refused into the DLQ.
     */
    it("aliases the preview deploy's queue names to the declared queues", () => {
        expect(wrangler.env?.["preview"]?.queues?.producers).toStrictEqual([
            { binding: queueBindingName("jobs"), queue: `${jobs.name}-preview` },
            { binding: queueBindingName("jobsDeadLetters"), queue: `${jobsDeadLetters.name}-preview` },
        ]);
    });

    it("carries the jobs queue through the build manifest", () => {
        expect(ofType("queue_producer").map((binding) => `${binding.binding}:${binding.resource ?? "?"}`)).toStrictEqual(
            expect.arrayContaining([`${queueBindingName("jobs")}:${jobs.name}`, `${queueBindingName("jobsDeadLetters")}:${jobsDeadLetters.name}`]),
        );
        expect(ofType("queue_consumer").map((binding) => binding.resource)).toStrictEqual(expect.arrayContaining([jobs.name, jobsDeadLetters.name]));
    });

    /*
     * `.shardRegistry((env) => env.SHARD_REGISTRY)` in src/server.ts: the class
     * must be bound under that name and created by a migration, or every
     * cross-shard fan-out is refused with a 400.
     */
    it("binds the shard registry and migrates its class in", () => {
        expect(ofType("durable_object")).toContainEqual(expect.objectContaining({ binding: "SHARD_REGISTRY", className: "ShardRegistryDO" }));
        expect((wrangler.migrations ?? []).flatMap((migration) => migration.new_sqlite_classes ?? [])).toContain("ShardRegistryDO");
    });

    it("emits something to check, so a truncated manifest cannot pass silently", () => {
        expect(manifest.crons.length).toBeGreaterThan(0);
        expect(ofType("durable_object").length).toBeGreaterThan(0);
        expect(ofType("workflow").length).toBeGreaterThan(0);
    });
});
