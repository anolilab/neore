import { describe, expect, it } from "vitest";

import { BUILTIN_TOOLS_FILE_EDIT, BUILTIN_TOOLS_READ_ONLY, isThreadPermissionMode } from "./thread-permission-mode";
import type { ToolDescriptor } from "./tool-permissions";
import { lowRiskIneligibleReason } from "./low-risk-approval";
import { resolveToolPermission, resolveToolPermissionWithGrant, toolPermissionKey } from "./tool-permissions";

const builtin = (name: string): ToolDescriptor => {
    return { key: toolPermissionKey("builtin", name), source: "builtin" };
};
const mcp = (annotations?: ToolDescriptor["annotations"]): ToolDescriptor => {
    return { annotations, key: "mcp:srv:do_thing", source: "mcp" };
};

const WEB_SEARCH = builtin("webSearch");
const SHELL = builtin("shellExecution");
const FILES = builtin("fileOperations");
const CODING_AGENT = builtin("delegateToCodingAgent");
const ASK_USER = builtin("askUser");

describe("thread permission mode", () => {
    it("auto and an absent mode change nothing", () => {
        for (const tool of [WEB_SEARCH, SHELL, FILES, CODING_AGENT, ASK_USER, mcp(), mcp({ readOnlyHint: true })]) {
            expect(resolveToolPermission(tool, undefined, { threadMode: "auto" })).toBe(resolveToolPermission(tool, undefined));
        }
    });

    it("supervised asks for every built-in that is not read-only, and keeps read-only ones", () => {
        const options = { threadMode: "supervised" } as const;

        expect(resolveToolPermission(SHELL, undefined, options)).toBe("ask");
        expect(resolveToolPermission(FILES, undefined, options)).toBe("ask");
        expect(resolveToolPermission(builtin("somethingNew"), undefined, options)).toBe("ask");
        expect(resolveToolPermission(WEB_SEARCH, undefined, options)).toBe("auto");
        expect(resolveToolPermission(builtin("visionAnalysis"), undefined, options)).toBe("ask");
        expect(resolveToolPermission(builtin("retrieve"), undefined, options)).toBe("ask");
        expect(resolveToolPermission(builtin("knowledgeSearch"), undefined, options)).toBe("ask");
        expect(resolveToolPermission(mcp({ readOnlyHint: true }), undefined, options)).toBe("ask");
        expect(resolveToolPermission(mcp(), undefined, options)).toBe("ask");
    });

    it("auto-edit asks for document edits too, since its file-edit list is empty", () => {
        const options = { threadMode: "auto-edit" } as const;

        expect(resolveToolPermission(FILES, undefined, options)).toBe("ask");
        expect(resolveToolPermission(builtin("updateDocument"), undefined, options)).toBe("ask");
        expect(resolveToolPermission(builtin("createDocument"), undefined, options)).toBe("ask");
        expect(resolveToolPermission(builtin("updateDesign"), undefined, options)).toBe("ask");
        expect(resolveToolPermission(builtin("createDesign"), undefined, options)).toBe("ask");
        expect(resolveToolPermission(builtin("createPresentation"), undefined, options)).toBe("ask");
        expect(resolveToolPermission(builtin("updateSlide"), undefined, options)).toBe("ask");
        expect(resolveToolPermission(SHELL, undefined, options)).toBe("ask");
        expect(resolveToolPermission(builtin("browser"), undefined, options)).toBe("ask");
        expect(resolveToolPermission(WEB_SEARCH, undefined, options)).toBe("auto");
        expect(resolveToolPermission(mcp(), undefined, options)).toBe("ask");
    });

    it("full turns every ask into auto except the tools that need a person", () => {
        const options = { threadMode: "full" } as const;

        expect(resolveToolPermission(CODING_AGENT, undefined, options)).toBe("auto");
        expect(resolveToolPermission(mcp(), undefined, options)).toBe("auto");
        expect(resolveToolPermission(mcp({ destructiveHint: true }), undefined, options)).toBe("auto");
        expect(resolveToolPermission(ASK_USER, undefined, options)).toBe("ask");
        expect(resolveToolPermission(builtin("requestSecret"), undefined, options)).toBe("ask");
    });

    it("off wins in every mode", () => {
        for (const threadMode of ["supervised", "auto-edit", "auto", "full"] as const) {
            expect(resolveToolPermission(SHELL, { [SHELL.key]: "off" }, { threadMode })).toBe("off");
            expect(resolveToolPermission(mcp(), { [mcp().key]: "off" }, { threadMode })).toBe("off");
        }
    });

    it("a per-tool override beats the mode in both directions", () => {
        expect(resolveToolPermission(SHELL, { [SHELL.key]: "auto" }, { threadMode: "supervised" })).toBe("auto");
        expect(resolveToolPermission(mcp(), { [mcp().key]: "ask" }, { threadMode: "full" })).toBe("ask");
        expect(resolveToolPermission(WEB_SEARCH, { [WEB_SEARCH.key]: "ask" }, { threadMode: "full" })).toBe("ask");
    });

    it("a headless run ignores the mode and keeps its clamp", () => {
        expect(resolveToolPermission(SHELL, undefined, { headless: true, threadMode: "supervised" })).toBe("auto");
        expect(resolveToolPermission(mcp(), undefined, { headless: true, threadMode: "full" })).toBe("off");
        expect(resolveToolPermission(CODING_AGENT, undefined, { headless: true, threadMode: "full" })).toBe("off");
    });

    it("device tools keep their own default in every mode", () => {
        const device: ToolDescriptor = { key: "device:d1:shell_run", source: "device" };

        for (const threadMode of ["supervised", "auto-edit", "full"] as const) {
            expect(resolveToolPermission(device, undefined, { threadMode })).toBe("auto");
        }
    });

    it("the API-key clamp still applies under full", () => {
        expect(resolveToolPermission(SHELL, undefined, { apiKeyOrigin: true, threadMode: "full" })).toBe("ask");
        expect(resolveToolPermission(mcp(), undefined, { apiKeyOrigin: true, threadMode: "full" })).toBe("ask");
        expect(resolveToolPermission(builtin("delegateToSubAgent"), undefined, { apiKeyOrigin: true, threadMode: "full" })).toBe("off");
    });

    it("a time-boxed grant lifts a tool the mode made ask", () => {
        const now = 1000;
        const result = resolveToolPermissionWithGrant(SHELL, undefined, { now, threadMode: "supervised", timedGrants: { [SHELL.key]: now + 500 } });

        expect(result).toStrictEqual({ mode: "auto", timedUntil: now + 500 });
    });

    it("keeps its classification lists consistent", () => {
        expect(isThreadPermissionMode("auto-edit")).toBe(true);
        expect(isThreadPermissionMode("yolo")).toBe(false);

        for (const name of BUILTIN_TOOLS_FILE_EDIT) {
            expect(BUILTIN_TOOLS_READ_ONLY.has(name)).toBe(false);
        }
    });
});

describe("the quick check under the restrictive modes", () => {
    it("never stands in for a person's approval under supervised or auto-edit", () => {
        expect(lowRiskIneligibleReason(mcp(), false, { lowRiskTrusted: new Set(["srv"]), threadMode: "supervised" })).not.toBeNull();
        expect(lowRiskIneligibleReason(SHELL, false, { threadMode: "auto-edit" })).not.toBeNull();
    });
});
