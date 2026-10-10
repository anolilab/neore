import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { getRateLimitKey, RATE_LIMIT_CONFIGS } from "../lib/rate-limiter";

/**
 * Every builder turn is an LLM call, so every client-reachable builder
 * procedure must sit behind `skills/builder`. Read from source: the procedures
 * themselves need a Lunora runtime to construct.
 */
const source = readFileSync(join(import.meta.dirname, "builder.ts"), "utf8");
const PUBLIC_PROCEDURE_RE = /export const (\w+) = (?:authAction|authMutation|authQuery|publicAction|publicMutation|publicQuery)\b/g;

describe("skills/builder rate limit", () => {
    it("is configured for both authenticated tiers, premium at least as generous", () => {
        const free = RATE_LIMIT_CONFIGS[getRateLimitKey("skills/builder", "free")];
        const premium = RATE_LIMIT_CONFIGS[getRateLimitKey("skills/builder", "premium")];

        expect(free).toBeDefined();
        expect(premium).toBeDefined();
        expect(premium.rate).toBeGreaterThanOrEqual(free.rate);
        // A token bucket caps a burst; an unbounded capacity would defeat it.
        expect(free.capacity ?? free.rate).toBeLessThanOrEqual(30);
    });

    it("guards every client-reachable builder procedure", () => {
        const procedures = [...source.matchAll(PUBLIC_PROCEDURE_RE)].map((match) => {
            // The builder chain up to its `.input(`: where the middleware sits.
            const start = match.index + match[0].length;

            return { chain: source.slice(start, source.indexOf(".input(", start)), name: match[1] ?? "" };
        });

        expect(procedures.map((procedure) => procedure.name).toSorted((a, b) => a.localeCompare(b))).toStrictEqual([
            "attachSkillTestDrive",
            "refineBuilderDraft",
            "runBuilderTurn",
        ]);

        for (const procedure of procedures) {
            expect(procedure.chain, procedure.name).toContain(`.use(rateLimit("skills/builder"))`);
        }
    });
});
