import { describe, expect, it } from "vitest";

import { BUILTIN_TOOLS_FILE_EDIT, BUILTIN_TOOLS_READ_ONLY, isThreadPermissionMode } from "./thread-permission-mode";
import type { ToolDescriptor } from "./tool-permissions";
import { lowRiskIneligibleReason } from "./low-risk-approval";
import { isComparisonColumn, modeOfThread } from "../tool-permissions";
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
        expect(resolveToolPermission(WEB_SEARCH, undefined, options)).toBe("ask");
        expect(resolveToolPermission(builtin("visionAnalysis"), undefined, options)).toBe("ask");
        expect(resolveToolPermission(builtin("retrieve"), undefined, options)).toBe("ask");
        expect(resolveToolPermission(builtin("knowledgeSearch"), undefined, options)).toBe("ask");
        expect(resolveToolPermission(mcp({ readOnlyHint: true }), undefined, options)).toBe("ask");
        expect(resolveToolPermission(mcp(), undefined, options)).toBe("ask");
        // Their queries or lookups reach a provider (a currency list fetches rates; a memory search embeds the query).
        expect(resolveToolPermission(builtin("listCurrencies"), undefined, options)).toBe("ask");
        expect(resolveToolPermission(builtin("searchMemory"), undefined, options)).toBe("ask");
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
        expect(resolveToolPermission(WEB_SEARCH, undefined, options)).toBe("ask");
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

describe("modeOfThread", () => {
    const threads: Record<string, Record<string, unknown>> = {
        child: { _id: "child", userId: "u1" },
        parent: { _id: "parent", permissionMode: "supervised", userId: "u1" },
    };
    const databaseWith = (links: Record<string, unknown>[]) => {
        return {
            get: async (_table: string, id: string) => threads[id] ?? null,
            query: () => {
                return {
                    withIndex: () => {
                        // As the index read does: at most `count` rows, in order.
                        return { take: async (count: number) => links.slice(0, count) };
                    },
                };
            },
        };
    };

    it("takes the comparison parent's mode even when another link for the child is listed first", async () => {
        const db = databaseWith([
            { branchType: "continuation", parentThreadId: "other", threadId: "child" },
            { branchType: "comparison", parentThreadId: "parent", threadId: "child" },
        ]);

        await expect(modeOfThread({ db } as never, threads.child as never, "u1")).resolves.toBe("supervised");
    });

    it("runs a comparison column under its parent's mode even when the column holds a mode of its own", async () => {
        const own = { _id: "child-own", permissionMode: "full", userId: "u1" };
        const db = databaseWith([{ branchType: "comparison", parentThreadId: "parent", threadId: "child-own" }]);

        threads["child-own"] = own;

        await expect(modeOfThread({ db } as never, own as never, "u1")).resolves.toBe("supervised");
    });

    it("uses the thread's own mode, and no parent, when no link is a comparison", async () => {
        const db = databaseWith([{ branchType: "continuation", parentThreadId: "parent", threadId: "child" }]);

        await expect(modeOfThread({ db } as never, threads.child as never, "u1")).resolves.toBeNull();
    });

    it("gives a host thread no mode, even when a comparison link names a supervised parent", async () => {
        const host = { _id: "host", runner: "host", userId: "u1" };
        const db = databaseWith([{ branchType: "comparison", parentThreadId: "parent", threadId: "host" }]);

        await expect(modeOfThread({ db } as never, host as never, "u1")).resolves.toBeNull();
    });

    it("runs an orphaned comparison column under its own mode once it holds one", async () => {
        // The parent was deleted and its link rows stayed behind: the column's own saved mode applies, not the defaults.
        const orphan = { _id: "orphan", permissionMode: "auto", userId: "u1" };
        const db = databaseWith([{ branchType: "comparison", parentThreadId: "deleted-parent", threadId: "orphan" }]);

        await expect(modeOfThread({ db } as never, orphan as never, "u1")).resolves.toBe("auto");
    });

    it("runs an orphaned comparison column supervised when it holds no mode of its own", async () => {
        const orphan = { _id: "orphan-bare", userId: "u1" };
        const db = databaseWith([{ branchType: "comparison", parentThreadId: "deleted-parent", threadId: "orphan-bare" }]);

        await expect(modeOfThread({ db } as never, orphan as never, "u1")).resolves.toBe("supervised");
    });

    it("keeps an orphaned column supervised for a collaborator, whose owner's full access is not theirs to run under", async () => {
        const orphan = { _id: "orphan-full", permissionMode: "full", userId: "u1" };
        const db = databaseWith([{ branchType: "comparison", parentThreadId: "deleted-parent", threadId: "orphan-full" }]);

        await expect(modeOfThread({ db } as never, orphan as never, "u2")).resolves.toBe("supervised");
    });

    it("fails closed when a child has comparison links to two different parents", async () => {
        // The first listed parent is the looser one: taking it would run the column under `auto`.
        threads.free = { _id: "free", permissionMode: "auto", userId: "u1" };
        const db = databaseWith([
            { branchType: "comparison", parentThreadId: "free", threadId: "child" },
            { branchType: "comparison", parentThreadId: "parent", threadId: "child" },
        ]);

        await expect(modeOfThread({ db } as never, threads.child as never, "u1")).resolves.toBe("supervised");
    });

    it("fails closed when the link rows reach the read bound, even with a permissive comparison among the rows read", async () => {
        // The first comparison is permissive (full). A restrictive one sits beyond the bound and is never read: the child must not run full.
        threads.permissive = { _id: "permissive", permissionMode: "full", userId: "u1" };
        const rows = [
            { branchType: "comparison", parentThreadId: "permissive", threadId: "child" },
            ...Array.from({ length: 49 }, () => {
                return { branchType: "continuation", parentThreadId: "other", threadId: "child" };
            }),
            { branchType: "comparison", parentThreadId: "parent", threadId: "child" },
        ];

        await expect(modeOfThread({ db: databaseWith(rows) } as never, threads.child as never, "u1")).resolves.toBe("supervised");
    });

    it("counts a column whose link rows reach the bound as a comparison column, so the mode setter refuses it", async () => {
        // The live comparison is the 51st row: the bounded read shows only continuation links, which must not read as "not a column".
        const rows = [
            ...Array.from({ length: 50 }, () => {
                return { branchType: "continuation", parentThreadId: "other", threadId: "child" };
            }),
            { branchType: "comparison", parentThreadId: "parent", threadId: "child" },
        ];

        await expect(isComparisonColumn({ db: databaseWith(rows) } as never, "child" as never)).resolves.toBe(true);
    });

    it("fails closed when the link rows reach the read bound without showing a comparison", async () => {
        // 50 is the read bound (`MAX_LINKS_CHECKED`): a comparison link past it would be unseen, so the thread runs supervised.
        const rows = Array.from({ length: 50 }, () => {
            return { branchType: "continuation", parentThreadId: "other", threadId: "child" };
        });

        await expect(modeOfThread({ db: databaseWith(rows) } as never, threads.child as never, "u1")).resolves.toBe("supervised");
    });
});
