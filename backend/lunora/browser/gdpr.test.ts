/**
 * The browser tables in the data export: the user's own rows with what describes their use, never a credential or the
 * live view's bookkeeping, and every page of a history longer than one.
 */
import { lunoraTest } from "@lunora/testing";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import schema from "../schema";
import { collectAllBrowserPages } from "./export-pages";
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

const exportOf = async (userId: string): Promise<{ pages: number; result: Awaited<ReturnType<typeof collectAllBrowserPages>> }> => {
    let pages = 0;
    const result = await collectAllBrowserPages(async (cursor) => {
        pages += 1;

        return await harness.run(async (ctx: any) => await ctx.runQuery(collectBrowserForExport, { cursor, userId }));
    });

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
