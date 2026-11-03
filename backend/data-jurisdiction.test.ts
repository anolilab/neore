/**
 * The data we store on Cloudflare is pinned to one jurisdiction, EU unless a stage says otherwise.
 *
 * Cloudflare fixes a D1 database's, an R2 bucket's and a Durable Object's jurisdiction at
 * creation, so a resource added without it is created un-pinned and stays that way. Reading
 * `alchemy.run.ts` as text (running it is the deploy), this pins that every resource that takes
 * a jurisdiction receives the one setting, that the setting defaults to `eu`, and that the
 * Durable Objects (pinned by the schema, not by this setting) agree with that default.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { DATA_JURISDICTION_ENV, resolveDataJurisdiction } from "./lunora/lib/data-jurisdiction";

const REPO_ROOT = join(import.meta.dirname, "..");
const read = (path: string): string => readFileSync(join(REPO_ROOT, path), "utf8");

const alchemyScript = read("alchemy.run.ts");

const RESOURCE_END = /\n(?:const|\/\/|export|\}\);)/u;

/** Each `Cloudflare.<kind>("id", { … })` call's text, up to the next top-level statement. */
const resourceCalls = (kind: string): { id: string; text: string }[] => {
    const calls: { id: string; text: string }[] = [];
    const start = new RegExp(String.raw`${kind.replaceAll(".", String.raw`\.`)}\("([^"]+)"`, "gu");

    for (const match of alchemyScript.matchAll(start)) {
        const rest = alchemyScript.slice(match.index);
        const end = rest.search(RESOURCE_END);

        calls.push({ id: match[1] as string, text: end === -1 ? rest : rest.slice(0, end) });
    }

    return calls;
};

const RE_1 = /production/u;
const RE_2 = /must be one of/u;
const RE_3 = /jurisdiction: dataJurisdiction\b/u;
const RE_4 = /jurisdiction:\s*"/u;
const RE_5 = /\.jurisdiction\("eu"\);\s*export default schema;/u;
const RE_6 = /DATA_JURISDICTION: "\$\{\{ vars\.DATA_JURISDICTION \}\}"/u;

describe("data jurisdiction", () => {
    it("defaults to eu, also for an empty value", () => {
        expect(resolveDataJurisdiction("preview", {})).toBe("eu");
        expect(resolveDataJurisdiction("preview", { [DATA_JURISDICTION_ENV]: "" })).toBe("eu");
        expect(resolveDataJurisdiction("preview", { [DATA_JURISDICTION_ENV]: "  EU " })).toBe("eu");
    });

    it("refuses the default jurisdiction on the production stage", () => {
        expect(() => resolveDataJurisdiction("production", { [DATA_JURISDICTION_ENV]: "default" })).toThrow(RE_1);
        expect(resolveDataJurisdiction("production", {})).toBe("eu");
        expect(resolveDataJurisdiction("production", { [DATA_JURISDICTION_ENV]: "eu" })).toBe("eu");
    });

    it("opts out only with an explicit `default`, and refuses anything else", () => {
        expect(resolveDataJurisdiction("preview", { [DATA_JURISDICTION_ENV]: "default" })).toBe("default");
        expect(() => resolveDataJurisdiction("preview", { [DATA_JURISDICTION_ENV]: "us" })).toThrow(RE_2);
    });

    it("is read once in alchemy.run.ts", () => {
        expect(alchemyScript.match(/resolveDataJurisdiction\(/gu)).toHaveLength(1);
        expect(alchemyScript).toContain("const dataJurisdiction = resolveDataJurisdiction(stage);");
    });

    it.each(["Cloudflare.D1.Database", "Cloudflare.R2.Bucket"])("passes it to every %s", (kind) => {
        const calls = resourceCalls(kind);

        expect(calls.length).toBeGreaterThan(0);

        for (const { id, text } of calls) {
            expect(text, `${kind}("${id}")`).toMatch(RE_3);
        }
    });

    it("never writes a jurisdiction literal into a resource", () => {
        expect(alchemyScript).not.toMatch(RE_4);
    });

    it("pins the Durable Objects to eu in the schema, the generated app and the baseline", () => {
        expect(read("backend/lunora/schema.ts")).toMatch(RE_5);
        expect(read("backend/lunora/_generated/app.ts")).toContain('declareAppJurisdiction("eu");');
        expect(JSON.parse(read("backend/lunora/.lunora-schema.json")).jurisdiction).toBe("eu");
    });

    it("reaches the Alchemy step from the workflow", () => {
        expect(read(".github/workflows/deploy.yml")).toMatch(RE_6);
    });
});
