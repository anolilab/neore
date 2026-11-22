/**
 * The browser tables in the data export: the user's own rows with what describes their use, never a credential or the
 * live view's bookkeeping, and every page of a history longer than one.
 */
import { lunoraTest } from "@lunora/testing";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import schema from "../schema";
import { type BrowserExport, readAllBrowserPages, storeAllBrowserPages } from "./export-pages";
import { collectBrowserForExport } from "./gdpr";

const A = "user-a";
const B = "user-b";

let harness: ReturnType<typeof lunoraTest>;

const seed = async (userId: string, actions: number): Promise<void> => {
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
                target: `#field-${userId}`,
                timestamp: 100 + index,
                value: `typed-secret-${userId}`,
            });
        }

        await ctx.db.insert("browserHumanChecks", { askedAt: 30, run: "run-1", site: `${userId}.example.com`, threadId, userId });
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
    const result = await readAllBrowserPages(async (page) => stored[page] as string, pages, Infinity);

    return { pages, result };
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
        expect(result.humanChecks).toEqual([expect.objectContaining({ askedAt: 30, site: "user-a.example.com" })]);
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
        // Past the page's scan budget (1000 rows), and not a multiple of an action page (100).
        const MANY = 1250;

        await seed(A, MANY);

        const { pages, result } = await exportOf(A);
        const timestamps = new Set(result.actions.map((action) => (action as { timestamp: number }).timestamp));

        expect(pages).toBeGreaterThan(4);
        expect(result.actions).toHaveLength(MANY);
        expect(timestamps.size).toBe(MANY);
    });
});

describe("browser export pages read back", () => {
    it("fails with PAYLOAD_TOO_LARGE once the stored pages pass the export's limit", async () => {
        const page = JSON.stringify({ actions: [{ target: "x".repeat(100) }] });

        await expect(readAllBrowserPages(async () => page, 3, 2 * page.length)).rejects.toMatchObject({ code: "PAYLOAD_TOO_LARGE" });
    });
});

describe("browser export pages stay within the export's limits", () => {
    const pagesOf = async (userId: string): Promise<{ json: string; phase?: string }[]> => {
        const pages: { json: string; phase?: string }[] = [];

        await storeAllBrowserPages(async (cursor) => {
            const page = await harness.run(async (ctx: any) => await ctx.runQuery(collectBrowserForExport, { cursor, userId }));

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
        expect(result.extensions[0]).toEqual(expect.objectContaining({ truncated: ["capabilities"] }));
    });

    it("reads long typed actions over several pages, never one read past the transaction's 32 MiB", async () => {
        const ACTIONS = 200;

        const sessionId = await harness.run(async (ctx: any) => {
            const threadId = await ctx.db.insert("threads", { status: "active", title: "T", userId: A });

            return await ctx.db.insert("browserSessions", { lastActivityAt: 1, startedAt: 1, status: "completed", threadId, userId: A });
        });

        // A write of its own per 20 actions: one transaction may write 32 MiB too.
        for (let from = 0; from < ACTIONS; from += 20) {
            await harness.run(async (ctx: any) => {
                for (let index = from; index < from + 20; index += 1) {
                    await ctx.db.insert("browserActions", { action: "type", sessionId, success: 1, timestamp: index, value: "v".repeat(200_000) });
                }
            });
        }

        const pages = await pagesOf(A);
        const { result } = await exportOf(A);

        // 40 MB of typed text: two pages at least, at 16 MiB of reads each.
        expect(pages.filter((page) => page.phase === "actions").length).toBeGreaterThanOrEqual(3);
        expect(result.actions).toHaveLength(ACTIONS);
        expect(JSON.stringify(result)).not.toContain("vvvv");
    });
});
