/**
 * The memory download: only the caller's active rows, read a page per call up to the cap,
 * grouped and dated in the user's timezone (UTC when unset or unknown), bot memories labelled by scope.
 */
import { lunoraTest } from "@lunora/testing";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import schema from "../schema";
import type { BotLabel, ExportMemoryRow } from "./export-format";
import { formatMemoryMarkdown, MEMORY_EXPORT_MAX_ROWS, MEMORY_EXPORT_SCAN_ROWS } from "./export-format";
import { MEMORY_EXPORT_PAGE_ROWS, readExportMemories, readMemoryExportPage, resolveMemoryBotLabels } from "./markdown-export";

type Harness = ReturnType<typeof lunoraTest>;

let harness: Harness;

beforeEach(() => {
    harness = lunoraTest(schema as never);
});

afterEach(() => {
    harness.close();
});

/** 2026-03-01 23:30 UTC: already 2 March in Berlin. */
const LATE_EVENING = Date.UTC(2026, 2, 1, 23, 30);
const NOW = Date.UTC(2026, 2, 10, 12);

const row = (fields: Partial<ExportMemoryRow> & { memory: string }): ExportMemoryRow => {
    return { lastConfirmedAt: LATE_EVENING, pinned: false, type: "preference", ...fields };
};

const NO_BOTS = new Map<string, BotLabel>();

describe("formatMemoryMarkdown", () => {
    it("lists pinned first, then each type in taxonomy order, with dates, source and scope on one line", () => {
        const markdown = formatMemoryMarkdown(
            [
                row({ memory: "Likes tea" }),
                row({ memory: "Name is Ada", pinned: true, source: "manual", type: "identity" }),
                row({
                    eventStart: "2026-04-02",
                    importedFrom: "chatgpt",
                    memory: "Talk in\nLisbon",
                    source: "imported",
                    type: "context",
                    validUntil: "2026-04-03",
                }),
                row({ botId: "bot-1", memory: "Prefers short answers" }),
            ],
            { bots: new Map([["bot-1", { kind: "named", name: "Helper" }]]), now: NOW, timeZone: "Europe/Berlin", truncated: false },
        );

        expect(markdown).toBe(
            [
                "# Your memories",
                "",
                "Exported 2026-03-10. 4 memories, 1 pinned. Dates are calendar days in Europe/Berlin.",
                "",
                "## Pinned (1)",
                "",
                "- Name is Ada — identity · last confirmed 2026-03-02 · added by you · all chats",
                "",
                "## Preferences (2)",
                "",
                "- Likes tea — last confirmed 2026-03-02 · learned in chat · all chats",
                "- Prefers short answers — last confirmed 2026-03-02 · learned in chat · bot “Helper”",
                "",
                "## Context (1)",
                "",
                "- Talk in Lisbon — last confirmed 2026-03-02 · event 2026-04-02 · until 2026-04-03 · imported from ChatGPT · all chats",
                "",
            ].join("\n"),
        );
    });

    it("reads days in UTC when the timezone is unset or unknown, and marks an unpinned fact past its end", () => {
        for (const timeZone of [undefined, "Mars/Olympus"]) {
            const markdown = formatMemoryMarkdown([row({ memory: "In Lisbon", validUntil: "2026-03-05" })], {
                bots: NO_BOTS,
                now: NOW,
                timeZone,
                truncated: false,
            });

            expect(markdown).toContain("Dates are calendar days in UTC.");
            expect(markdown).toContain("- In Lisbon — last confirmed 2026-03-01 · until 2026-03-05 (ended) · learned in chat · all chats");
        }
    });

    it("tells a deleted, a shared and an unknown bot apart, and says when the file is cut", () => {
        const bots = new Map<string, BotLabel>([
            ["gone", { kind: "deleted" }],
            ["old", { kind: "unknown" }],
            ["theirs", { kind: "shared" }],
        ]);
        const markdown = formatMemoryMarkdown(
            ["gone", "theirs", "old"].map((botId) => row({ botId, memory: botId })),
            { bots, now: NOW, timeZone: "UTC", truncated: true },
        );

        expect(markdown).toContain("gone — last confirmed 2026-03-01 · learned in chat · a deleted bot");
        expect(markdown).toContain("theirs — last confirmed 2026-03-01 · learned in chat · a shared chat's bot");
        expect(markdown).toContain("old — last confirmed 2026-03-01 · learned in chat · a bot");
        expect(markdown).toContain(
            `This file is cut: it holds the pinned memories and the ${String(MEMORY_EXPORT_MAX_ROWS)} most recently saved others among your newest 5,000 memories (by when each was saved, not last confirmed).`,
        );
        expect(markdown).toContain("the account data export in Privacy settings holds up to 5,000 memories");
    });

    it("labels each source", () => {
        const sources = ["auto", undefined, "compressed", "reflection", "manual", "imported"];
        const markdown = formatMemoryMarkdown(
            sources.map((source, index) => row({ lastConfirmedAt: LATE_EVENING - index, memory: `s${String(index)}`, ...(source && { source }) })),
            { bots: NO_BOTS, now: NOW, timeZone: "UTC", truncated: false },
        );
        const labels = markdown
            .split("\n")
            .filter((line) => line.startsWith("- s"))
            .map((line) => line.split(" · ").at(-2));

        expect(labels).toStrictEqual([
            "learned in chat",
            "learned in chat",
            "summarised from earlier memories",
            "combined from earlier memories overnight",
            "added by you",
            "imported from another assistant",
        ]);
    });
});

const insert = async (count: number, fields: Record<string, unknown> = {}): Promise<void> => {
    await harness.run(async (ctx: any) => {
        for (let index = 0; index < count; index += 1) {
            await ctx.db.insert("memories", {
                lastConfirmedAt: index,
                memory: `m${String(index)}`,
                source: "auto",
                type: "context",
                userId: "user-1",
                ...fields,
            });
        }
    });
};

/** A `runQuery` over the harness that counts its calls. */
const runner = () => {
    const calls: number[] = [];

    return {
        calls,
        ctx: {
            runQuery: async (_reference: unknown, args: unknown) => {
                calls.push(1);

                return await harness.run(async (ctx: any) => await ctx.runQuery(readMemoryExportPage, args));
            },
        } as never,
    };
};

describe("readExportMemories", () => {
    it("reads only the caller's active rows", async () => {
        await insert(2);
        await insert(1, { userId: "user-2" });
        const superseded = await harness.run(async (ctx: any) => await ctx.db.insert("memories", { memory: "old", type: "context", userId: "user-1" }));

        await harness.run(async (ctx: any) => {
            const newer = await ctx.db.insert("memories", { memory: "new", type: "context", userId: "user-1" });

            await ctx.db.patch("memories", superseded, { supersededBy: newer });
        });

        const { ctx } = runner();
        const { rows, truncated } = await readExportMemories(ctx, "user-1");

        expect(rows.map((r) => r.memory).toSorted((a, b) => a.localeCompare(b))).toStrictEqual(["m0", "m1", "new"]);
        expect(truncated).toBe(false);
    });

    it("stops at the unpinned cap, a page per read", async () => {
        await insert(MEMORY_EXPORT_MAX_ROWS + 30);

        const { calls, ctx } = runner();
        const { rows, truncated } = await readExportMemories(ctx, "user-1");

        expect(rows).toHaveLength(MEMORY_EXPORT_MAX_ROWS);
        expect(truncated).toBe(true);
        expect(calls).toHaveLength(Math.ceil((MEMORY_EXPORT_MAX_ROWS + 30) / MEMORY_EXPORT_PAGE_ROWS));
    });

    it("stops at the scan with many pinned rows, and does not call exactly the scan cut", async () => {
        await insert(MEMORY_EXPORT_SCAN_ROWS, { pinned: true });

        const exact = await readExportMemories(runner().ctx, "user-1");

        expect(exact.rows).toHaveLength(MEMORY_EXPORT_SCAN_ROWS);
        expect(exact.truncated).toBe(false);

        await insert(10, { pinned: true });

        const { calls, ctx } = runner();
        const over = await readExportMemories(ctx, "user-1");

        expect(over.rows).toHaveLength(MEMORY_EXPORT_SCAN_ROWS);
        expect(over.truncated).toBe(true);
        // Five full pages and the one row past the scan: never more than the scan plus one.
        expect(calls).toHaveLength(MEMORY_EXPORT_SCAN_ROWS / MEMORY_EXPORT_PAGE_ROWS + 1);
    });

    it("keeps a pinned row and the newest rows past the cap, and leaves out the oldest unpinned ones", async () => {
        // Each row its own creation time, so "newest" has one answer.
        vi.useFakeTimers({ now: NOW, toFake: ["Date"] });

        try {
            await harness.run(async (ctx: any) => {
                for (let index = 0; index < MEMORY_EXPORT_MAX_ROWS + 30; index += 1) {
                    vi.setSystemTime(NOW + index);
                    await ctx.db.insert("memories", {
                        lastConfirmedAt: index,
                        memory: `m${String(index)}`,
                        pinned: index === 0,
                        type: "context",
                        userId: "user-1",
                    });
                }
            });
        } finally {
            vi.useRealTimers();
        }

        const { ctx } = runner();
        const { rows, truncated } = await readExportMemories(ctx, "user-1");
        const texts = new Set(rows.map((r) => r.memory));

        expect(rows).toHaveLength(MEMORY_EXPORT_MAX_ROWS + 1);
        expect(truncated).toBe(true);
        expect(rows[0]).toMatchObject({ memory: "m0", pinned: true });
        expect(texts.has(`m${String(MEMORY_EXPORT_MAX_ROWS + 29)}`)).toBe(true);
        expect(texts.has("m1")).toBe(false);
    });

    it("does not call exactly the cap cut", async () => {
        await insert(MEMORY_EXPORT_MAX_ROWS);

        const { ctx } = runner();
        const { rows, truncated } = await readExportMemories(ctx, "user-1");

        expect(rows).toHaveLength(MEMORY_EXPORT_MAX_ROWS);
        expect(truncated).toBe(false);
    });
});

describe("resolveMemoryBotLabels", () => {
    it("names only the caller's own bot, and tells a shared, a deleted and an unknown one apart", async () => {
        const labels = await harness.run(async (ctx: any) => {
            const own = await ctx.db.insert("bots", {
                computerEnabled: false,
                createdAt: 1,
                instructions: "",
                model: "m",
                name: "Helper",
                updatedAt: 1,
                userId: "user-1",
            });
            const theirs = await ctx.db.insert("bots", {
                computerEnabled: false,
                createdAt: 1,
                instructions: "",
                model: "m",
                name: "Private",
                updatedAt: 1,
                userId: "user-2",
            });

            await ctx.db.insert("botOwners", { botId: theirs, createdAt: 1, ownerId: "user-2" });
            await ctx.db.insert("botOwners", { botId: "gone-bot", createdAt: 1, deletedAt: 5, ownerId: "user-1" });

            return await ctx.runQuery(resolveMemoryBotLabels, { botIds: [own, theirs, "gone-bot", "old-bot"], userId: "user-1" });
        });

        expect(labels.map(({ kind, name }: { kind: string; name?: string }) => [kind, name])).toStrictEqual([
            ["named", "Helper"],
            ["shared", undefined],
            ["deleted", undefined],
            ["unknown", undefined],
        ]);
    });
});
