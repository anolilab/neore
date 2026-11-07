/**
 * `_generated/architecture.{json,ts}` is not committed, and Alchemy bundles
 * `src/server.ts` -> `_generated/app.ts` -> `architecture.js`. `apps/web build` does not run the
 * backend's codegen, so the deploy has to, or a clean checkout fails to bundle the backend.
 * The Preview workflow deploys Storybook alone (`alchemy-storybook.run.ts`), which bundles no backend.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const read = (name: string): string => readFileSync(join(import.meta.dirname, "..", ".github/workflows", name), "utf8");

// Lines that run nothing: comments and step labels (`name:`, `id:`), so prose or a renamed step never counts.
const NOT_A_COMMAND = /^\s*(?:#|(?:- )?(?:name|id):)/;
// Any command that deploys: `alchemy deploy`, a `deploy` script (`pnpm … deploy`), `lunora deploy`, …
const DEPLOY_WORD = /\bdeploy\b/g;
const STORYBOOK_DEPLOY = /\balchemy deploy alchemy-storybook\.run\.ts\b/;
const RUN_FILE = /\.run\.ts\b/;
// The app's deploy in deploy.yml passes its arguments as an array.
const ALCHEMY_ARGS = /alchemy "\$\{args/;
const APP_STACK = /\balchemy\.run\.ts\b/;

const deploy = read("deploy.yml");
const previewLines = read("preview.yml")
    .split("\n")
    .filter((line) => !NOT_A_COMMAND.test(line));

describe("backend codegen before Alchemy", () => {
    const codegen = deploy.indexOf("pnpm --filter @neore/backend run codegen");
    const parallelStart = deploy.indexOf("- parallel:");
    // The Storybook job builds the packages too, earlier in the file: take the deploy job's build.
    const packages = deploy.indexOf("build:packages", parallelStart);
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
        expect(codegen).toBeLessThan(branchEnd);
    });

    it("leaves the preview out: its one deploy is the Storybook stack, never the app", () => {
        const deploys = previewLines.filter((line) => line.match(DEPLOY_WORD));

        // One deploy in the whole file, so a second command chained on the same line counts too.
        expect(previewLines.join("\n").match(DEPLOY_WORD)).toHaveLength(1);
        expect(deploys).toHaveLength(1);
        expect(deploys[0]).toMatch(STORYBOOK_DEPLOY);
        // No second target on the same command, such as `alchemy.run.ts`.
        expect(deploys[0]?.replace("alchemy-storybook.run.ts", "")).not.toMatch(RUN_FILE);
        expect(previewLines.some((line) => ALCHEMY_ARGS.test(line))).toBe(false);
        // The app stack is never named by a step, whatever runs it.
        expect(previewLines.some((line) => APP_STACK.test(line))).toBe(false);
    });
});
