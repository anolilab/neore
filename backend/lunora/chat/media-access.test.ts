/**
 * `/chat/media` starts paid generations that land as replies in the message's
 * thread. Authorship alone is not enough — a collaborator downgraded to view
 * (or revoked) still authored their old messages — so the route also needs
 * WRITE access to the thread, and the body's `threadId` (which picked the
 * shard) must be the message's own. Past that gate, only the message's author or
 * the thread's owner may generate: the owner regenerates a collaborator's prompt.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import { mediaGenerationHttpAction } from "./http";

const currentUser = vi.hoisted(() => {
    return { value: undefined as Record<string, unknown> | undefined };
});

vi.mock("../auth/lib/helper", async (importOriginal) => {
    return {
        ...(await importOriginal<typeof import("../auth/lib/helper")>()),
        getCurrentUserInternal: async () => currentUser.value,
    };
});

const MESSAGE_ID = "k57a1b2c3d4e5f6g7h8j9k0m1n2p3q4r";
const THREAD_ID = "k17a1b2c3d4e5f6g7h8j9k0m1n2p3q4r";
const OTHER_THREAD_ID = "k27a1b2c3d4e5f6g7h8j9k0m1n2p3q4r";
const COLLABORATOR = "collaborator-1";
const OWNER = "owner-1";
const OTHER_COLLABORATOR = "collaborator-2";

const post = (body: Record<string, unknown>) =>
    new Request("https://x/chat/media", {
        body: JSON.stringify({ messageId: MESSAGE_ID, streamingConfig: { contentType: "image", model: "fal-ai/flux/schnell" }, ...body }),
        method: "POST",
    });

describe("/chat/media on a shared thread", () => {
    let runQuery: ReturnType<typeof vi.fn>;
    let runMutation: ReturnType<typeof vi.fn>;

    beforeEach(() => {
        currentUser.value = { _id: COLLABORATOR, isAnonymous: false };
        runMutation = vi.fn(async () => {
            return { ok: false };
        });
        runQuery = vi.fn();
        // 1: the message, authored by the collaborator. 2: their current access.
        runQuery.mockResolvedValueOnce([{ _id: MESSAGE_ID, text: "a cat", threadId: THREAD_ID, userId: COLLABORATOR }]);
    });

    it("refuses an author who no longer has write access, before charging anything", async () => {
        runQuery.mockResolvedValueOnce({ outcome: "denied" });

        const response = await mediaGenerationHttpAction({ runMutation, runQuery } as never, post({ threadId: THREAD_ID }));

        expect(response.status).toBe(403);
        expect(runQuery).toHaveBeenLastCalledWith(expect.anything(), expect.objectContaining({ level: "write", threadId: THREAD_ID, userId: COLLABORATOR }));
        expect(runMutation).not.toHaveBeenCalled();
    });

    it("refuses a body threadId that is not the message's thread", async () => {
        const response = await mediaGenerationHttpAction({ runMutation, runQuery } as never, post({ threadId: OTHER_THREAD_ID }));

        expect(response.status).toBe(400);
        expect(runMutation).not.toHaveBeenCalled();
    });

    it("refuses a thread a paired computer runs, before charging anything", async () => {
        runQuery.mockResolvedValueOnce({ hostRun: true, outcome: "ok" });

        const response = await mediaGenerationHttpAction({ runMutation, runQuery } as never, post({ threadId: THREAD_ID }));

        expect(response.status).toBe(409);
        expect(runMutation).not.toHaveBeenCalled();
    });

    it("goes on to the daily charge for the author with write access (control)", async () => {
        runQuery.mockResolvedValueOnce({ outcome: "ok", ownerId: OWNER });

        const response = await mediaGenerationHttpAction({ runMutation, runQuery } as never, post({ threadId: THREAD_ID }));

        // The stubbed charge refuses, so the route stops at the daily limit — past the access check.
        expect(response.status).toBe(403);
        expect(await response.json()).toMatchObject({ error: "DAILY_IMAGE_LIMIT_REACHED" });
        expect(runMutation).toHaveBeenCalledOnce();
    });

    it("lets the thread's owner regenerate a collaborator's prompt", async () => {
        currentUser.value = { _id: OWNER, isAnonymous: false };
        runQuery.mockResolvedValueOnce({ outcome: "ok", ownerId: OWNER });

        const response = await mediaGenerationHttpAction({ runMutation, runQuery } as never, post({ threadId: THREAD_ID }));

        expect(await response.json()).toMatchObject({ error: "DAILY_IMAGE_LIMIT_REACHED" });
        expect(runMutation).toHaveBeenCalledOnce();
    });

    it("refuses another collaborator with write access who is neither the author nor the owner", async () => {
        currentUser.value = { _id: OTHER_COLLABORATOR, isAnonymous: false };
        runQuery.mockResolvedValueOnce({ outcome: "ok", ownerId: OWNER });

        const response = await mediaGenerationHttpAction({ runMutation, runQuery } as never, post({ threadId: THREAD_ID }));

        expect(response.status).toBe(403);
        expect(await response.json()).toStrictEqual({ error: "Forbidden" });
        expect(runMutation).not.toHaveBeenCalled();
    });
});
