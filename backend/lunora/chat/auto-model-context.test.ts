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

    it("leaves out the replies a regenerate replaces", async () => {
        const first = await message(0, "user", "write a story");

        await message(0, "assistant", [imagePart], { parentMessageId: first, stepOrder: 1 });

        await expect(contextFor(first)).resolves.toEqual({ contextTokens: 0, files: false, images: false });
    });

    it("classifies every attached file, not only the first fifty", async () => {
        const fileIds: string[] = [];

        for (let index = 0; index < 55; index += 1) {
            fileIds.push(await chatFile(`doc-${index}`, index === 54 ? "image/png" : "text/plain"));
        }

        const prompt = await message(0, "user", "read these", { fileIds });

        await expect(contextFor(prompt)).resolves.toEqual({ contextTokens: 0, files: true, images: true });
    });

    it("fails when an attached file cannot be classified, so the caller keeps its fallback", async () => {
        const known = await chatFile("known", "text/plain");
        const gone = await chatFile("gone", "image/png");

        await harness.run(async (ctx: any) => await ctx.db.delete("chatFiles", gone));

        const prompt = await message(0, "user", "read these", { fileIds: [known, gone] });

        await expect(contextFor(prompt)).rejects.toThrow("could not be classified");
    });
});
