/**
 * API keys have no unlock path: a locked thread is not found, and never listed,
 * through the public routes. Drives the real route handlers with a fake ctx.
 */
import { describe, expect, it, vi } from "vitest";

import { ROUTES } from "./routes";
import { THREAD_LOCKED_CODE } from "../lib/thread-lock";

const route = (operationId: string) => {
    const found = ROUTES.find((candidate) => candidate.operationId === operationId);

    if (!found) {
        throw new Error(`no route ${operationId}`);
    }

    return found;
};

const lockedError = () => Object.assign(new Error("This chat is locked."), { data: { code: THREAD_LOCKED_CODE } });

const input = (ctx: unknown, extra: Record<string, unknown> = {}) => {
    return {
        ctx,
        identity: { userId: "owner" },
        params: { threadId: "t1" },
        query: {},
        ...extra,
    };
};

describe("public API and locked threads", () => {
    it("answers a locked thread's detail as not found", async () => {
        const ctx = {
            runQuery: vi.fn(async () => {
                return { _id: "t1", lockedAt: 1, status: "active", userId: "owner" };
            }),
        };

        await expect(route("getThread").handler(input(ctx) as never)).rejects.toMatchObject({ code: "not_found" });
    });

    it("maps a THREAD_LOCKED refusal to not found for messages", async () => {
        const ctx = {
            runQuery: vi.fn(async () => {
                throw lockedError();
            }),
        };

        await expect(route("listMessages").handler(input(ctx) as never)).rejects.toMatchObject({ code: "not_found" });
    });

    it("omits locked threads from the list, with no title", async () => {
        const ctx = {
            runQuery: vi.fn(async () => {
                return {
                    continueCursor: "",
                    isDone: true,
                    page: [
                        { _creationTime: 1, _id: "open", status: "active", title: "Open chat", userId: "owner" },
                        { _creationTime: 2, _id: "locked", lockedAt: 2, status: "active", title: "Secret plan", userId: "owner" },
                    ],
                };
            }),
        };
        const result = (await route("listThreads").handler(input(ctx, { query: {} }) as never)) as { data: { data: { id: string; title?: string }[] } };

        expect(result.data.data.map((thread) => thread.id)).toEqual(["open"]);
        expect(JSON.stringify(result)).not.toContain("Secret plan");
    });

    describe("deleting", () => {
        const deleteInput = (runQuery: () => Promise<unknown>) => {
            const runMutation = vi.fn(async () => {
                return { isDone: true };
            });

            return { ctx: { runMutation, runQuery }, runMutation };
        };

        it("does not delete a thread the read returns locked", async () => {
            const { ctx, runMutation } = deleteInput(async () => {
                return { _id: "t1", lockedAt: 1, status: "active", userId: "owner" };
            });

            await expect(route("deleteThread").handler(input(ctx) as never)).rejects.toMatchObject({ code: "not_found" });
            expect(runMutation).not.toHaveBeenCalled();
        });

        it("does not delete a thread the read refuses as locked", async () => {
            const { ctx, runMutation } = deleteInput(async () => {
                throw lockedError();
            });

            await expect(route("deleteThread").handler(input(ctx) as never)).rejects.toMatchObject({ code: "not_found" });
            expect(runMutation).not.toHaveBeenCalled();
        });

        it("deletes an unlocked thread", async () => {
            const { ctx, runMutation } = deleteInput(async () => {
                return { _id: "t1", status: "active", userId: "owner" };
            });

            await expect(route("deleteThread").handler(input(ctx) as never)).resolves.toEqual({ data: { deleted: true, id: "t1" } });
            expect(runMutation).toHaveBeenCalledOnce();
        });
    });
});
