/**
 * Guard: no Lunora function reschedules ITSELF on a short positive delay.
 *
 * A self-reschedule of 1-999 ms is a loop the scheduler cannot pace: the
 * temporary-chat sweep ran every 100 ms while its expired ids stayed selectable,
 * starting a duplicate deletion chain on each run. A follow-up run needs a delay
 * long enough that the work it follows up on has had time to finish.
 *
 * Heuristic and deliberately narrow: it reads each `export const <name> = ...`
 * block and flags a `runAfter(<literal under 1000>, ...<name>...)` inside its own
 * body, unless that body also makes progress (a cursor, or a write that takes rows
 * out of the selection). It does NOT catch a sweep that never reaches a terminal
 * state; that is a per-sweep test (see `gdpr/request-sweeps.test.ts`).
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

import { describe, expect, it } from "vitest";

const LUNORA_ROOT = join(__dirname, "..");
const EXPORT_RE = /^export const (\w+) = /gm;
const SUB_SECOND_SELF_RESCHEDULE_RE = /runAfter\(\s*([\d_]+)\s*,/g;

const sourceFiles = (dir: string): string[] =>
    readdirSync(dir).flatMap((entry) => {
        if (entry === "node_modules" || entry === "_generated") {
            return [];
        }

        const path = join(dir, entry);

        if (statSync(path).isDirectory()) {
            return sourceFiles(path);
        }

        return path.endsWith(".ts") && !path.endsWith(".test.ts") ? [path] : [];
    });

/** Each exported const's source, from its declaration to the next export. */
const exportBlocks = (source: string): { body: string; name: string }[] => {
    const starts = [...source.matchAll(EXPORT_RE)];

    return starts.map((match, index) => {
        const end = starts[index + 1]?.index ?? source.length;

        return { body: source.slice(match.index, end), name: match[1]! };
    });
};

/** Progress in the same body: a cursor handed on, or a write that takes rows out of the selection. */
const MAKES_PROGRESS_RE = /cursor|\.patch\(|patchRow\(|\.delete\(|\.insert\(/;

const selfReschedulesUnderASecond = (source: string): string[] =>
    exportBlocks(source)
        .filter(({ body, name }) => {
            if (MAKES_PROGRESS_RE.test(body)) {
                return false;
            }

            for (const match of body.matchAll(SUB_SECOND_SELF_RESCHEDULE_RE)) {
                const delay = Number(match[1]!.replaceAll("_", ""));
                const afterDelay = body.slice((match.index ?? 0) + match[0].length, (match.index ?? 0) + match[0].length + 200);

                // A zero delay is the normal chain ("run the next page now"), and its
                // progress usually sits in a helper this scan cannot see. Only a short
                // positive delay is the shape of a loop.
                if (delay > 0 && delay < 1000 && afterDelay.includes(name)) {
                    return true;
                }
            }

            return false;
        })
        .map(({ name }) => name);

describe("schedule loops", () => {
    it("no function reschedules itself on a 1-999 ms delay", () => {
        const violations = sourceFiles(LUNORA_ROOT).flatMap((file) =>
            selfReschedulesUnderASecond(readFileSync(file, "utf8")).map((name) => `${relative(LUNORA_ROOT, file)}: ${name}`),
        );

        expect(violations).toStrictEqual([]);
    });

    it("flags the shape the temporary-chat loop had", () => {
        const loop = [
            "export const deleteExpiredTemporaryChats = internalMutation.mutation(async ({ ctx }) => {",
            "    await ctx.scheduler.runAfter(100, internal.crons.deleteExpiredTemporaryChats, {});",
            "});",
        ].join("\n");

        expect(selfReschedulesUnderASecond(loop)).toStrictEqual(["deleteExpiredTemporaryChats"]);
    });

    it("accepts a self-reschedule with a real delay or a zero-delay chain", () => {
        const chain = "export const page = internalMutation.mutation(async ({ ctx }) => {\n    await ctx.scheduler.runAfter(0, internal.x.page, {});\n});";

        expect(selfReschedulesUnderASecond(chain)).toStrictEqual([]);

        const paced =
            "export const sweep = internalMutation.mutation(async ({ ctx }) => {\n    await ctx.scheduler.runAfter(10_000, internal.x.sweep, {});\n});";

        expect(selfReschedulesUnderASecond(paced)).toStrictEqual([]);
    });
});
