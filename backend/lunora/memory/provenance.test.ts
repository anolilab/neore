/**
 * Where a memory came from: extraction keeps the user's own words and the
 * message, the list says who learned it, the link respects thread access, and
 * the export carries it.
 */
import { lunoraTest } from "@lunora/testing";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { registeredApi, registerModule } from "../../test/registered-api";
import { internal } from "../_generated/internal";
import schema from "../schema";
import { compressThreadMemories } from "./compress";
import { extractMemories } from "./extract";
import { deleteMemory, getMemorySource, listUserMemories, saveMemoryBatch, updateMemory } from "./functions";
import { collectMemoriesForExport } from "./gdpr";
import { applyReflectionOps } from "./reflection";

const { embedMany, generateText, registry } = vi.hoisted(() => {
    return { embedMany: vi.fn(), generateText: vi.fn(), registry: new Map<string, unknown>() };
});

vi.mock("../_generated/api", async (importOriginal) => registeredApi(await importOriginal(), registry));
vi.mock("../_generated/internal", async (importOriginal) => registeredApi(await importOriginal(), registry));
vi.mock("ai", async (importOriginal) => {
    return { ...(await importOriginal<typeof import("ai")>()), generateText };
});
vi.mock("../chat/lib/model-filter-rules", () => {
    return {
        loadModelFilterRules: async () => {
            return {};
        },
    };
});
vi.mock("../lib/utility-model", () => {
    return {
        getUtilityModel: async () => {
            return {};
        },
        NoAllowedUtilityModelError: class extends Error {},
    };
});
vi.mock("../lib/services", () => {
    return { gatewayFetch: () => async () => new Response("{}") };
});
vi.mock("../agent/client/search", () => {
    return { embedMany };
});

let USER: string;
let STRANGER: string;
const MESSAGE = "My name is Dana and I work as a nurse in Hamburg, please remember that";

let harness: ReturnType<typeof lunoraTest>;
let threadId: string;

const as = (userId: string) => harness.withIdentity({ userId } as never);

const insertMemory = async (fields: Record<string, unknown>): Promise<string> =>
    await harness.run(
        async (ctx: any) =>
            await ctx.db.insert("memories", {
                lastConfirmedAt: Date.now(),
                memory: "The user is a nurse",
                source: "auto",
                type: "identity",
                updatedAt: Date.now(),
                userId: USER,
                ...fields,
            }),
    );

beforeAll(async () => {
    registerModule(registry, "memory_functions", await import("./functions"));
    registerModule(registry, "memory_compress", await import("./compress"));
    registerModule(registry, "lib_action_cache", await import("../lib/action-cache"));
});

beforeEach(async () => {
    harness = lunoraTest(schema as never);
    embedMany.mockRejectedValue(new Error("no embeddings in this test"));

    const seedUser = async (name: string): Promise<string> =>
        await harness.run(
            async (ctx: any) => await ctx.db.insert("user", { createdAt: 0, email: `${name}@example.com`, emailVerified: true, name, updatedAt: 0 }),
        );

    USER = await seedUser("owner");
    STRANGER = await seedUser("stranger");
    threadId = await harness.run(async (ctx: any) => {
        await ctx.db.insert("userSettings", { memoryEnabled: true, timezone: "UTC", userId: USER });

        return await ctx.db.insert("threads", { status: "regular", title: "Intro", updatedAt: Date.now(), userId: USER });
    });
});

afterEach(() => {
    harness.close();
    embedMany.mockReset();
    generateText.mockReset();
});

describe("extraction evidence", () => {
    it("stores the user's quote with the prompt message, and no quote the user did not write", async () => {
        expect.assertions(3);

        generateText.mockResolvedValue({
            output: {
                facts: [
                    { confidence: 90, importance: 80, memory: "The user is a nurse in Hamburg", quote: "I work as a nurse in Hamburg", type: "identity" },
                    {
                        confidence: 90,
                        importance: 80,
                        memory: "The user likes Hamburg's harbour a lot",
                        quote: "Hamburg has a lovely harbour",
                        type: "preference",
                    },
                ],
            },
        });

        await harness.action(
            async (ctx: any) =>
                await ctx.runAction(extractMemories, {
                    assistantResponse: "Nice to meet you, Dana. Hamburg has a lovely harbour.",
                    promptMessageId: "message-1",
                    quotablePrompt: MESSAGE,
                    threadId,
                    userId: USER,
                    userMessage: MESSAGE,
                }),
        );

        const rows = await harness.run(async (ctx: any) => await ctx.db.query("memories").collect());
        const byText = new Map<string, { evidence?: unknown }>(rows.map((row: any) => [row.memory, row]));

        expect(byText.get("The user is a nurse in Hamburg")?.evidence).toStrictEqual({
            at: expect.any(Number),
            messageId: "message-1",
            quote: "I work as a nurse in Hamburg",
            threadId,
        });
        // Saved, without the assistant's words as its quote.
        expect(byText.has("The user likes Hamburg's harbour a lot")).toBe(true);
        expect(byText.get("The user likes Hamburg's harbour a lot")?.evidence).toBeUndefined();
    });
});

describe("belief revision", () => {
    /** `meanwhile` runs while the model words the merge. */
    const revise = async (userMessage: string, quote: string | undefined, meanwhile?: () => Promise<void>) => {
        // The new fact is close to the stored one (Jaccard), and the revision merges them.
        generateText
            .mockResolvedValueOnce({
                output: {
                    facts: [{ confidence: 90, importance: 80, memory: "The user works as a nurse in Hamburg city", ...(quote && { quote }), type: "identity" }],
                },
            })
            .mockImplementationOnce(async () => {
                await meanwhile?.();

                return { output: { action: "UPDATE", mergedMemory: "The user works as a nurse in Hamburg city centre" } };
            });

        await harness.action(
            async (ctx: any) =>
                await ctx.runAction(extractMemories, {
                    assistantResponse: "Noted.",
                    promptMessageId: "message-2",
                    quotablePrompt: userMessage,
                    threadId,
                    userId: USER,
                    userMessage,
                }),
        );

        return await harness.run(async (ctx: any) => await ctx.db.query("memories").collect());
    };

    it("replaces the evidence whole with the newer quote on a merge, and keeps the old one when the new fact has none", async () => {
        expect.assertions(3);

        await insertMemory({ evidence: { at: 1, messageId: "message-1", quote: "old words", threadId }, memory: "The user works as a nurse in Hamburg" });

        const kept = await revise(MESSAGE, undefined);

        // Merged, with the old words still behind it.
        expect(kept[0]).toMatchObject({
            evidence: { at: 1, messageId: "message-1", quote: "old words", threadId },
            memory: "The user works as a nurse in Hamburg city centre",
        });

        // A different statement: the gate skips one already processed today.
        const replaced = await revise("To be precise, I work as a nurse in Hamburg, near the centre", "I work as a nurse in Hamburg");

        expect(replaced).toHaveLength(1);
        expect(replaced[0].evidence).toMatchObject({ messageId: "message-2", quote: "I work as a nurse in Hamburg", threadId });
    });

    it("quotes the words a slow revision's wording came from, even when the row's quote was said later", async () => {
        expect.assertions(1);

        const newer = { at: Date.now() + 60_000, messageId: "message-9", quote: "newer words", threadId };

        await insertMemory({ evidence: newer, memory: "The user works as a nurse in Hamburg" });

        const rows = await revise(MESSAGE, "I work as a nurse in Hamburg");

        expect(rows[0]).toMatchObject({
            evidence: { quote: "I work as a nurse in Hamburg", threadId },
            memory: "The user works as a nurse in Hamburg city centre",
        });
    });

    it("writes no merge into a memory the user rewrote while the model worded it", async () => {
        expect.assertions(2);

        const memoryId = await insertMemory({ memory: "The user works as a nurse in Hamburg" });

        // The rewrite lands between the revision's read of the row and its write.
        const rows = await revise(MESSAGE, "I work as a nurse in Hamburg", async () => {
            await as(USER).mutation(updateMemory, { memory: "The user is a surgeon in Hamburg", memoryId });
        });

        expect(rows[0].memory).toBe("The user is a surgeon in Hamburg");
        expect(rows[0].evidence).toBeUndefined();
    });
});

describe("memory list provenance", () => {
    it("names the bot that learned a memory, and drops the evidence of one the user rewrote", async () => {
        expect.assertions(5);

        const botId = await harness.run(
            async (ctx: any) =>
                await ctx.db.insert("bots", { computerEnabled: false, createdAt: 1, instructions: "", model: "m", name: "Chef", updatedAt: 1, userId: USER }),
        );

        await insertMemory({ botId, evidence: { quote: "I cook every day" }, memory: "The user cooks daily" });
        const rewritten = await insertMemory({ evidence: { messageId: "m1", quote: "old words", threadId }, memory: "Learned from chat" });

        await as(USER).mutation(updateMemory, { memory: "Rewritten by the user", memoryId: rewritten });

        const rows = await as(USER).query(listUserMemories, {});
        const bot = rows.find((row: any) => row.memory === "The user cooks daily");
        const manual = rows.find((row: any) => row.memory === "Rewritten by the user");

        expect(bot).toMatchObject({ botName: "Chef", fromBot: true, hasEvidence: true });
        expect(manual?.fromBot).toBe(false);
        expect(manual?.source).toBe("manual");
        expect(manual?.hasEvidence).toBe(false);

        const stored = await harness.run(async (ctx: any) => await ctx.db.get("memories", rewritten));

        expect(stored?.evidence).toBeUndefined();
    });
});

describe("getMemorySource", () => {
    const insertMessage = async (): Promise<string> =>
        await harness.run(
            async (ctx: any) => await ctx.db.insert("messages", { order: 0, status: "success", stepOrder: 0, threadId, tool: false, userId: USER }),
        );

    it("gives the owner the quote and a link to the message it was learned in", async () => {
        expect.assertions(1);

        const messageId = await insertMessage();
        const memoryId = await insertMemory({ evidence: { messageId, quote: "I am a nurse", threadId }, threadId });

        await expect(as(USER).query(getMemorySource, { memoryId })).resolves.toStrictEqual({
            messageId,
            messageOrder: expect.any(Number),
            messageStepOrder: expect.any(Number),
            quote: "I am a nurse",
            threadId,
        });
    });

    it("links only the chat once the message is gone", async () => {
        expect.assertions(1);

        const messageId = await insertMessage();
        const memoryId = await insertMemory({ evidence: { messageId, quote: "I am a nurse", threadId }, threadId });

        await harness.run(async (ctx: any) => await ctx.db.delete("messages", messageId));

        await expect(as(USER).query(getMemorySource, { memoryId })).resolves.toStrictEqual({ quote: "I am a nurse", threadId });
    });

    it("hides the quote and the link of a chat locked after the memory was learned, and says the quote is hidden", async () => {
        expect.assertions(2);

        const memoryId = await insertMemory({ evidence: { quote: "I am a nurse", threadId }, threadId });
        const unquoted = await insertMemory({ threadId });

        await harness.run(async (ctx: any) => await ctx.db.patch("threads", threadId, { lockedAt: 1 }));

        await expect(as(USER).query(getMemorySource, { memoryId })).resolves.toStrictEqual({ quoteHidden: true });
        // Nothing to hide: no quote was kept.
        await expect(as(USER).query(getMemorySource, { memoryId: unquoted })).resolves.toStrictEqual({});
    });

    it("keeps the quote of the user's own chat in the trash, without a link, and hides it once the chat is purged", async () => {
        expect.assertions(2);

        const memoryId = await insertMemory({ evidence: { quote: "I am a nurse", threadId }, threadId });

        await harness.run(async (ctx: any) => await ctx.db.patch("threads", threadId, { deleted: true }));

        await expect(as(USER).query(getMemorySource, { memoryId })).resolves.toStrictEqual({ quote: "I am a nurse" });

        await harness.run(async (ctx: any) => await ctx.db.delete("threads", threadId));

        await expect(as(USER).query(getMemorySource, { memoryId })).resolves.toStrictEqual({ quoteHidden: true });
    });

    it("shows a collaborator the quote while their grant lasts, and hides it once the owner takes it away", async () => {
        expect.assertions(2);

        // The shared chat lives on its owner's shard: here only the global grant is seen.
        const sharedThread = "thread-on-the-owners-shard";
        const memoryId = await insertMemory({ evidence: { quote: "I am a nurse", threadId: sharedThread } });
        const grantId = await harness.run(
            async (ctx: any) =>
                await ctx.db.insert("threadAccess", {
                    grantedAt: 1,
                    grantedBy: "owner",
                    ownerId: "owner",
                    permission: "read",
                    threadId: sharedThread,
                    userId: USER,
                }),
        );

        await expect(as(USER).query(getMemorySource, { memoryId })).resolves.toStrictEqual({ quote: "I am a nurse" });

        await harness.run(async (ctx: any) => await ctx.db.delete("threadAccess", grantId));

        await expect(as(USER).query(getMemorySource, { memoryId })).resolves.toStrictEqual({ quoteHidden: true });
    });

    it("gives nothing for another user's memory", async () => {
        expect.assertions(1);

        const memoryId = await insertMemory({ evidence: { quote: "I am a nurse", threadId }, threadId });

        await expect(as(STRANGER).query(getMemorySource, { memoryId })).resolves.toBeNull();
    });
});

describe("evidence through reflection and export", () => {
    it("takes a compressed fact's quote only from the sources that still read the text it was made from", async () => {
        expect.assertions(1);

        const kept = await insertMemory({ evidence: { at: 1, quote: "older words" }, memory: "The user likes tea" });
        const revised = await insertMemory({ evidence: { at: 2, quote: "newer words" }, memory: "The user likes coffee now" });

        const [savedId] = await harness.run(
            async (ctx: any) =>
                await ctx.runMutation(saveMemoryBatch, {
                    memories: [
                        {
                            evidenceFrom: [
                                { id: kept, memory: "The user likes tea" },
                                // Synthesis read this row as "The user likes tea"; it was revised since.
                                { id: revised, memory: "The user likes tea" },
                            ],
                            memory: "The user likes tea and coffee",
                            source: "compressed",
                            type: "preference",
                            userId: USER,
                        },
                    ],
                }),
        );

        const saved = await harness.run(async (ctx: any) => await ctx.db.get("memories", savedId));

        expect(saved.evidence).toStrictEqual({ at: 1, quote: "older words" });
    });

    it("makes no promotion when a source was revised after the synthesis, and keeps every source", async () => {
        expect.assertions(3);

        const unchanged = await insertMemory({ evidence: { at: 1, quote: "older words" }, memory: "The user likes tea" });
        const revised = await insertMemory({ evidence: { at: 2, quote: "newer words" }, memory: "The user likes coffee now" });

        const { promotedIds } = await harness.run(
            async (ctx: any) =>
                await ctx.runMutation(applyReflectionOps, {
                    ops: [
                        {
                            confidence: 90,
                            importance: 80,
                            kind: "promote",
                            memory: "The user likes tea and coffee",
                            // The synthesis read `revised` as "The user likes tea" (before it was revised).
                            sourceIds: [unchanged, revised],
                            sourceTexts: [
                                { id: unchanged, memory: "The user likes tea" },
                                { id: revised, memory: "The user likes tea" },
                            ],
                            type: "preference",
                        },
                    ],
                    userId: USER,
                }),
        );

        const [kept, stillActive] = await harness.run(
            async (ctx: any) => await Promise.all([ctx.db.get("memories", unchanged), ctx.db.get("memories", revised)]),
        );

        expect(promotedIds).toEqual([null]);
        expect(kept.supersededBy).toBeUndefined();
        expect(stillActive.supersededBy).toBeUndefined();
    });

    it("gives a promoted memory the newest evidence of the rows it merges", async () => {
        expect.assertions(1);

        const older = await insertMemory({ evidence: { at: 1, quote: "older words" } });
        const newer = await insertMemory({ evidence: { at: 2, quote: "newer words" } });

        const { promotedIds } = await harness.run(
            async (ctx: any) =>
                await ctx.runMutation(applyReflectionOps, {
                    ops: [{ confidence: 90, importance: 80, kind: "promote", memory: "Merged", sourceIds: [older, newer], type: "identity" }],
                    userId: USER,
                }),
        );

        const promoted = await harness.run(async (ctx: any) => await ctx.db.get("memories", promotedIds[0]));

        expect(promoted.evidence).toStrictEqual({ at: 2, quote: "newer words" });
    });

    it("gives a merge survivor the absorbed row's words when they were said later", async () => {
        expect.assertions(1);

        const survivor = await insertMemory({ evidence: { at: 1, quote: "older words" } });
        const absorbed = await insertMemory({ evidence: { at: 2, quote: "newer words" } });

        await harness.run(
            async (ctx: any) =>
                await ctx.runMutation(applyReflectionOps, {
                    ops: [
                        { kind: "patch", memory: "Merged", memoryId: survivor },
                        { byMemoryId: survivor, kind: "supersede", memoryId: absorbed, merge: true },
                    ],
                    userId: USER,
                }),
        );

        const merged = await harness.run(async (ctx: any) => await ctx.db.get("memories", survivor));

        expect(merged.evidence).toStrictEqual({ at: 2, quote: "newer words" });
    });

    it("gives a merge survivor without a quote of its own the absorbed row's words", async () => {
        expect.assertions(1);

        const survivor = await insertMemory({ memory: "The user prefers tabs." });
        const absorbed = await insertMemory({ evidence: { at: 2, quote: "I use tabs" }, memory: "The user prefers tabs" });

        await harness.run(
            async (ctx: any) =>
                await ctx.runMutation(applyReflectionOps, {
                    ops: [
                        { kind: "patch", memory: "The user prefers tabs", memoryId: survivor },
                        { byMemoryId: survivor, kind: "supersede", memoryId: absorbed, merge: true },
                    ],
                    userId: USER,
                }),
        );

        const merged = await harness.run(async (ctx: any) => await ctx.db.get("memories", survivor));

        expect(merged.evidence).toStrictEqual({ at: 2, quote: "I use tabs" });
    });

    it("skips the whole merge, survivor wording included, when an absorbed row was revised after the plan", async () => {
        expect.assertions(3);

        const survivor = await insertMemory({ evidence: { at: 1, quote: "I drink tea" }, memory: "The user drinks tea" });
        // The plan read `absorbed` as "The user drinks tea."; extraction has since revised it to a contradicting fact.
        const absorbed = await insertMemory({ evidence: { at: 2, quote: "I stopped drinking tea" }, memory: "The user no longer drinks tea" });

        await harness.run(
            async (ctx: any) =>
                await ctx.runMutation(applyReflectionOps, {
                    ops: [
                        { kind: "patch", memory: "The user drinks tea every morning", memoryId: survivor },
                        { absorbedText: "The user drinks tea.", byMemoryId: survivor, kind: "supersede", memoryId: absorbed, merge: true },
                    ],
                    userId: USER,
                }),
        );

        const merged = await harness.run(async (ctx: any) => await ctx.db.get("memories", survivor));
        const stillActive = await harness.run(async (ctx: any) => await ctx.db.get("memories", absorbed));

        expect(merged.memory).toBe("The user drinks tea");
        expect(merged.evidence).toStrictEqual({ at: 1, quote: "I drink tea" });
        expect(stillActive.supersededBy).toBeUndefined();
    });

    it("skips the whole merge when the user edited the survivor after the plan", async () => {
        expect.assertions(2);

        const survivor = await insertMemory({ evidence: { at: 1, quote: "I drink tea" }, memory: "The user drinks green tea" });
        const absorbed = await insertMemory({ evidence: { at: 2, quote: "I drink it every morning" }, memory: "The user drinks tea every morning" });

        await harness.run(
            async (ctx: any) =>
                await ctx.runMutation(applyReflectionOps, {
                    ops: [
                        { kind: "patch", memory: "The user drinks tea every morning", memoryId: survivor, readText: "The user drinks tea" },
                        { absorbedText: "The user drinks tea every morning", byMemoryId: survivor, kind: "supersede", memoryId: absorbed, merge: true },
                    ],
                    userId: USER,
                }),
        );

        const [kept, stillActive] = await harness.run(
            async (ctx: any) => await Promise.all([ctx.db.get("memories", survivor), ctx.db.get("memories", absorbed)]),
        );

        expect(kept.memory).toBe("The user drinks green tea");
        expect(stillActive.supersededBy).toBeUndefined();
    });

    it.each(["deleted", "pinned"] as const)("skips the whole merge when an absorbed row was %s after the plan", async (change) => {
        expect.assertions(2);

        const survivor = await insertMemory({ evidence: { at: 1, quote: "I drink tea" }, memory: "The user drinks tea" });
        const absorbed = await insertMemory({ evidence: { at: 2, quote: "I drink it every morning" }, memory: "The user drinks tea every morning" });
        const patch = change === "pinned" ? { pinned: true } : { supersededBy: await insertMemory({ memory: "The user drinks coffee" }) };

        await harness.run(async (ctx: any) => await ctx.db.patch("memories", absorbed, patch));
        await harness.run(
            async (ctx: any) =>
                await ctx.runMutation(applyReflectionOps, {
                    ops: [
                        { kind: "patch", memory: "The user drinks tea every morning", memoryId: survivor },
                        { absorbedText: "The user drinks tea every morning", byMemoryId: survivor, kind: "supersede", memoryId: absorbed, merge: true },
                    ],
                    userId: USER,
                }),
        );

        const kept = await harness.run(async (ctx: any) => await ctx.db.get("memories", survivor));

        expect(kept.memory).toBe("The user drinks tea");
        expect(kept.evidence).toStrictEqual({ at: 1, quote: "I drink tea" });
    });

    it("gives a survivor the user wrote none of the absorbed row's words", async () => {
        expect.assertions(1);

        const survivor = await insertMemory({ memory: "The user drinks tea", source: "manual" });
        const absorbed = await insertMemory({ evidence: { at: 2, quote: "I drink tea every day" }, memory: "The user drinks tea daily" });

        await harness.run(
            async (ctx: any) =>
                await ctx.runMutation(applyReflectionOps, {
                    ops: [{ absorbedText: "The user drinks tea daily", byMemoryId: survivor, kind: "supersede", memoryId: absorbed, merge: true }],
                    userId: USER,
                }),
        );

        const kept = await harness.run(async (ctx: any) => await ctx.db.get("memories", survivor));

        expect(kept.evidence).toBeUndefined();
    });

    it("gives a superseding row without a quote none of the replaced belief's words", async () => {
        expect.assertions(1);

        const replaced = await insertMemory({ evidence: { at: 1, quote: "I live in Paris" }, memory: "The user lives in Paris" });
        const survivor = await insertMemory({ memory: "The user lives in Berlin" });

        await harness.run(
            async (ctx: any) =>
                await ctx.runMutation(applyReflectionOps, { ops: [{ byMemoryId: survivor, kind: "supersede", memoryId: replaced }], userId: USER }),
        );

        const kept = await harness.run(async (ctx: any) => await ctx.db.get("memories", survivor));

        expect(kept.evidence).toBeUndefined();
    });

    it("includes the evidence in the user's export", async () => {
        expect.assertions(1);

        await insertMemory({ evidence: { messageId: "message-1", quote: "I am a nurse", threadId } });

        const { memories } = await harness.run(async (ctx: any) => await ctx.runQuery(collectMemoriesForExport, { userId: USER }));

        expect(memories[0].evidence).toStrictEqual({ messageId: "message-1", quote: "I am a nurse", threadId });
    });
});

describe("unchanged edits", () => {
    it("keeps the source and the quote of a memory saved with the text it already has", async () => {
        expect.assertions(1);

        const memoryId = await insertMemory({ evidence: { at: 1, quote: "I am a nurse" }, memory: "The user is a nurse", threadId });

        await as(USER).mutation(updateMemory, { memory: "The user is a nurse", memoryId });

        const row = await harness.run(async (ctx: any) => await ctx.db.get("memories", memoryId));

        expect(row).toMatchObject({ evidence: { quote: "I am a nurse" }, source: "auto" });
    });

    it("keeps the source of a legacy row holding a secret when it is saved unchanged", async () => {
        expect.assertions(1);

        // Saved before redaction existed: a save of its own text would redact it, which is no rewrite by the user.
        const legacy = "The user is a nurse, token sk-abcdefghijklmnop123456";
        const memoryId = await insertMemory({ evidence: { at: 1, quote: "I am a nurse" }, memory: legacy, threadId });

        await as(USER).mutation(updateMemory, { memory: legacy, memoryId });

        const row = await harness.run(async (ctx: any) => await ctx.db.get("memories", memoryId));

        expect(row).toMatchObject({ evidence: { quote: "I am a nurse" }, source: "auto" });
    });
});

describe("compression evidence", () => {
    it("does not hand the compression job the quotes it never reads", async () => {
        expect.assertions(2);

        await insertMemory({ evidence: { at: 1, quote: "quoted words" }, memory: "The user is a nurse", threadId });

        const rows = await harness.action(
            async (ctx: any) => await ctx.runQuery(internal.memory.compress.getThreadMemoriesForCompression, { botId: undefined, threadId, userId: USER }),
        );

        expect(rows).toHaveLength(1);
        expect(rows[0]).not.toHaveProperty("evidence");
    });

    it("gives a compressed memory no quote its source lost while the facts were synthesized", async () => {
        expect.assertions(2);

        const cleared = await insertMemory({ evidence: { at: 1, quote: "cleared words" }, memory: "The user is a nurse", threadId });

        await insertMemory({ evidence: { at: 3, quote: "kept words" }, memory: "The user likes tea", threadId });

        // Enough rows that compression runs (`COMPRESSION_THRESHOLD`).
        for (let index = 0; index < 13; index += 1) {
            await insertMemory({ memory: `Filler fact ${index}`, threadId });
        }

        // The user rewrites one source (which drops its quote) after compression read it.
        generateText.mockImplementation(async ({ prompt }: { prompt: string }) => {
            await as(USER).mutation(updateMemory, { memory: "The user is a surgeon", memoryId: cleared });

            // Line 0 is the header, so a line's index is the 1-based number the prompt gives that memory.
            const lines = prompt.split("\n");
            const fact = (memory: string, source: string) => {
                return { confidence: 90, importance: 80, memory, sources: [lines.findIndex((line) => line.endsWith(source))], type: "identity" };
            };

            return { output: { facts: [fact("Nurse", "a nurse"), fact("Tea", "likes tea")] }, usage: {} };
        });

        await harness.action(async (ctx: any) => await ctx.runAction(compressThreadMemories, { threadId, userId: USER }));

        const rows = await harness.run(async (ctx: any) => await ctx.db.query("memories").collect());
        const evidenceOf = (memory: string) => rows.find((row: any) => row.source === "compressed" && row.memory === memory)?.evidence;

        expect(evidenceOf("Nurse")).toBeUndefined();
        expect(evidenceOf("Tea")).toMatchObject({ quote: "kept words" });
    });

    it("saves no compressed memory, and so no quote, once a source is deleted while the facts were synthesized", async () => {
        expect.assertions(3);

        const deleted = await insertMemory({ evidence: { at: 2, quote: "deleted words" }, memory: "The user lives in Hamburg", threadId });

        await insertMemory({ evidence: { at: 3, quote: "kept words" }, memory: "The user likes tea", threadId });

        // Enough rows that compression runs (`COMPRESSION_THRESHOLD`).
        for (let index = 0; index < 13; index += 1) {
            await insertMemory({ memory: `Filler fact ${index}`, threadId });
        }

        generateText.mockImplementation(async ({ prompt }: { prompt: string }) => {
            await as(USER).mutation(deleteMemory, { memoryId: deleted });

            const lines = prompt.split("\n");
            const fact = (memory: string, source: string) => {
                return { confidence: 90, importance: 80, memory, sources: [lines.findIndex((line) => line.endsWith(source))], type: "identity" };
            };

            return { output: { facts: [fact("Hamburg", "in Hamburg"), fact("Tea", "likes tea")] }, usage: {} };
        });

        await harness.action(async (ctx: any) => await ctx.runAction(compressThreadMemories, { threadId, userId: USER }));

        const rows = await harness.run(async (ctx: any) => await ctx.db.query("memories").collect());

        // The save checks its sources in the same write (`compressedFrom`): one gone stops it whole, so the deleted
        // row's fact and quote are never brought back, and every other source stays active.
        expect(rows.some((row: any) => row._id === deleted)).toBe(false);
        expect(rows.filter((row: any) => row.source === "compressed")).toHaveLength(0);
        expect(rows.filter((row: any) => row.supersededBy !== undefined && row.supersededBy !== null)).toHaveLength(0);
    });
});
