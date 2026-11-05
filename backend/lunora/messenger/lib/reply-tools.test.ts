import { DEFAULT_CHAT_MODEL } from "@neore/ai/constants";
import { deriveModelRegions, getModelRejectionReason, GLOBAL_REGION, MODEL_REGISTRY } from "@neore/ai/models";
import { describe, expect, it } from "vitest";

import { backupCapabilities } from "../../chat/lib/backup-model";
import { listBuiltInTools, modelSupportsTools } from "../../chat/lib/tool-builder";
import { applyToolPermissions, BUILTIN_TOOLS_ASK_BY_DEFAULT, BUILTIN_TOOLS_NEEDING_A_PERSON, toolPermissionKey } from "../../chat/lib/tool-permissions";
import {
    chooseReplyModel,
    MESSENGER_FILE_MODEL,
    MESSENGER_MEDIA_MODEL,
    MESSENGER_REPLY_TOOL_GROUPS,
    normalizeReplyToolGroups,
    planReplyTools,
} from "./reply-tools";

describe(planReplyTools, () => {
    it("gives no tools when the setting is absent, off, or has no known group", () => {
        expect(planReplyTools(undefined)).toBeNull();
        expect(planReplyTools(null)).toBeNull();
        expect(planReplyTools({ enabled: false, groups: ["webSearch"] })).toBeNull();
        expect(planReplyTools({ enabled: true, groups: [] })).toBeNull();
        expect(planReplyTools({ enabled: true, groups: ["browser", "deepResearch"] })).toBeNull();
    });

    it("enables every group when none were picked", () => {
        expect(planReplyTools({ enabled: true })).toStrictEqual({
            additionalTools: ["imageGeneration"],
            allowlist: ["webSearch", "retrieve", "imageGeneration", "codeExecution", "shellExecution", "fileOperations", "knowledgeSearch", "dateTime"],
            keepMcpTools: true,
        });
    });

    it("narrows to the picked groups and keeps MCP tools only for `connectors`", () => {
        expect(planReplyTools({ enabled: true, groups: ["dateTime", "webSearch"] })).toStrictEqual({
            additionalTools: [],
            allowlist: ["webSearch", "dateTime"],
            keepMcpTools: false,
        });
    });

    it("never allows a tool that needs a person or defaults to ask", () => {
        const { allowlist } = planReplyTools({ enabled: true })!;

        for (const name of [...BUILTIN_TOOLS_NEEDING_A_PERSON, ...BUILTIN_TOOLS_ASK_BY_DEFAULT, "browser", "deepResearch", "searchMemory"]) {
            expect(allowlist).not.toContain(name);
        }
    });

    it("names only real built-in tools", () => {
        const builtIns = new Set(listBuiltInTools().map((tool) => tool.name as string));

        const { allowlist } = planReplyTools({ enabled: true })!;

        for (const name of allowlist) {
            expect(builtIns.has(name)).toBe(true);
        }
    });
});

describe("a messenger reply's tools under the owner's permissions", () => {
    it("drops what the owner set to ask — built-in, MCP or connector — and keeps auto", () => {
        const connector = (name: string) => {
            return { key: toolPermissionKey("connector", name, "github"), source: "connector" as const };
        };
        const { tools } = applyToolPermissions(
            { dateTime: {}, github_create_issue: {}, github_search: {}, webSearch: {} } as never,
            (name) => (name.startsWith("github_") ? connector(name.slice("github_".length)) : undefined),
            {
                [toolPermissionKey("builtin", "webSearch")]: "ask",
                [toolPermissionKey("connector", "create_issue", "github")]: "ask",
                [toolPermissionKey("connector", "search", "github")]: "auto",
            },
            { headless: true },
        );

        expect(Object.keys(tools)).toStrictEqual(["dateTime", "github_search"]);
    });
});

describe(normalizeReplyToolGroups, () => {
    it("drops unknown names and duplicates, in canonical order", () => {
        expect(normalizeReplyToolGroups(["knowledge", "x", "webSearch", "knowledge"])).toStrictEqual(["webSearch", "knowledge"]);
        expect(normalizeReplyToolGroups(undefined)).toStrictEqual([...MESSENGER_REPLY_TOOL_GROUPS]);
    });
});

describe(chooseReplyModel, () => {
    it("uses the media model for media threads and tool replies, the default otherwise", () => {
        expect(chooseReplyModel({ media: "none", tools: false })).toBe(DEFAULT_CHAT_MODEL);
        expect(chooseReplyModel({ media: "images", tools: false })).toBe(MESSENGER_MEDIA_MODEL);
        expect(chooseReplyModel({ media: "none", tools: true })).toBe(MESSENGER_MEDIA_MODEL);
    });

    it("moves the media model under a region rule to one the rules allow that still reads images and calls tools", () => {
        const model = chooseReplyModel({ media: "images", rules: { blockedRegions: ["CN"] }, tools: false });
        const definition = MODEL_REGISTRY.find((candidate) => candidate.id === model);

        expect(model).not.toBe(MESSENGER_MEDIA_MODEL);
        expect(definition?.supportsImages).toBe(true);
        expect(modelSupportsTools(model)).toBe(true);
        // It passes the rules the gateway enforces: not served from any region, and allowed with CN blocked.
        expect(deriveModelRegions(definition!)).not.toContain(GLOBAL_REGION);
        expect(
            getModelRejectionReason({ modelId: model, provider: definition!.provider, regions: deriveModelRegions(definition!) }, { blockedRegions: ["CN"] }),
        ).toBeNull();
        expect(chooseReplyModel({ media: "none", rules: { blockedRegions: ["CN"] }, tools: false })).toBe(DEFAULT_CHAT_MODEL);
    });

    it("needs only tool calling from a stand-in for a tool reply without media", () => {
        const rules = { allowedModels: [MESSENGER_MEDIA_MODEL, "cf-gpt-oss-120b"], blockedModels: [MESSENGER_MEDIA_MODEL] };

        expect(chooseReplyModel({ media: "none", rules, tools: true })).toBe("cf-gpt-oss-120b");
        expect(chooseReplyModel({ media: "images", rules, tools: true })).toBe(MESSENGER_MEDIA_MODEL);
    });

    it("uses a file reader for a thread that still holds a PDF part", () => {
        const definition = MODEL_REGISTRY.find((candidate) => candidate.id === MESSENGER_FILE_MODEL);

        expect(chooseReplyModel({ media: "files", tools: false })).toBe(MESSENGER_FILE_MODEL);
        expect(definition?.enabled).not.toBe(false);
        expect(backupCapabilities(definition!)).toStrictEqual({ files: true, images: true, tools: true });
    });

    it("picks an enabled, image-reading registry model for tool replies", () => {
        const model = MODEL_REGISTRY.find((candidate) => candidate.id === MESSENGER_MEDIA_MODEL);

        expect(model?.enabled).toBe(true);
        expect(model?.supportsImages).toBe(true);
        expect(modelSupportsTools(MESSENGER_MEDIA_MODEL)).toBe(true);
    });
});
