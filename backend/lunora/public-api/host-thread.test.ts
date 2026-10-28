/** A coding-agent thread's turn runs on the user's computer, so the public API does not delete it out from under that turn. */
import { describe, expect, it, vi } from "vitest";

import { ROUTES } from "./routes";

const deleteRoute = ROUTES.find((candidate) => candidate.operationId === "deleteThread");

const input = (thread: Record<string, unknown>) => {
    const runMutation = vi.fn(async () => {
        return { isDone: true };
    });
    const ctx = { runMutation, runQuery: vi.fn(async () => thread) };

    return { ctx, input: { ctx, identity: { userId: "owner" }, params: { threadId: "t1" }, query: {} }, runMutation };
};

describe("DELETE /threads/{threadId}", () => {
    it("refuses a host-run thread as a conflict and deletes nothing", async () => {
        const { input: request, runMutation } = input({ _id: "t1", runner: "host", status: "active", userId: "owner" });

        await expect(deleteRoute?.handler(request as never)).rejects.toMatchObject({ code: "conflict" });
        expect(runMutation).not.toHaveBeenCalled();
        expect(deleteRoute?.mayConflict).toBe(true);
    });

    it("still deletes a cloud thread", async () => {
        const { input: request, runMutation } = input({ _id: "t1", status: "active", userId: "owner" });

        await expect(deleteRoute?.handler(request as never)).resolves.toEqual({ data: { deleted: true, id: "t1" } });
        expect(runMutation).toHaveBeenCalledOnce();
    });
});
