import { describe, expect, it } from "vitest";

import { assertValidFilters, evaluateFilters } from "./filters";
import type { WebhookPresetEvent } from "./presets";
import { compileWebhookPreset, WEBHOOK_PRESET_LIST } from "./presets";

/** Whether the filters an event compiles to accept a body. */
const matchesPreset = (event: WebhookPresetEvent, body: unknown): boolean => {
    const preset = WEBHOOK_PRESET_LIST.find((candidate) => candidate.event === event);

    if (!preset) {
        throw new Error(`no preset for ${event}`);
    }

    return evaluateFilters(compileWebhookPreset(preset).filters, JSON.stringify(body)).matched;
};

describe("provider presets", () => {
    it("compiles only to filters the backend accepts", () => {
        for (const preset of WEBHOOK_PRESET_LIST) {
            expect(() => assertValidFilters(compileWebhookPreset(preset).filters)).not.toThrow();
        }
    });

    it("hands out a copy of its filters, so a caller cannot edit the table", () => {
        const preset = { event: "pull_request_opened", provider: "github" } as const;

        compileWebhookPreset(preset).filters.push({ op: "exists", path: "x" });

        expect(compileWebhookPreset(preset).filters).toHaveLength(2);
    });
});

describe("GitHub presets match the event and nothing next to it", () => {
    const pullRequest = { number: 7, pull_request: { merged: false, number: 7 } };

    it("pull request opened", () => {
        expect(matchesPreset("pull_request_opened", { action: "opened", ...pullRequest })).toBe(true);
        expect(matchesPreset("pull_request_opened", { action: "reopened", ...pullRequest })).toBe(false);
        // An issue opened carries `issue`, not `pull_request`.
        expect(matchesPreset("pull_request_opened", { action: "opened", issue: { number: 7 } })).toBe(false);
    });

    it("pull request merged", () => {
        expect(matchesPreset("pull_request_merged", { action: "closed", pull_request: { merged: true } })).toBe(true);
        expect(matchesPreset("pull_request_merged", { action: "closed", pull_request: { merged: false } })).toBe(false);
    });

    it("pull request review requested", () => {
        expect(matchesPreset("pull_request_review_requested", { action: "review_requested", ...pullRequest })).toBe(true);
        expect(matchesPreset("pull_request_review_requested", { action: "review_request_removed", ...pullRequest })).toBe(false);
    });

    it("issue assigned, but not a pull request assigned", () => {
        expect(matchesPreset("issue_assigned", { action: "assigned", assignee: { login: "a" }, issue: { number: 3 } })).toBe(true);
        expect(matchesPreset("issue_assigned", { action: "assigned", assignee: { login: "a" }, pull_request: { number: 3 } })).toBe(false);
    });
});

describe("GitLab presets match the event and nothing next to it", () => {
    it("merge request opened", () => {
        expect(matchesPreset("merge_request_opened", { object_attributes: { action: "open" }, object_kind: "merge_request" })).toBe(true);
        expect(matchesPreset("merge_request_opened", { object_attributes: { action: "reopen" }, object_kind: "merge_request" })).toBe(false);
    });

    it("merge request merged", () => {
        expect(matchesPreset("merge_request_merged", { object_attributes: { action: "merge" }, object_kind: "merge_request" })).toBe(true);
        expect(matchesPreset("merge_request_merged", { object_attributes: { action: "close" }, object_kind: "merge_request" })).toBe(false);
    });

    it("a note on a merge request is not a merge request event", () => {
        expect(matchesPreset("merge_request_opened", { merge_request: {}, object_attributes: { action: "open" }, object_kind: "note" })).toBe(false);
    });
});
