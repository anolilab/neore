/**
 * Media a tool stored (sandbox outputs, image edits) is referenced only inside
 * the tool result. `addMessagesHandler` puts the referenced chat files on the
 * message's `fileIds`, so they live exactly as long as the message: counted
 * while it exists, released — and then collected by the unused-file sweep —
 * when its thread or the whole account is deleted.
 */
import { lunoraTest } from "@lunora/testing";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { registeredApi, registerModule } from "../../test/registered-api";
import schema from "../schema";
import { storeFile } from "./client/files";

const registry = vi.hoisted(() => new Map<string, unknown>());

vi.mock("../_generated/api", async (importOriginal) => registeredApi(await importOriginal(), registry));
vi.mock("../_generated/internal", async (importOriginal) => registeredApi(await importOriginal(), registry));

const OWNER = "user-owner";
const DAY_MS = 24 * 60 * 60 * 1000;
const STORED_CHAT_FILE_REF = /^storage:agent-files\/[\da-f]{64}$/u;

type Harness = ReturnType<typeof lunoraTest>;

let harness: Harness;
let threadId: string;

/** An action context whose mutations run against the harness and whose storage is a stub. */
const actionContext = () => {
    return {
        runAction: vi.fn(),
        runMutation: async (reference: unknown, args: unknown) => await harness.run(async (ctx: any) => await ctx.runMutation(reference, args)),
        runQuery: async (reference: unknown, args: unknown) => await harness.run(async (ctx: any) => await ctx.runQuery(reference, args)),
        storage: { getSignedUrl: async (key: string) => `https://signed.example/${key}?sig=x`, store: vi.fn(async () => undefined) },
    };
};

const fileRow = async (fileId: string): Promise<{ refcount: number } | null> =>
    await harness.run(async (ctx: any) => await ctx.db.chatFiles.findFirst({ where: { _id: fileId } }));

/** A sandbox run's output file, as the tool stores it. */
const storeOutput = async (bytes = "chart") => {
    const { file } = await storeFile(actionContext() as never, new Blob([bytes], { type: "image/png" }), { filename: "chart.png", threadId, userId: OWNER });

    return file;
};

/** The tool message carrying the output, saved the way the agent saves it. */
const saveToolResult = async (output: unknown) => {
    const { addMessages } = await import("./messages");

    await harness.run(
        async (ctx: any) =>
            await ctx.runMutation(addMessages, {
                messages: [
                    {
                        message: {
                            content: [{ output: { type: "json", value: output }, toolCallId: "call-1", toolName: "runCode", type: "tool-result" }],
                            role: "tool",
                        },
                    },
                ],
                threadId,
                userId: OWNER,
            }),
    );
};

const sweepUnusedFiles = async () => {
    const { deleteUnusedFiles } = await import("../crons");

    vi.setSystemTime(Date.now() + DAY_MS + 60_000);
    await harness.run(async (ctx: any) => await ctx.runMutation(deleteUnusedFiles, {}));
};

beforeAll(async () => {
    registerModule(registry, "agent_files", await import("./files"));
    registerModule(registry, "agent_threads", await import("./threads"));
    registerModule(registry, "agent_users", await import("./users"));
    registerModule(registry, "crons", await import("../crons"));
});

beforeEach(async () => {
    vi.useFakeTimers({ now: Date.now(), toFake: ["Date"] });
    harness = lunoraTest(schema as never);
    threadId = await harness.run(async (ctx: any) => await ctx.db.insert("threads", { title: "T", userId: OWNER }));
});

afterEach(() => {
    harness.close();
    vi.useRealTimers();
});

describe("tool-result files", () => {
    it("are counted by the tool message that references them, so the sweep keeps them", async () => {
        const file = await storeOutput();

        await saveToolResult({ files: [{ name: "chart.png", url: `storage:${file.storageId}` }] });

        expect(await fileRow(file.fileId)).toMatchObject({ refcount: 1 });

        await sweepUnusedFiles();

        expect(await fileRow(file.fileId)).not.toBeNull();
    });

    it("are released with their thread and then collected by the unused-file sweep", async () => {
        const { deleteAllForThreadIdAsync } = await import("./threads");
        const file = await storeOutput();

        // An image tool returns the signed URL; the key inside it counts too.
        await saveToolResult({ imageUrl: file.url });
        await harness.run(async (ctx: any) => await ctx.runMutation(deleteAllForThreadIdAsync, { threadId }));

        expect(await fileRow(file.fileId)).toMatchObject({ refcount: 0 });

        await sweepUnusedFiles();

        expect(await fileRow(file.fileId)).toBeNull();
    });

    it("are released when the account is deleted, and collected", async () => {
        const { deleteAllForUserIdAsync } = await import("./users");
        const file = await storeOutput();

        await saveToolResult({ files: [{ url: `storage:${file.storageId}` }] });
        await harness.run(async (ctx: any) => await ctx.runMutation(deleteAllForUserIdAsync, { userId: OWNER }));

        expect(await fileRow(file.fileId)).toMatchObject({ refcount: 0 });

        await sweepUnusedFiles();

        expect(await fileRow(file.fileId)).toBeNull();
    });

    it("never count a file the author holds no grant for", async () => {
        const { addFile } = await import("./files");
        const foreignKey = `agent-files/${"b".repeat(64)}`;
        const { fileId } = (await harness.run(
            async (ctx: any) =>
                await ctx.runMutation(addFile, {
                    filename: "x.png",
                    hash: "b".repeat(64),
                    mediaType: "image/png",
                    storageId: foreignKey,
                    userId: "someone-else",
                }),
        )) as { fileId: string };

        // A tool's output (an MCP server, say) naming another user's object.
        await saveToolResult({ text: `see storage:${foreignKey}` });

        expect(await fileRow(fileId)).toMatchObject({ refcount: 0 });
    });
});

describe("inline media in a tool result", () => {
    /** A browser screenshot the size of a real one: 1.5 MB of PNG bytes, 2 MB as base64 (a shard row holds at most 2 MB). */
    const SCREENSHOT = Buffer.alloc(1.5 * 1024 * 1024, 7).toString("base64");

    /** One step whose tool results are `outputs`, all from `toolName`, saved the way the agent saves a step. */
    const saveSteps = async (outputs: unknown[], toolName: string) => {
        const { serializeStepContent } = await import("./mapping");
        const { addMessages } = await import("./messages");
        const { messageFileIds, partContent } = await serializeStepContent(
            actionContext() as never,
            outputs.map((output, index) => {
                return { input: {}, output, toolCallId: `call-${String(index)}`, toolName, type: "tool-result" };
            }) as never,
            { threadId, userId: OWNER },
        );

        await harness.run(
            async (ctx: any) =>
                await ctx.runMutation(addMessages, {
                    messages: [{ fileIds: messageFileIds, message: { content: partContent, role: "tool" } }],
                    threadId,
                    userId: OWNER,
                }),
        );

        const rows = await harness.run(
            async (ctx: any) =>
                await ctx.db
                    .query("messages")
                    .withIndex("threadId_status_tool_order_stepOrder", (q: any) => q.eq("threadId", threadId))
                    .collect(),
        );

        return rows.at(-1);
    };

    const saveStep = async (output: unknown, toolName = "browser") => await saveSteps([output], toolName);

    /** The row as a later turn reads it: references signed for the message's owner only. */
    const readBack = async (row: any) => {
        const { resolveDocsStoredMedia } = await import("./stored-media");
        const { ownedStorageKeys } = await import("../lib/storage-ownership");
        const [doc] = await resolveDocsStoredMedia([{ fileIds: row.fileIds, message: row.message, userId: OWNER }], {
            lookupKeys: async () => new Map(),
            lookupOwnedKeys: async (userId, keys) => await harness.run(async (ctx: any) => await ownedStorageKeys(ctx.db, userId, keys)),
            origins: [],
            sign: async (key) => `https://signed.example/${key}?sig=x`,
        });

        return doc!.message!.content as { output: { value: Record<string, unknown> } }[];
    };

    it("is saved as a reference to a counted file and comes back as a signed URL", async () => {
        const row = await saveStep({ screenshot: SCREENSHOT, screenshotFormat: "png", success: true, title: "Page" });
        const saved = row.message.content[0].output.value;

        expect(saved.screenshot).toBeUndefined();
        expect(saved.screenshotUrl).toMatch(STORED_CHAT_FILE_REF);
        expect(JSON.stringify(row.message).length).toBeLessThan(1024);
        expect(row.fileIds).toHaveLength(1);
        expect(await fileRow(row.fileIds[0])).toMatchObject({ refcount: 1 });

        const [part] = await readBack(row);

        expect(part!.output.value).toMatchObject({
            screenshotFormat: "png",
            screenshotUrl: `https://signed.example/${saved.screenshotUrl.slice("storage:".length)}?sig=x`,
            title: "Page",
        });
    });

    it("stores identical media from parallel tool results once, so its file is released with the message", async () => {
        const { deleteAllForThreadIdAsync } = await import("./threads");
        const output = { content: [{ data: SCREENSHOT, mimeType: "image/png", type: "image" }] };
        // Two results of one step serialize at the same time.
        const row = await saveSteps([output, output], "mcp_files__render");
        const [first, second] = row.message.content.map((part: any) => part.output.value.content[0].data);

        expect(first).toMatch(STORED_CHAT_FILE_REF);
        expect(second).toBe(first);
        expect(new Set(row.fileIds).size).toBe(1);
        expect(await fileRow(row.fileIds[0])).toMatchObject({ refcount: 1 });

        await harness.run(async (ctx: any) => await ctx.runMutation(deleteAllForThreadIdAsync, { threadId }));

        expect(await fileRow(row.fileIds[0])).toMatchObject({ refcount: 0 });
    });

    it("does not count a file a racing store added first", async () => {
        const { addFile } = await import("./files");
        const add = async () =>
            (await harness.run(
                async (ctx: any) =>
                    await ctx.runMutation(addFile, {
                        filename: "x.png",
                        hash: "d".repeat(64),
                        mediaType: "image/png",
                        storageId: `agent-files/${"d".repeat(64)}`,
                        userId: OWNER,
                    }),
            )) as { fileId: string };

        const { fileId } = await add();
        const racing = await add();

        expect(racing.fileId).toBe(fileId);
        expect(await fileRow(fileId)).toMatchObject({ refcount: 0 });
    });

    it("never resolves a look-alike reference to another user's real file", async () => {
        // A file that exists, owned by someone else: only the owner rule keeps it out.
        const { file: foreign } = await storeFile(actionContext() as never, new Blob(["their chart"], { type: "image/png" }), {
            filename: "theirs.png",
            userId: "someone-else",
        });
        const row = await saveStep({ content: [{ data: `storage:${foreign.storageId}`, mimeType: "image/png", type: "image" }] }, "mcp_files__render");

        expect(row.fileIds ?? []).toHaveLength(0);
        expect(await fileRow(foreign.fileId)).toMatchObject({ refcount: 0 });

        const [part] = await readBack(row);

        expect(part!.output.value).toStrictEqual({ content: [{ data: "", mimeType: "image/png", type: "image" }] });
    });
});
