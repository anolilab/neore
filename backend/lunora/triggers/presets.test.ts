import { describe, expect, it } from "vitest";

import { assertValidFilters, evaluateFilters } from "./filters";
import { compileWebhookPreset, presetEventsOf } from "./presets";

/** Whether the preset's compiled filters accept a body. */
const matchesPreset = (provider: "github" | "gitlab", event: Parameters<typeof compileWebhookPreset>[0]["event"], body: unknown): boolean => {
    const compiled = compileWebhookPreset({ event, provider });

    if (!compiled) {
        throw new Error(`no preset for ${provider} ${event}`);
    }

    return evaluateFilters(compiled.filters, JSON.stringify(body)).matched;
};

describe("provider presets", () => {
    it("signs each provider with its own scheme", () => {
        expect(compileWebhookPreset({ event: "pull_request_opened", provider: "github" })?.scheme).toBe("native");
        expect(compileWebhookPreset({ event: "merge_request_merged", provider: "gitlab" })?.scheme).toBe("gitlab-token");
    });

    it("refuses an event that belongs to another provider", () => {
        expect(compileWebhookPreset({ event: "pull_request_opened", provider: "gitlab" })).toBeUndefined();
        expect(compileWebhookPreset({ event: "merge_request_opened", provider: "github" })).toBeUndefined();
    });

    it("offers the events of each provider", () => {
        const byName = (a: string, b: string) => a.localeCompare(b);

        expect(presetEventsOf("github").toSorted(byName)).toEqual(
            ["issue_assigned", "pull_request_merged", "pull_request_opened", "pull_request_review_requested"].toSorted(byName),
        );
        expect(presetEventsOf("gitlab").toSorted(byName)).toEqual(["merge_request_merged", "merge_request_opened"]);
    });

    it("compiles only to filters the backend accepts", () => {
        for (const provider of ["github", "gitlab"] as const) {
            for (const event of presetEventsOf(provider)) {
                const compiled = compileWebhookPreset({ event, provider });

                expect(() => assertValidFilters(compiled?.filters ?? [])).not.toThrow();
            }
        }
    });

    it("hands out a copy of its filters, so a caller cannot edit the table", () => {
        const first = compileWebhookPreset({ event: "pull_request_opened", provider: "github" });

        first?.filters.push({ op: "exists", path: "x" });

        expect(compileWebhookPreset({ event: "pull_request_opened", provider: "github" })?.filters).toHaveLength(2);
    });
});

describe("GitHub presets match the event and nothing next to it", () => {
    const pullRequest = { number: 7, pull_request: { merged: false, number: 7 } };

    it("pull request opened", () => {
        expect(matchesPreset("github", "pull_request_opened", { action: "opened", ...pullRequest })).toBe(true);
        expect(matchesPreset("github", "pull_request_opened", { action: "reopened", ...pullRequest })).toBe(false);
        // An issue opened carries `issue`, not `pull_request`.
        expect(matchesPreset("github", "pull_request_opened", { action: "opened", issue: { number: 7 } })).toBe(false);
    });

    it("pull request merged", () => {
        expect(matchesPreset("github", "pull_request_merged", { action: "closed", pull_request: { merged: true } })).toBe(true);
        expect(matchesPreset("github", "pull_request_merged", { action: "closed", pull_request: { merged: false } })).toBe(false);
    });

    it("pull request review requested", () => {
        expect(matchesPreset("github", "pull_request_review_requested", { action: "review_requested", ...pullRequest })).toBe(true);
        expect(matchesPreset("github", "pull_request_review_requested", { action: "review_request_removed", ...pullRequest })).toBe(false);
    });

    it("issue assigned, but not a pull request assigned", () => {
        expect(matchesPreset("github", "issue_assigned", { action: "assigned", assignee: { login: "a" }, issue: { number: 3 } })).toBe(true);
        expect(matchesPreset("github", "issue_assigned", { action: "assigned", assignee: { login: "a" }, pull_request: { number: 3 } })).toBe(false);
    });
});

describe("GitLab presets match the event and nothing next to it", () => {
    it("merge request opened", () => {
        expect(matchesPreset("gitlab", "merge_request_opened", { object_attributes: { action: "open" }, object_kind: "merge_request" })).toBe(true);
        expect(matchesPreset("gitlab", "merge_request_opened", { object_attributes: { action: "reopen" }, object_kind: "merge_request" })).toBe(false);
    });

    it("merge request merged", () => {
        expect(matchesPreset("gitlab", "merge_request_merged", { object_attributes: { action: "merge" }, object_kind: "merge_request" })).toBe(true);
        expect(matchesPreset("gitlab", "merge_request_merged", { object_attributes: { action: "close" }, object_kind: "merge_request" })).toBe(false);
    });

    it("a note on a merge request is not a merge request event", () => {
        expect(matchesPreset("gitlab", "merge_request_opened", { merge_request: {}, object_attributes: { action: "open" }, object_kind: "note" })).toBe(false);
    });
});
