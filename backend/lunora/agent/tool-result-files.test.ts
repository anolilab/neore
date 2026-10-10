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
