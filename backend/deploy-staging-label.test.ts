/**
 * The label-triggered staging deploy of a pull request. Two properties carry its safety and
 * both are textual, so they are pinned here:
 *
 * - `staging.yml` only ASKS: it dispatches `deploy.yml` from the default branch and holds no
 *   environment and no secrets. The staging environment accepts deployments from `main` alone,
 *   so a pull request cannot widen what it may do by editing that file.
 * - the authorisation is in `deploy.yml`, which always runs from `main`: a `ref` must be a
 *   full SHA, for the staging environment, and the head of an open same-repository pull
 *   request that carries the `staging` label.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const read = (name: string): string => readFileSync(join(import.meta.dirname, "..", ".github/workflows", name), "utf8");

const stagingWorkflow = read("staging.yml");
const deployWorkflow = read("deploy.yml");

describe("staging.yml (the request)", () => {
    it("dispatches deploy.yml from the default branch with the head commit as ref", () => {
        expect(stagingWorkflow).toContain('gh workflow run deploy.yml --repo "$GITHUB_REPOSITORY" --ref "$DEFAULT_BRANCH"');
        expect(stagingWorkflow).toContain('-f environment=staging -f ref="$HEAD_SHA"');
    });

    it("requests a deploy only when the staging label is applied to a same-repository pull request", () => {
        expect(stagingWorkflow).toContain("github.event.action == 'labeled'");
        expect(stagingWorkflow).toContain("github.event.label.name == 'staging'");
        expect(stagingWorkflow).toContain("github.event.pull_request.head.repo.full_name == github.repository");
    });

    it("takes the label off a pull request that changes, so an approval covers one commit", () => {
        expect(stagingWorkflow).toContain("github.event.action == 'synchronize' || github.event.action == 'reopened'");
        expect(stagingWorkflow).toContain('name: "staging"');
        expect(stagingWorkflow).toContain("removeLabel");
    });

    it("holds no environment and no secrets of its own", () => {
        expect(stagingWorkflow.split("\n").some((line) => line.trimStart().startsWith("environment:"))).toBe(false);
        expect(stagingWorkflow).not.toContain("secrets.");
    });
});

describe("deploy.yml (the authorisation)", () => {
    it("takes a ref only as a full SHA, for staging, from an open labelled same-repository pull request head", () => {
        expect(deployWorkflow).toContain("^[0-9a-f]{40}$");
        expect(deployWorkflow).toContain('"$environment" != "staging"');
        expect(deployWorkflow).toContain(String.raw`.state == \"open\" and .head.sha == \"`);
        expect(deployWorkflow).toContain(String.raw`.head.repo.full_name == \"`);
        expect(deployWorkflow).toContain(String.raw`index(\"staging\")`);
    });

    it("lets the caller grant the pull-request read the check needs", () => {
        expect(read("preview.yml")).toContain('pull-requests: "read"');
    });
});
