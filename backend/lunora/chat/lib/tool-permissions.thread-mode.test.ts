import { describe, expect, it } from "vitest";

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
const CODING_AGENT = builtin("delegateToCodingAgent");
const ASK_USER = builtin("askUser");

describe("thread permission mode", () => {
    it("with no mode, and with auto, every tool resolves as it did before modes existed", () => {
        // Frozen from the resolver as it stood without modes: default, headless clamp and API-key clamp, then a per-tool override.
        const tools: [ToolDescriptor, string][] = [
            [SHELL, "auto auto ask"],
            [WEB_SEARCH, "auto auto ask"],
            [ASK_USER, "ask off ask"],
            [CODING_AGENT, "ask off ask"],
            [builtin("delegateToSubAgent"), "ask off off"],
            [builtin("dateTime"), "auto auto ask"],
            [mcp(), "ask off ask"],
            [mcp({ readOnlyHint: true }), "auto auto ask"],
            [mcp({ destructiveHint: true }), "ask off ask"],
            [{ key: "device:d:run", source: "device" }, "auto off off"],
        ];

        for (const threadMode of [undefined, "auto"] as const) {
            for (const [tool, expected] of tools) {
                const modes = [{}, { headless: true }, { apiKeyOrigin: true }].map((options) =>
                    resolveToolPermission(tool, undefined, { ...options, threadMode }),
                );

                expect(modes.join(" "), tool.key).toBe(expected);
            }

            for (const tool of [SHELL, mcp()]) {
                const overridden = ["auto", "ask", "off"].map((mode) => resolveToolPermission(tool, { [tool.key]: mode as never }, { threadMode }));

                expect(overridden, tool.key).toStrictEqual(["auto", "ask", "off"]);
            }

            expect(lowRiskIneligibleReason(mcp(), false, { threadMode })).toBe("untrusted-server");
        }
    });

    it("supervised asks for every tool that is not a local read-only lookup", () => {
        const options = { threadMode: "supervised" } as const;

        for (const name of ["shellExecution", "fileOperations", "somethingNew", "webSearch", "retrieve", "knowledgeSearch", "searchMemory", "listCurrencies"]) {
            expect(resolveToolPermission(builtin(name), undefined, options)).toBe("ask");
        }

        expect(resolveToolPermission(mcp({ readOnlyHint: true }), undefined, options)).toBe("ask");
        expect(resolveToolPermission(mcp(), undefined, options)).toBe("ask");
        expect(resolveToolPermission(builtin("dateTime"), undefined, options)).toBe("auto");
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
        for (const threadMode of ["supervised", "auto", "full"] as const) {
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

        for (const threadMode of ["supervised", "full"] as const) {
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
});

describe("the quick check under the restrictive modes", () => {
    it("never stands in for a person's approval under supervised", () => {
        expect(lowRiskIneligibleReason(mcp(), false, { lowRiskTrusted: new Set(["srv"]), threadMode: "supervised" })).not.toBeNull();
    });
});

describe("modeOfThread", () => {
    const threads: Record<string, Record<string, unknown>> = {
        child: { _id: "child", userId: "u1" },
        full: { _id: "full", permissionMode: "full", userId: "u1" },
        parent: { _id: "parent", permissionMode: "supervised", userId: "u1" },
    };
    const comparison = (parentThreadId: string) => {
        return { branchType: "comparison", parentThreadId, threadId: "child" };
    };
    const other = { branchType: "continuation", parentThreadId: "other", threadId: "child" };
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
    const modeOf = async (links: Record<string, unknown>[], thread: Record<string, unknown> = threads.child as never, userId = "u1") =>
        await modeOfThread({ db: databaseWith(links) } as never, thread as never, userId);

    it("runs a comparison column under its parent's mode, whatever other link is listed first and whatever mode the column holds", async () => {
        expect(await modeOf([other, comparison("parent")])).toBe("supervised");
        expect(await modeOf([comparison("parent")], { _id: "child", permissionMode: "full", userId: "u1" })).toBe("supervised");
    });

    it("uses the thread's own mode when no link is a comparison, and none for a host thread", async () => {
        expect(await modeOf([other])).toBeNull();
        expect(await modeOf([comparison("parent")], { _id: "host", runner: "host", userId: "u1" })).toBeNull();
    });

    it("keeps the owner's full access from a collaborator", async () => {
        expect(await modeOf([], threads.full as never)).toBe("full");
        expect(await modeOf([], threads.full as never, "u2")).toBeNull();
    });

    it("falls back to the thread's own stored mode, or none, when no single parent can be shown to apply", async () => {
        const own = { _id: "child", permissionMode: "auto", userId: "u1" };
        // 50 is the read bound (`MAX_LINKS_CHECKED`): a comparison past it would be unseen.
        const bounded = Array.from({ length: 50 }, () => {
            return { ...other };
        });

        // A parent that is gone, or in the trash.
        threads.trashed = { _id: "trashed", deleted: true, permissionMode: "supervised", userId: "u1" };

        for (const links of [
            [comparison("gone")],
            [comparison("trashed")],
            [comparison("full"), comparison("parent")],
            [comparison("full"), ...bounded.slice(1)],
        ]) {
            expect(await modeOf(links)).toBeNull();
            expect(await modeOf(links, own)).toBe("auto");
            expect(await modeOf(links, { ...own, permissionMode: "full" }, "u2")).toBeNull();
        }

        // The setter refuses exactly the threads `modeOfThread` runs under a parent's mode: one live comparison parent, links in one read.
        await expect(isComparisonColumn({ db: databaseWith([comparison("parent")]) } as never, "child" as never)).resolves.toBe(true);
        await expect(isComparisonColumn({ db: databaseWith([...bounded, comparison("parent")]) } as never, "child" as never)).resolves.toBe(false);
        await expect(isComparisonColumn({ db: databaseWith([comparison("full"), comparison("parent")]) } as never, "child" as never)).resolves.toBe(false);
        await expect(isComparisonColumn({ db: databaseWith([comparison("trashed")]) } as never, "child" as never)).resolves.toBe(false);
    });
});

describe("thread permission mode under an organization's cap", () => {
    it("never lifts a tool above the organization's cap, not even under full", () => {
        // `full` runs a tool that would ask; an `ask` cap holds it at `ask`, and an `off` cap removes it.
        expect(resolveToolPermission(mcp(), undefined, { permissionCap: "ask", threadMode: "full" })).toBe("ask");
        expect(resolveToolPermission(mcp(), undefined, { permissionCap: "off", threadMode: "full" })).toBe("off");
        // An "Always allow" the member set is held by the cap the same way.
        expect(resolveToolPermission(mcp(), { [mcp().key]: "auto" }, { permissionCap: "ask", threadMode: "full" })).toBe("ask");
    });

    it("still lets supervised hold a tool below an auto cap", () => {
        expect(resolveToolPermission(SHELL, undefined, { permissionCap: "auto", threadMode: "supervised" })).toBe("ask");
    });
});
