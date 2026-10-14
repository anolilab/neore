/**
 * The post-deploy smoke test in `deploy.yml`. A deploy that "succeeds" is not a working app
 * (the first staging deploys passed Alchemy while every real backend request failed), so the
 * workflow calls the new deployment. These properties are textual and easy to lose in an edit.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const workflow = readFileSync(join(import.meta.dirname, "..", ".github/workflows/deploy.yml"), "utf8");
const start = workflow.indexOf('- name: "Smoke test the deployment"');
const step = workflow.slice(start);

describe("the post-deploy smoke test", () => {
    it("exists, runs only after a real, successful Alchemy step", () => {
        expect(start).toBeGreaterThan(-1);
        expect(step).toContain("steps.alchemy.conclusion == 'success'");
        expect(step).toContain("!inputs.dry_run");
    });

    it("exercises the path that broke: an RPC that reads a .global() table", () => {
        expect(step).toContain("changelog_functions:getChangelogs");
        expect(step).toContain("BACKEND}/_lunora/rpc");
    });

    it("checks every public surface of the stack", () => {
        for (const target of ["BACKEND}/_lunora/status", "BACKEND}/api/health", "GATEWAY}/health", "SITE}/"]) {
            expect(step).toContain(target);
        }
    });

    it("never prints production logs into the public run log", () => {
        expect(step).toContain('"$STAGE" != "production"');
    });
});
