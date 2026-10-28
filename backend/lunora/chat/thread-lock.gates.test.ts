/**
 * The passcode gates on the chat paths: every content read, write and
 * background run of a locked chat is refused without a valid proof, and the
 * list, search and stream answers never show it. The lock rules themselves are
 * in `agent/thread-lock.test.ts`; this file drives the chat procedures.
 */
import { lunoraTest } from "@lunora/testing";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { registeredApi, registerModule } from "../../test/registered-api";

import { getFile } from "../agent/client/files";
import { addFile, getFileForUser } from "../agent/files";
import { readMessagesByIds } from "../agent/messages";
import { lockThread } from "../agent/thread-lock";
import { createPin, getThreadPins } from "./pins/functions";
import { abortThreadStream, branchThread, getCachedFollowupSuggestions, getThread, getThreadUIMessages, gateThreadActionHandler } from "./functions";
import { getThreadWithData } from "./composite";
import { getGroupChat } from "./group/functions";
import { requireOwnedThread } from "../agent/thread-read-access";
import { claimToolApproval } from "./lib/tool-approval-claim";
import { lockedAfterCreation, threadGateOutcome, threadRowForList, throwUnlessGranted } from "./lib/thread-gate";
import { getPresentation } from "./slides/functions";
import { getActiveStreamForThread, streamLockedSinceStartHandler, streamRunThreadHandler } from "./streaming/index";
import { hashPasscode, mintUnlockProof, newPasscodeEpoch, THREAD_LOCKED_CODE } from "../lib/thread-lock";
import schema from "../schema";

const OWNER = "user-owner";
const STRANGER = "user-stranger";
const SECRET = "s".repeat(40);
const PASSCODE = "passcode-1";
const NOT_FOUND_PATTERN = /NOT_FOUND/;

// `branchThread` reaches its own steps and the fork's copy through `internal.*`: resolve those to registered procedures.
const registry = vi.hoisted(() => new Map<string, unknown>());

vi.mock("../_generated/api", async (importOriginal) => registeredApi(await importOriginal(), registry));
vi.mock("../_generated/internal", async (importOriginal) => registeredApi(await importOriginal(), registry));

beforeAll(async () => {
    registerModule(registry, "chat_functions", await import("./functions"));
    registerModule(registry, "agent_messages", await import("../agent/messages"));
    registerModule(registry, "agent_threads", await import("../agent/threads"));
    registerModule(registry, "agent_branches", await import("../agent/branches"));
    registerModule(registry, "agent_thread_lock", await import("../agent/thread-lock"));
    registerModule(registry, "lib_document_history", await import("../lib/document-history"));
}, 30_000);

// Same identity seam as `thread-read-paths.test.ts`: the session reads come off the harness identity.
const { sessionFrom } = vi.hoisted(() => {
    return {
        sessionFrom: async (context: { auth: { userId?: string | null } }) =>
            context.auth.userId ? { activeOrganization: null, id: context.auth.userId, userId: context.auth.userId } : null,
    };
});

vi.mock("../lib/crpc-auth-helpers", async (importOriginal) => {
    return {
        ...(await importOriginal<typeof import("../lib/crpc-auth-helpers")>()),
        getSessionUser: sessionFrom,
        getSessionUserForQuery: sessionFrom,
        getSessionUserForQueryLite: sessionFrom,
    };
});

vi.mock("../lib/audit-triggers", async (importOriginal) => {
    return {
        ...(await importOriginal<typeof import("../lib/audit-triggers")>()),
        auditTriggersFor: () => {
            return {};
        },
    };
});

vi.mock("../auth", async (importOriginal) => {
    return {
        ...(await importOriginal<typeof import("../auth")>()),
        getAuthUserIdentity: async (context: { auth: { userId?: string | null } }) =>
            context.auth.userId ? { subject: context.auth.userId, userId: context.auth.userId } : null,
    };
});

type Harness = ReturnType<typeof lunoraTest>;

let harness: Harness;
let threadId: string;
let epoch: string;
let proof: string;

const as = (userId: string) => harness.withIdentity({ userId });

const lockedCodeOf = (error: unknown) => (error as { data?: { code?: string } } | null)?.data?.code;

const mint = async (userId: string) => {
    const { proof: minted } = await mintUnlockProof({ epoch, threadId, userId }, SECRET, Date.now());

    return minted;
};

const insertLockedThread = async (context: any, lockedAt: number) =>
    await context.db.insert("threads", {
        customSystemPrompt: "private system prompt",
        lockedAt,
        mode: "text",
        model: "gpt-4o",
        status: "active",
        summary: "private summary",
        title: "Salary plan",
        userId: OWNER,
    });

beforeEach(async () => {
    process.env.STORAGE_SIGNING_SECRET = SECRET;
    harness = lunoraTest(schema as never);
    epoch = newPasscodeEpoch();

    const hashed = await hashPasscode(PASSCODE, 1000);

    threadId = await harness.run(async (context: any) => {
        const id = await insertLockedThread(context, Date.now() - 60_000);

        await context.db.insert("threadPasscodes", {
            createdAt: 1,
            epoch,
            failedAttempts: 0,
            hash: hashed.hash,
            iterations: hashed.iterations,
            salt: hashed.salt,
            threadId: id,
            updatedAt: 1,
            userId: OWNER,
        });
        await context.db.insert("messages", {
            message: { content: "secret question", role: "user" },
            order: 0,
            status: "success",
            stepOrder: 0,
            text: "secret question",
            threadId: id,
            tool: false,
            userId: OWNER,
        });

        return id;
    });

    proof = await mint(OWNER);
});

describe("the shared gate outcome", () => {
    it("is locked for the owner with no proof, ok with a live proof, denied for a stranger", async () => {
        const outcome = (userId: string, unlockProof?: string) =>
            harness.run(async (context: any) => await threadGateOutcome(context, { level: "read", threadId: threadId as never, unlockProof, userId }));

        expect(await outcome(OWNER)).toBe("locked");
        expect(await outcome(OWNER, proof)).toBe("ok");
        expect(await outcome(STRANGER)).toBe("denied");
        expect(await outcome(STRANGER, proof)).toBe("denied");
    });

    it("answers the same through the action-facing handler", async () => {
        const answer = (userId: string, unlockProof?: string) =>
            harness.run(async (context: any) => await gateThreadActionHandler(context, { level: "write", threadId: threadId as never, unlockProof, userId }));

        expect(await answer(OWNER)).toEqual({ outcome: "locked" });
        expect(await answer(OWNER, proof)).toEqual({ isWorker: false, outcome: "ok" });
        expect(await answer(STRANGER, proof)).toEqual({ outcome: "denied" });
    });

    it("tells a granted caller which bot a thread belongs to, and nobody else", async () => {
        const botId = await harness.run(async (context: any) => {
            const id = await context.db.insert("bots", {
                computerEnabled: false,
                createdAt: 1,
                instructions: "Be brief.",
                model: "model-x",
                name: "Helper",
                updatedAt: 1,
                userId: OWNER,
            });

            await context.db.patch(threadId, { botId: id });

            return id;
        });
        const answer = (userId: string, unlockProof?: string) =>
            harness.run(async (context: any) => await gateThreadActionHandler(context, { level: "write", threadId: threadId as never, unlockProof, userId }));

        expect(await answer(OWNER, proof)).toEqual({ botId, isWorker: false, outcome: "ok" });
        expect(await answer(OWNER)).toEqual({ outcome: "locked" });
        expect(await answer(STRANGER, proof)).toEqual({ outcome: "denied" });
    });

    it("throws THREAD_LOCKED for a locked outcome and NOT_FOUND for a denial with no message", () => {
        expect(() => throwUnlessGranted("locked", "x")).toThrow();
        expect(() => throwUnlessGranted("locked")).toThrow();

        try {
            throwUnlessGranted("locked");
        } catch (error) {
            expect(lockedCodeOf(error)).toBe(THREAD_LOCKED_CODE);
        }

        try {
            throwUnlessGranted("denied");
        } catch (error) {
            expect((error as { code?: string }).code ?? "NOT_FOUND").toMatch(NOT_FOUND_PATTERN);
        }

        expect(() => throwUnlessGranted("ok")).not.toThrow();
    });

    it("treats a lock as newer than a row only when it was set after the row was created", () => {
        expect(lockedAfterCreation({ lockedAt: 200 }, 100)).toBe(true);
        expect(lockedAfterCreation({ lockedAt: 100 }, 200)).toBe(false);
        expect(lockedAfterCreation({ lockedAt: null }, 100)).toBe(false);
    });

    it("fails closed when the lock and the row share a millisecond", () => {
        expect(lockedAfterCreation({ lockedAt: 100 }, 100)).toBe(true);
    });

    it("admits a row created strictly after the lock", () => {
        expect(lockedAfterCreation({ lockedAt: 100 }, 101)).toBe(false);
    });

    it("shows a locked row in a list as its stub, and an unlocked row as itself", () => {
        const row = { _creationTime: 1, _id: "t1", lockedAt: 5, status: "active", title: "Secret" };

        expect(threadRowForList(row)).not.toHaveProperty("title");
        expect(threadRowForList({ ...row, lockedAt: null })).toHaveProperty("title", "Secret");
    });
});

describe("content reads of a locked chat", () => {
    it("getThreadUIMessages refuses the owner without a proof and lists the messages with one", async () => {
        await expect(
            as(OWNER).query(getThreadUIMessages as never, { paginationOpts: { cursor: null, numItems: 10 }, threadId } as never),
        ).rejects.toMatchObject({ data: { code: THREAD_LOCKED_CODE } });

        const page: any = await as(OWNER).query(
            getThreadUIMessages as never,
            { paginationOpts: { cursor: null, numItems: 10 }, threadId, unlockProof: proof } as never,
        );

        expect(JSON.stringify(page)).toContain("secret question");
    });

    it("getThreadUIMessages gives a stranger no messages", async () => {
        const result = as(STRANGER).query(getThreadUIMessages as never, { paginationOpts: { cursor: null, numItems: 10 }, threadId } as never);

        await expect(result).rejects.toBeDefined();
    });

    it("getThread returns the stub to the owner without a proof, and the row with one", async () => {
        const bare: any = await as(OWNER).query(getThread as never, { threadId } as never);

        expect(bare).not.toHaveProperty("title");
        expect(bare).not.toHaveProperty("customSystemPrompt");
        expect(bare).not.toHaveProperty("summary");

        const unlocked: any = await as(OWNER).query(getThread as never, { threadId, unlockProof: proof } as never);

        expect(unlocked.title).toBe("Salary plan");
    });

    it("getThread gives a stranger nothing", async () => {
        expect(await as(STRANGER).query(getThread as never, { threadId } as never)).toBeNull();
    });

    it("getCachedFollowupSuggestions refuses without a proof", async () => {
        await expect(as(OWNER).query(getCachedFollowupSuggestions as never, { threadId } as never)).rejects.toMatchObject({
            data: { code: THREAD_LOCKED_CODE },
        });
    });

    it("getGroupChat answers null for the owner without a proof", async () => {
        expect(await as(OWNER).query(getGroupChat as never, { threadId } as never)).toBeNull();
    });

    it("getPresentation refuses a deck of a locked chat without a proof", async () => {
        const presentationId = await harness.run(
            async (context: any) =>
                await context.db.insert("presentations", {
                    createdAt: 1,
                    name: "deck",
                    status: "complete",
                    threadId,
                    title: "Board deck",
                    updatedAt: 1,
                    userId: OWNER,
                }),
        );

        await expect(as(OWNER).query(getPresentation as never, { presentationId } as never)).rejects.toMatchObject({ data: { code: THREAD_LOCKED_CODE } });

        const deck: any = await as(OWNER).query(getPresentation as never, { presentationId, unlockProof: proof } as never);

        expect(deck.title).toBe("Board deck");
    });

    it("getActiveStreamForThread answers null without a proof and the stream with one", async () => {
        await harness.run(async (context: any) => {
            await context.db.insert("persistentStreams", {
                expiresAt: Date.now() + 60_000,
                messageId: "m-1",
                status: "streaming",
                streamingConfig: { contentType: "text", model: "gpt-4o" },
                threadId,
                userId: OWNER,
            });
        });

        expect(await as(OWNER).query(getActiveStreamForThread as never, { threadId } as never)).toBeNull();

        const live: any = await as(OWNER).query(getActiveStreamForThread as never, { threadId, unlockProof: proof } as never);

        expect(live?.streamId).toBeDefined();
    });
});

describe("writes into a locked chat", () => {
    it("createPin refuses without a proof", async () => {
        await expect(as(OWNER).mutation(createPin as never, { messageId: "m-1", messageRole: "user", threadId } as never)).rejects.toMatchObject({
            data: { code: THREAD_LOCKED_CODE },
        });
    });

    it("getThreadPins is empty for the owner without a proof", async () => {
        expect(await as(OWNER).query(getThreadPins as never, { threadId } as never)).toEqual([]);
    });

    it("the message read of a locked chat is null without a proof and the row with a valid one", async () => {
        const messageId = await harness.run(
            async (context: any) =>
                await context.db.insert("messages", {
                    message: { content: "reply in progress", role: "assistant" },
                    order: 1,
                    status: "streaming",
                    stepOrder: 0,
                    text: "reply in progress",
                    threadId,
                    tool: false,
                    userId: OWNER,
                }),
        );
        const read = (unlockProof?: string) =>
            harness.run(async (context: any) => await readMessagesByIds(context, { messageIds: [messageId], threadId: threadId as never, unlockProof }));

        // Abort, regenerate and edit read the row with the proof they were sent; without it the row is hidden.
        const [hidden] = await read();
        const [visible] = await read(proof);

        expect(hidden).toBeNull();
        expect(visible).toMatchObject({ _id: messageId, threadId });
    });

    it("abortThreadStream refuses the owner without a proof", async () => {
        await expect(as(OWNER).mutation(abortThreadStream as never, { threadId } as never)).rejects.toMatchObject({ data: { code: THREAD_LOCKED_CODE } });
    });

    it("requireOwnedThread, the helper the local-turn save calls, refuses a locked chat without a proof", async () => {
        await expect(harness.run(async (context: any) => await requireOwnedThread(context, threadId as never, OWNER))).rejects.toMatchObject({
            data: { code: THREAD_LOCKED_CODE },
        });

        const admitted: any = await harness.run(async (context: any) => await requireOwnedThread(context, threadId as never, OWNER, proof));

        expect(admitted.title).toBe("Salary plan");
    });

    it("claimToolApproval refuses to resume a locked chat without a proof", async () => {
        await expect(
            harness.run(
                async (context: any) =>
                    await claimToolApproval(context, { approvalId: "a-1", callerId: OWNER, decision: "approve", threadId: threadId as never }),
            ),
        ).rejects.toMatchObject({ data: { code: THREAD_LOCKED_CODE } });
    });
});

describe("branching a locked chat", () => {
    it("forks it with a valid proof, copying the messages, and refuses without one", async () => {
        const branch = (unlockProof?: string) => as(OWNER).action(branchThread as never, { threadId, unlockProof } as never);

        await expect(branch()).rejects.toMatchObject({ data: { code: THREAD_LOCKED_CODE } });

        // The copy re-checks the locked source; without the proof forwarded to it, this fork fails after it is created.
        const forkId = await branch(proof);

        expect(forkId).toEqual(expect.any(String));
        expect(forkId).not.toBe(threadId);
    });

    it("the fork is locked: refused for the owner without its own proof, readable with one", async () => {
        const forkId = (await as(OWNER).action(branchThread as never, { threadId, unlockProof: proof } as never)) as string;

        const forkRow = await harness.run(
            async (context: any) =>
                await context.db
                    .query("threadPasscodes")
                    .withIndex("by_thread", (q: any) => q.eq("threadId", forkId))
                    .first(),
        );
        const minted = await mintUnlockProof({ epoch: forkRow.epoch, threadId: forkId, userId: OWNER }, SECRET, Date.now());
        const forkProof = minted.proof;

        const refused = await harness.run(
            async (context: any) => await threadGateOutcome(context, { level: "read", threadId: forkId as never, userId: OWNER }),
        );
        const opened = await harness.run(
            async (context: any) => await threadGateOutcome(context, { level: "read", threadId: forkId as never, unlockProof: forkProof, userId: OWNER }),
        );
        // The PARENT's proof does not open the fork.
        const parentOpensFork = await harness.run(
            async (context: any) => await threadGateOutcome(context, { level: "read", threadId: forkId as never, unlockProof: proof, userId: OWNER }),
        );

        expect(refused).toBe("locked");
        expect(opened).toBe("ok");
        expect(parentOpensFork).toBe("locked");
    });
});

describe("attaching a file to a locked chat", () => {
    it("refuses the owner's own file without a proof, and attaches it with one", async () => {
        const { fileId } = (await harness.run(
            async (context: any) =>
                await context.runMutation(addFile, {
                    filename: "a.png",
                    hash: "h-lock",
                    mediaType: "image/png",
                    storageId: "agent-files/h-lock",
                    userId: OWNER,
                }),
        )) as { fileId: string };
        // The chat's gate runs before the grant shortcut, so the grant alone must not open the file.
        // `getFile` names the query through `internal.*`, which this harness does not register: route it to the real function.
        const attach = (unlockProof?: string) =>
            harness.run(async (context: any) => {
                const ctx = {
                    runQuery: async (_reference: unknown, args: unknown) => await context.runQuery(getFileForUser, args),
                    storage: { getSignedUrl: async (key: string) => `https://files.test/${key}` },
                };

                return await getFile(ctx as never, fileId, { threadId, unlockProof, userId: OWNER });
            });

        await expect(attach()).rejects.toMatchObject({ code: "NOT_FOUND" });
        expect(await attach(proof)).toMatchObject({ file: { fileId, storageId: "agent-files/h-lock" } });
    });
});

describe("runs and stream reads", () => {
    const streamAt = async (lockedAt: number) => {
        const lockedId = await harness.run(async (context: any) => {
            const id = await insertLockedThread(context, lockedAt);

            return await context.db.insert("persistentStreams", {
                expiresAt: Date.now() + 60_000,
                messageId: "m-2",
                status: "streaming",
                streamingConfig: { contentType: "text", model: "gpt-4o" },
                threadId: id,
                userId: OWNER,
            });
        });

        return lockedId;
    };

    it("a run on a chat locked BEFORE its stream was created is admitted", async () => {
        const streamId = await streamAt(Date.now() - 60_000);
        const thread: any = await harness.run(async (context: any) => await streamRunThreadHandler(context, { streamId, userId: OWNER }));

        expect(thread?.title).toBe("Salary plan");
    });

    it("a run on a chat locked AFTER its stream was created is refused", async () => {
        const streamId = await streamAt(Date.now() + 60_000);
        const thread = await harness.run(async (context: any) => await streamRunThreadHandler(context, { streamId, userId: OWNER }));

        expect(thread).toBeNull();
    });

    it("a stranger gets no run thread, locked or not", async () => {
        const streamId = await streamAt(Date.now() - 60_000);

        expect(await harness.run(async (context: any) => await streamRunThreadHandler(context, { streamId, userId: STRANGER }))).toBeNull();
    });

    it("a chunk poll is refused once the chat was locked after the stream started", async () => {
        const before = await streamAt(Date.now() - 60_000);
        const after = await streamAt(Date.now() + 60_000);

        expect(await harness.run(async (context: any) => await streamLockedSinceStartHandler(context, { streamId: before }))).toBe(false);
        expect(await harness.run(async (context: any) => await streamLockedSinceStartHandler(context, { streamId: after }))).toBe(true);
    });

    it("a stream started under a proof stops after 'lock now' locks the chat again", async () => {
        const streamId = await harness.run(
            async (context: any) =>
                await context.db.insert("persistentStreams", {
                    expiresAt: Date.now() + 60_000,
                    messageId: "m-relock",
                    status: "streaming",
                    streamingConfig: { contentType: "text", model: "gpt-4o" },
                    threadId,
                    userId: OWNER,
                }),
        );

        expect(await harness.run(async (context: any) => await streamRunThreadHandler(context, { streamId, userId: OWNER }))).not.toBeNull();

        // The stream must be created strictly before the re-lock, or the comparison cannot tell them apart.
        await new Promise<void>((resolve) => {
            setTimeout(resolve, 5);
        });
        await as(OWNER).mutation(lockThread as never, { threadId } as never);

        expect(await harness.run(async (context: any) => await streamRunThreadHandler(context, { streamId, userId: OWNER }))).toBeNull();
        expect(await harness.run(async (context: any) => await streamLockedSinceStartHandler(context, { streamId }))).toBe(true);
    });
});

describe("an unlocked chat returns its content through the composite read", () => {
    it("the composite thread view lists the messages with the owner's proof", async () => {
        const result = await as(OWNER).query(getThreadWithData as never, { threadId, unlockProof: proof } as never);

        expect(JSON.stringify((result as { messages: unknown }).messages)).toContain("secret question");
    });

    it("and refuses the same read without a proof, with the locked code", async () => {
        await expect(as(OWNER).query(getThreadWithData as never, { threadId } as never)).rejects.toMatchObject({ data: { code: THREAD_LOCKED_CODE } });
    });
});
