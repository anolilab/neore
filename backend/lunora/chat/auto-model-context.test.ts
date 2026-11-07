import { estimateTokensFromCharacters } from "@neore/ai/models";
import { lunoraTest } from "@lunora/testing";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import schema from "../schema";
import { autoRouteContextOf } from "./auto-model-context";

type Harness = ReturnType<typeof lunoraTest>;

const OWNER = "owner-user";

let harness: Harness;
let threadId: string;

const message = async (order: number, role: "assistant" | "tool" | "user", content: unknown, extra: Record<string, unknown> = {}): Promise<string> =>
    await harness.run(
        async (ctx: any) =>
            await ctx.db.insert("messages", {
                message: { content, role },
                order,
                status: "success",
                stepOrder: 0,
                text: typeof content === "string" ? content : undefined,
                threadId,
                tool: false,
                userId: OWNER,
                ...extra,
            }),
    );

const chatFile = async (name: string, mediaType: string): Promise<string> =>
    await harness.run(
        async (ctx: any) =>
            await ctx.db.insert("chatFiles", { filename: name, hash: name, lastTouchedAt: 0, mediaType, refcount: 1, storageId: `agent-files/${name}` }),
    );

const contextFor = async (promptMessageId: string) =>
    await harness.run(async (ctx: any) => await autoRouteContextOf(ctx, { promptMessageId, threadId: threadId as never }));

const imagePart = { image: "https://example.test/a.png", type: "image" };

beforeEach(async () => {
    harness = lunoraTest(schema as never);
    threadId = await harness.run(async (ctx: any) => await ctx.db.insert("threads", { status: "active", title: "Chat", userId: OWNER }));
});

afterEach(() => {
    harness.close();
});

describe("autoRouteContextOf", () => {
    it("reads the attachments of the history that ends at the prompt", async () => {
        await message(0, "user", [imagePart]);
        const prompt = await message(1, "user", "describe it");

        await expect(contextFor(prompt)).resolves.toMatchObject({ files: false, images: true });
    });

    it("leaves out a tool result whose call is not in the window, and its file", async () => {
        const image = await chatFile("orphan", "image/png");

        await message(0, "tool", [{ output: { type: "text", value: "ok" }, toolCallId: "call-gone", toolName: "lookup", type: "tool-result" }], {
            fileIds: [image],
        });
        const prompt = await message(1, "user", "continue");

        await expect(contextFor(prompt)).resolves.toMatchObject({ files: false, images: false });
    });

    it("counts a tool result's output toward the size of the history", async () => {
        const output = "x".repeat(4000);

        await message(0, "assistant", [{ input: {}, toolCallId: "call-1", toolName: "lookup", type: "tool-call" }]);
        await message(1, "tool", [{ output: { type: "text", value: output }, toolCallId: "call-1", toolName: "lookup", type: "tool-result" }]);
        const prompt = await message(2, "user", "summarise");

        const context = await contextFor(prompt);

        expect(context.contextTokens).toBeGreaterThanOrEqual(estimateTokensFromCharacters(output.length));
    });

    it("leaves out the replies a regenerate replaces", async () => {
        const first = await message(0, "user", "write a story");

        await message(0, "assistant", [imagePart], { parentMessageId: first, stepOrder: 1 });

        // Only the first message is read: the image reply it replaces adds nothing.
        await expect(contextFor(first)).resolves.toEqual({
            contextTokens: Math.ceil(estimateTokensFromCharacters("write a story".length)),
            files: false,
            images: false,
        });
    });

    it("sizes a stateless reply from its prompt alone, even when the thread is compacted", async () => {
        const long = "a".repeat(8000);
        const covered = await message(0, "user", long);
        const prompt = await message(1, "user", "continue");

        await harness.run(
            async (ctx: any) =>
                await ctx.db.insert("threadContextSummaries", {
                    coveredCount: 1,
                    coveredUpToMessageId: covered,
                    createdAt: 0,
                    kind: "compact",
                    summary: "a retained summary",
                    taintedBy: [],
                    threadId,
                    userId: OWNER,
                }),
        );

        const stateless = await harness.run(
            async (ctx: any) => await autoRouteContextOf(ctx, { promptMessageId: prompt, stateless: true, threadId: threadId as never }),
        );

        expect(stateless.contextTokens).toBe(Math.ceil(estimateTokensFromCharacters("continue".length)));
    });

    it("classifies every attached file, not only the first fifty", async () => {
        const fileIds: string[] = [];

        for (let index = 0; index < 55; index += 1) {
            fileIds.push(await chatFile(`doc-${index}`, index === 54 ? "image/png" : "text/plain"));
        }

        const prompt = await message(0, "user", "read these", { fileIds });

        await expect(contextFor(prompt)).resolves.toMatchObject({ files: true, images: true });
    });

    it("fails when an attached file cannot be classified, so the caller keeps its fallback", async () => {
        const known = await chatFile("known", "text/plain");
        const gone = await chatFile("gone", "image/png");

        await harness.run(async (ctx: any) => await ctx.db.delete("chatFiles", gone));

        const prompt = await message(0, "user", "read these", { fileIds: [known, gone] });

        await expect(contextFor(prompt)).rejects.toThrow("could not be classified");
    });
});
