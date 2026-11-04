/**
 * `_generated/architecture.{json,ts}` is not committed, and Alchemy bundles
 * `src/server.ts` -> `_generated/app.ts` -> `architecture.js`. `apps/web build` does not run the
 * backend's codegen, so the deploy has to, or a clean checkout fails to bundle the backend.
 * The Preview workflow deploys through `deploy.yml`, so it is covered by the same step.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const read = (name: string): string => readFileSync(join(import.meta.dirname, "..", ".github/workflows", name), "utf8");

const ALCHEMY_RUN = /alchemy (deploy|"\$\{args)/;

const deploy = read("deploy.yml");
const preview = read("preview.yml");

describe("backend codegen before Alchemy", () => {
    const codegen = deploy.indexOf("pnpm --filter @neore/backend run codegen");
    const packages = deploy.indexOf("build:packages");
    const parallelStart = deploy.indexOf("- parallel:");
    // The parallel block ends where the next step at its own indent begins.
    const parallelEnd = deploy.indexOf("\n            - name:", parallelStart);
    const alchemy = deploy.indexOf('id: "alchemy"');

    it("runs in deploy.yml, after the packages build and before the Alchemy step", () => {
        expect(codegen).toBeGreaterThan(-1);
        expect(packages).toBeGreaterThan(-1);
        expect(alchemy).toBeGreaterThan(-1);
        expect(codegen).toBeGreaterThan(packages);
        expect(codegen).toBeLessThan(alchemy);
    });

    it("runs in the same parallel branch as build:packages, after it, so the two never race", () => {
        // A branch is one step: it ends where the next sibling step of the block begins.
        const branchEnd = deploy.indexOf("\n                  - name:", packages);

        expect(parallelStart).toBeGreaterThan(-1);
        expect(packages).toBeGreaterThan(parallelStart);
        expect(packages).toBeLessThan(parallelEnd);
        expect(codegen).toBeGreaterThan(packages);
        expect(codegen).toBeLessThan(branchEnd === -1 ? parallelEnd : Math.min(branchEnd, parallelEnd));
    });

    it("covers the preview deploy, which calls deploy.yml rather than running Alchemy itself", () => {
        expect(preview).toContain('uses: "./.github/workflows/deploy.yml"');
        expect(preview).not.toMatch(ALCHEMY_RUN);
    });
});
