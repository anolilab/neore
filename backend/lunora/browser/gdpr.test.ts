/**
 * The browser tables in the data export: the user's own rows with what describes their use, never a credential or the
 * live view's bookkeeping, and every page of a history longer than one.
 */
import { lunoraTest } from "@lunora/testing";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import schema from "../schema";
import { browserExportPageKey, browserExportPrefix, type BrowserExport, readAllBrowserPages, storeAllBrowserPages } from "./export-pages";
import { collectBrowserForExport, deleteUserBrowserExportPages, EXPORT_FIELD_BYTES, storeBrowserExportPage } from "./gdpr";

const A = "user-a";
const B = "user-b";

/** Every capability cut, and those past what a list can hold left out. */
const CUT_CAPABILITIES = /^capabilities\[0,1,.*-\]$/u;

let harness: ReturnType<typeof lunoraTest>;

const seed = async (userId: string, actions: number, targetBytes = 0): Promise<void> => {
    await harness.run(async (ctx: any) => {
        const threadId = await ctx.db.insert("threads", { status: "active", title: "T", userId });
        const sessionId = await ctx.db.insert("browserSessions", {
            connectUrl: `wss://renderer.example/connect?token=secret-${userId}`,
            control: { by: "holder-hash", claim: "claim-token", since: 1, until: 2 },
            currentUrl: `https://${userId}.example.com/page`,
            inUseHolds: [5],
            lastActivityAt: 20,
            providerSessionId: `provider-${userId}`,
            reapedHolds: [6],
            startedAt: 10,
            status: "completed",
            threadId,
            userId,
        });

        for (let index = 0; index < actions; index += 1) {
            await ctx.db.insert("browserActions", {
                action: "type",
                sessionId,
                success: 1,
                target: `#field-${userId}${"t".repeat(targetBytes)}`,
                timestamp: 100 + index,
                value: `typed-secret-${userId}`,
            });
        }

        await ctx.db.insert("browserHumanChecks", { askedAt: 30, inText: true, run: "run-1", site: `${userId}.example.com`, threadId, userId });
        await ctx.db.insert("browserExtensions", {
            browserInfo: "Chrome 140",
            extensionId: `ext-${userId}`,
            pairedAt: 40,
            pairingCode: `pairing-${userId}`,
            status: "paired",
            userId,
        });
    });
};

/** The export as the workflow and the export file's action build it: every page stored, then read back in order. */
const exportOf = async (userId: string): Promise<{ pages: number; result: BrowserExport }> => {
    const stored: string[] = [];
    const pages = await storeAllBrowserPages(async (cursor) => {
        const { next, ...rows } = await harness.run(async (ctx: any) => await ctx.runQuery(collectBrowserForExport, { cursor, userId }));

        stored.push(JSON.stringify(rows));

        return { next };
    });
    const result = await readAllBrowserPages(async (page) => stored[page] as string, pages.pages, Infinity);

    return { pages: pages.pages, result };
};

beforeEach(() => {
    harness = lunoraTest(schema as never);
});

afterEach(() => {
    harness.close();
});

describe("browser data in the GDPR export", () => {
    it("exports the user's sessions, actions, human checks and extensions with the kept fields", async () => {
        await seed(A, 2);

        const { result } = await exportOf(A);

        expect(result.sessions).toEqual([
            expect.objectContaining({ currentUrl: "https://user-a.example.com/page", lastActivityAt: 20, startedAt: 10, status: "completed" }),
        ]);
        expect(result.actions).toHaveLength(2);
        expect(result.actions[0]).toEqual(
            expect.objectContaining({
                action: "type",
                sessionId: (result.sessions[0] as { id: string }).id,
                success: true,
                target: "#field-user-a",
                timestamp: 100,
            }),
        );
        expect(result.humanChecks).toEqual([expect.objectContaining({ askedAt: 30, inText: true, site: "user-a.example.com" })]);
        expect(result.extensions).toEqual([expect.objectContaining({ browserInfo: "Chrome 140", extensionId: "ext-user-a", pairedAt: 40, status: "paired" })]);
    });

    it("leaves out credentials, typed values and the live view's bookkeeping", async () => {
        await seed(A, 1);

        const { result } = await exportOf(A);
        const json = JSON.stringify(result);

        for (const absent of ["connectUrl", "providerSessionId", "control", "inUseHolds", "reapedHolds", "value", "pairingCode", "run"]) {
            expect(json).not.toContain(`"${absent}"`);
        }

        expect(json).not.toContain("secret");
        expect(json).not.toContain("pairing-user-a");
        expect(json).not.toContain("claim-token");
    });

    it("includes no other user's rows", async () => {
        await seed(A, 1);
        await seed(B, 3);

        const { result } = await exportOf(A);

        expect(result.sessions).toHaveLength(1);
        expect(result.actions).toHaveLength(1);
        expect(result.humanChecks).toHaveLength(1);
        expect(result.extensions).toHaveLength(1);
        expect(JSON.stringify(result)).not.toContain(B);
    });

    it("exports every action of a history longer than one page", async () => {
        // Past a page's 512 KiB at about 1 KiB an action, and not a multiple of a read (100).
        const MANY = 1250;

        await seed(A, MANY, 1000);

        const { pages, result } = await exportOf(A);
        const timestamps = new Set(result.actions.map((action) => (action as { timestamp: number }).timestamp));

        expect(pages).toBeGreaterThan(4);
        expect(result.actions).toHaveLength(MANY);
        expect(timestamps.size).toBe(MANY);
    });
});

describe("browser export pages left by a killed export", () => {
    it("are deleted by account erasure for the user, and another user's are kept", async () => {
        // A run of each user that never reached its cleanup, and A's second run, each with stored pages.
        const keys = [
            browserExportPageKey(browserExportPrefix(A, "request-1:instance-1"), 0),
            browserExportPageKey(browserExportPrefix(A, "request-1:instance-1"), 1),
            browserExportPageKey(browserExportPrefix(A, "request-2:instance-2"), 0),
            browserExportPageKey(browserExportPrefix(B, "request-3:instance-3"), 0),
        ];
        const stored = new Set(keys);
        // A listing of two at a time, so the erasure is shown to follow a truncated listing.
        const storage = {
            delete: async (key: string) => stored.delete(key),
            list: async (prefix: string) => {
                const objects = [...stored]
                    .filter((key) => key.startsWith(prefix))
                    .map((key) => {
                        return { key };
                    });

                return { objects: objects.slice(0, 2), truncated: objects.length > 2 };
            },
        };

        await (deleteUserBrowserExportPages as unknown as { handler: (ctx: unknown, args: unknown) => Promise<unknown> }).handler({ storage }, { userId: A });

        expect([...stored]).toStrictEqual([keys[3]]);
    });
});

describe("browser export pages read back", () => {
    it("stops at the section's share of the file and says it was cut, rather than failing the export", async () => {
        const page = JSON.stringify({ actions: [{ target: "x".repeat(100) }] });
        const result = await readAllBrowserPages(async () => page, 3, 2 * page.length);

        expect(result.actions).toHaveLength(2);
        expect(result.truncated).toBe(true);
    });

    it("says the section was cut when the workflow stopped at its page limit", async () => {
        const page = JSON.stringify({ actions: [{ target: "x" }] });

        const cut = await readAllBrowserPages(async () => page, 1, Infinity, true);

        expect(cut.truncated).toBe(true);
        expect(await readAllBrowserPages(async () => page, 1, Infinity)).not.toHaveProperty("truncated");
    });
});

type StoreHandler = { handler: (ctx: unknown, args: unknown) => Promise<unknown> };

describe("browser export page stored", () => {
    it("reads a page again cautiously when its read passed the transaction's limit", async () => {
        const reads: unknown[] = [];
        const ctx = {
            runQuery: async (_reference: unknown, args: { cautious?: boolean }) => {
                // The deletion check, before and after the write.
                if (args.cautious === undefined) {
                    return false;
                }

                reads.push(args.cautious);

                if (!args.cautious) {
                    throw Object.assign(new Error("this transaction read too many bytes"), { code: "TRANSACTION_LIMIT_EXCEEDED" });
                }

                return { actions: [], extensions: [], humanChecks: [], sessions: [] };
            },
            storage: { store: async () => "key" },
        };

        await (storeBrowserExportPage as unknown as StoreHandler).handler(ctx, { key: "k", userId: A });

        expect(reads).toEqual([false, true]);
    });

    it.each([
        { begun: [true], name: "stores nothing once the account's deletion has begun", stored: [] },
        { begun: [false, true], name: "deletes its page again when the deletion began during the write", stored: [] },
        { begun: [false, false], name: "keeps its page when no deletion began", stored: ["k"] },
    ])("$name", async ({ begun, stored }) => {
        const objects = new Set<string>();
        const checks = [...begun];
        const ctx = {
            runQuery: async (_reference: unknown, args: { cautious?: boolean }) =>
                args.cautious === undefined ? checks.shift() : { actions: [], extensions: [], humanChecks: [], sessions: [] },
            storage: {
                delete: async (key: string) => objects.delete(key),
                store: async (key: string) => objects.add(key),
            },
        };
        const run = (storeBrowserExportPage as unknown as StoreHandler).handler(ctx, { key: "k", userId: A });

        await (stored.length > 0 ? expect(run).resolves.toEqual({}) : expect(run).rejects.toThrow("Account deletion is underway"));
        expect([...objects]).toEqual(stored);
    });
});

describe("browser export pages stay within the export's limits", () => {
    /** Every page, read as `storeBrowserExportPage` reads it: again cautiously when `fallBack` and the read passed a limit. */
    const pagesOf = async (userId: string, fallBack = false): Promise<{ json: string; phase?: string }[]> => {
        const pages: { json: string; phase?: string }[] = [];

        await storeAllBrowserPages(async (cursor) => {
            const read = async (cautious: boolean): Promise<any> =>
                await harness.run(async (ctx: any) => await ctx.runQuery(collectBrowserForExport, { cautious, cursor, userId }));
            const page = await read(false).catch(async (error: unknown) => {
                if (!fallBack) {
                    throw error;
                }

                return await read(true);
            });

            pages.push({ json: JSON.stringify(page), phase: cursor?.phase });

            return page;
        });

        return pages;
    };

    it("ends a page after its reads are spent, even over many sessions with no actions", async () => {
        const SESSIONS = 150;

        await harness.run(async (ctx: any) => {
            const threadId = await ctx.db.insert("threads", { status: "active", title: "T", userId: A });

            for (let index = 0; index < SESSIONS; index += 1) {
                await ctx.db.insert("browserSessions", { lastActivityAt: index, startedAt: index, status: "completed", threadId, userId: A });
            }
        });

        const pages = await pagesOf(A);
        const { result } = await exportOf(A);

        // Two reads per empty session, 100 a page.
        expect(pages.filter((page) => page.phase === "actions").length).toBeGreaterThanOrEqual(3);
        expect(result.sessions).toHaveLength(SESSIONS);
    });

    it("cuts an oversized field, says so, and keeps every page under a step's 1 MiB", async () => {
        const huge = "x".repeat(1_500_000);

        await harness.run(async (ctx: any) => {
            const threadId = await ctx.db.insert("threads", { status: "active", title: "T", userId: A });
            const sessionId = await ctx.db.insert("browserSessions", {
                currentUrl: `https://a.example.com/${huge}`,
                lastActivityAt: 1,
                startedAt: 1,
                status: "completed",
                threadId,
                userId: A,
            });

            // One batch of actions whose targets together pass 1 MiB.
            for (let index = 0; index < 60; index += 1) {
                await ctx.db.insert("browserActions", { action: "click", sessionId, success: 1, target: "t".repeat(30_000), timestamp: index });
            }

            await ctx.db.insert("browserHumanChecks", { askedAt: 1, run: "r", site: huge, threadId, userId: A });
            await ctx.db.insert("browserExtensions", {
                capabilities: Array.from({ length: 2000 }, () => "c".repeat(1000)),
                extensionId: "e",
                status: "paired",
                userId: A,
            });
        });

        const pages = await pagesOf(A);
        const { result } = await exportOf(A);

        for (const page of pages) {
            expect(new TextEncoder().encode(page.json).length).toBeLessThan(1024 * 1024);
        }

        expect(result.sessions[0]).toEqual(expect.objectContaining({ truncated: ["currentUrl"] }));
        expect((result.sessions[0] as { currentUrl: string }).currentUrl.startsWith("https://a.example.com/x")).toBe(true);
        expect(result.actions).toHaveLength(60);
        expect(result.actions[0]).toEqual(expect.objectContaining({ truncated: ["target"] }));
        expect(result.humanChecks[0]).toEqual(expect.objectContaining({ truncated: ["site"] }));
        expect((result.extensions[0] as { truncated: string[] }).truncated[0]).toMatch(CUT_CAPABILITIES);
    });

    it("keeps every capability of an oversized list, each cut to fit, and names the ones cut", async () => {
        // One capability that fits a string's cap alone, but not inside the list's brackets, among short ones.
        const capabilities = ["tabs", "c".repeat(EXPORT_FIELD_BYTES - 2), "scripting"];

        await harness.run(async (ctx: any) => {
            await ctx.db.insert("browserExtensions", { capabilities, extensionId: "e", status: "paired", userId: A });
        });

        const { result } = await exportOf(A);
        const extension = result.extensions[0] as { capabilities: string[]; truncated: string[] };

        expect(extension.capabilities).toHaveLength(3);
        expect(extension.capabilities[0]).toBe("tabs");
        expect(extension.capabilities[2]).toBe("scripting");
        expect(extension.capabilities[1]?.startsWith("ccc")).toBe(true);
        expect(new TextEncoder().encode(JSON.stringify(extension.capabilities)).length).toBeLessThanOrEqual(EXPORT_FIELD_BYTES);
        expect(extension.truncated).toEqual(["capabilities[1]"]);
    });

    it("reads small actions a full batch at a time, so a long history takes few pages", async () => {
        // At 8 rows a read (2 MB reckoned a row), 100 reads a page, this took three pages of actions.
        await seed(A, 2000);

        const pages = await pagesOf(A);

        expect(pages.filter((page) => page.phase === "actions")).toHaveLength(1);
    });

    it("reads typed actions far over the reckoned row again cautiously, never one read past the transaction's 32 MiB", async () => {
        const ACTIONS = 40;

        const sessionId = await harness.run(async (ctx: any) => {
            const threadId = await ctx.db.insert("threads", { status: "active", title: "T", userId: A });

            return await ctx.db.insert("browserSessions", { lastActivityAt: 1, startedAt: 1, status: "completed", threadId, userId: A });
        });

        // A write of its own per 10 actions: one transaction may write 32 MiB too.
        for (let from = 0; from < ACTIONS; from += 10) {
            await harness.run(async (ctx: any) => {
                for (let index = from; index < from + 10; index += 1) {
                    await ctx.db.insert("browserActions", { action: "type", sessionId, success: 1, timestamp: index, value: "v".repeat(1_000_000) });
                }
            });
        }

        const read = async (cautious: boolean): Promise<unknown> =>
            await harness.run(async (ctx: any) => await ctx.runQuery(collectBrowserForExport, { cautious, cursor: { phase: "actions" }, userId: A }));

        // 40 MB at the 64 KiB a row is reckoned: one read of all of them passes the limit.
        await expect(read(false)).rejects.toMatchObject({ code: "TRANSACTION_LIMIT_EXCEEDED" });

        const pages = await pagesOf(A, true);
        const actions = pages.flatMap((page) => (JSON.parse(page.json) as { actions: unknown[] }).actions);

        // The first page, read cautiously, holds 15 of them; the 25 left fit one read.
        expect(pages.filter((page) => page.phase === "actions").length).toBeGreaterThanOrEqual(2);
        expect(actions).toHaveLength(ACTIONS);
        expect(JSON.stringify(actions)).not.toContain("vvvv");
    });
});
