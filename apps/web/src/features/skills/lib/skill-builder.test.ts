import { describe, expect, it } from "vitest";

import type { BuilderDraft, BuilderRecommendations } from "./skill-builder";
import {
    acceptedMcpServers,
    buildDraftDiff,
    carryAcceptance,
    connectorStatus,
    connectorStatuses,
    defaultAcceptance,
    diffLines,
    isConnectorActionable,
    toCreateSkillArgs,
    toSkillConfig,
} from "./skill-builder";

const draft: BuilderDraft = {
    category: "research",
    description: "Summarise a topic.",
    disableTools: [{ name: "imageGeneration", reason: "Not needed" }],
    enableTools: [
        { name: "webSearch", reason: "Sources" },
        { name: "codeExecution", reason: "Charts" },
    ],
    instructions: "Line one\nLine two\nLine three",
    name: "Topic brief",
    preferredModel: { id: "openai/gpt-5", name: "GPT-5", reason: "Reasoning" },
    reasoningEffort: { reason: "Depth", value: 2 },
    searchMode: { id: "web", reason: "Web" },
    slug: "topic-brief",
    tags: ["research"],
    variables: [{ name: "topic", required: true }],
};

const recommendations: BuilderRecommendations = {
    connectors: [{ id: "github", reason: "Repos" }],
    marketplaceSkills: [],
    mcpRegistryAvailable: true,
    mcpServers: [{ reason: "Errors", server: { description: "Sentry", id: "io.sentry/mcp", remotes: [], title: "Sentry" } }],
};

describe("acceptance", () => {
    it("accepts draft settings and rejects external recommendations by default", () => {
        const acceptance = defaultAcceptance(draft, recommendations);

        expect(acceptance.enableTools).toStrictEqual({ codeExecution: true, webSearch: true });
        expect(acceptance.mcpServers).toStrictEqual({ "io.sentry/mcp": false });
        expect(acceptance.connectors).toStrictEqual({ github: false });
        expect(acceptedMcpServers(recommendations, acceptance)).toStrictEqual([]);
    });

    it("builds config from accepted items only", () => {
        const acceptance = { ...defaultAcceptance(draft, recommendations), enableTools: { codeExecution: false, webSearch: true }, preferredModel: false };

        expect(toSkillConfig(draft, acceptance)).toStrictEqual({
            additionalTools: ["webSearch"],
            disabledTools: ["imageGeneration"],
            reasoningEffort: 2,
            searchMode: "web",
        });
    });

    it("saves privately through the editor source", () => {
        const args = toCreateSkillArgs(draft, defaultAcceptance(draft, recommendations));

        expect(args.visibility).toBe("private");
        expect(args.source).toStrictEqual({ type: "editor" });
        expect(args.config.preferredModel).toBe("openai/gpt-5");
    });

    it("keeps choices across a refinement and accepts new tools", () => {
        const previous = { ...defaultAcceptance(draft, recommendations), enableTools: { codeExecution: false, webSearch: true } };
        const refined = { ...draft, enableTools: [...draft.enableTools, { name: "datetime", reason: "Dates" }] };

        expect(carryAcceptance(previous, refined).enableTools).toStrictEqual({ codeExecution: false, datetime: true, webSearch: true });
    });
});

describe("diffLines", () => {
    it("marks added, removed and unchanged lines", () => {
        expect(diffLines("a\nb\nc", "a\nx\nc")).toStrictEqual([
            { kind: "same", text: "a" },
            { kind: "removed", text: "b" },
            { kind: "added", text: "x" },
            { kind: "same", text: "c" },
        ]);
    });

    it("handles pure appends", () => {
        expect(diffLines("a", "a\nb")).toStrictEqual([
            { kind: "same", text: "a" },
            { kind: "added", text: "b" },
        ]);
    });
});

describe("buildDraftDiff", () => {
    it("diffs the reported fields, with a line diff for instructions", () => {
        const after = { ...draft, description: "Short summaries.", instructions: "Line one\nLine 2\nLine three" };
        const diff = buildDraftDiff(draft, after, ["description", "instructions"]);

        expect(diff.map((entry) => entry.field)).toStrictEqual(["description", "instructions"]);
        expect(diff[0]).toStrictEqual({ after: "Short summaries.", before: "Summarise a topic.", field: "description" });
        expect(diff[1]?.lines?.filter((line) => line.kind !== "same")).toStrictEqual([
            { kind: "removed", text: "Line two" },
            { kind: "added", text: "Line 2" },
        ]);
    });

    it("skips a field whose visible value is unchanged", () => {
        const after = { ...draft, preferredModel: { ...draft.preferredModel!, reason: "New reason" } };

        expect(buildDraftDiff(draft, after, ["preferredModel"])).toStrictEqual([]);
    });

    it("shows a cleared model as an empty after value", () => {
        const after = { ...draft, preferredModel: undefined };

        expect(buildDraftDiff(draft, after, ["preferredModel"])).toStrictEqual([{ after: "", before: "GPT-5", field: "preferredModel" }]);
    });
});

describe("connectorStatus", () => {
    const NOW = 10_000;

    it("maps catalogue entries to a status, as the connectors settings page reads them", () => {
        const catalog = [
            { configured: true, connection: { status: "connected" as const }, slug: "github" },
            { configured: true, connection: { status: "expired" as const }, slug: "notion" },
            { configured: true, connection: { status: "error" as const }, slug: "gmail" },
            { configured: false, connection: null, slug: "slack" },
            { configured: true, connection: { status: "disconnected" as const }, slug: "google-drive" },
            { configured: true, connection: { hasRefreshToken: false, status: "connected" as const, tokenExpiresAt: NOW - 1 }, slug: "linear" },
            { configured: true, connection: { hasRefreshToken: true, status: "connected" as const, tokenExpiresAt: NOW - 1 }, slug: "jira-cloud" },
        ];

        expect(connectorStatuses(catalog, ["github", "notion", "gmail", "slack", "google-drive", "linear", "jira-cloud", "jira"], NOW)).toStrictEqual({
            github: "connected",
            gmail: "expired",
            "google-drive": "available",
            jira: "notConfigured",
            "jira-cloud": "connected",
            linear: "expired",
            notion: "expired",
            slack: "notConfigured",
        });
    });

    it("reads as not configured while the catalogue is unknown", () => {
        expect(connectorStatus(undefined, NOW)).toBe("notConfigured");
    });
});

describe("isConnectorActionable", () => {
    it("offers Connect only when it can do something", () => {
        expect(isConnectorActionable("available")).toBe(true);
        expect(isConnectorActionable("expired")).toBe(true);
        expect(isConnectorActionable(undefined)).toBe(true);
        expect(isConnectorActionable("connected")).toBe(false);
        expect(isConnectorActionable("notConfigured")).toBe(false);
    });
});
