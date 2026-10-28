/**
 * The person-facing worker procedures, run as a signed-in caller with row-level security on: one
 * message starts one run, a retry with the same `clientId` returns it, an archived worker refuses,
 * and a stranger can neither list nor dispatch.
 */
import { lunoraTest } from "@lunora/testing";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { gateThreadActionHandler } from "../chat/functions";
import { jobsQueueMessages } from "../../test/stubs/cloudflare-workers";
import { admitWorkerRun, claimQueuedRun, createWorker, dispatchToWorker, finishRun, getWorker, listActiveWorkerRuns, listWorkers } from "./functions";
import schema from "../schema";

const OWNER = "user-owner";
const STRANGER = "user-stranger";

const { sessionFrom } = vi.hoisted(() => {
    return {
        sessionFrom: async (context: { auth: { userId?: string | null } }) => {
            const { userId } = context.auth;

            return userId ? { activeOrganization: null, email: `${userId}@example.com`, id: userId, isAdmin: false, name: userId, userId } : null;
        },
    };
});

vi.mock("../lib/crpc-auth-helpers", async (importOriginal) => {
    return {
        ...(await importOriginal<typeof import("../lib/crpc-auth-helpers")>()),
        getSessionUser: sessionFrom,
        getSessionUserForQuery: sessionFrom,
        getSessionUserForQueryLite: sessionFrom,
        getSessionUserWithAnonymous: sessionFrom,
    };
});

vi.mock("../auth", async (importOriginal) => {
    return {
        ...(await importOriginal<typeof import("../auth")>()),
        getAuthUserIdentity: async (context: { auth: { userId?: string | null } }) =>
            context.auth.userId ? { subject: context.auth.userId, userId: context.auth.userId } : null,
    };
});

// `user` is a `.global()` (D1) table the in-memory harness cannot write.
vi.mock("../auth/lib/better-auth-queries", async (importOriginal) => {
    return {
        ...(await importOriginal<typeof import("../auth/lib/better-auth-queries")>()),
        getUser: async (_ctx: unknown, userId: string) => {
            return { _id: userId };
        },
    };
});

type Harness = ReturnType<typeof lunoraTest>;

let harness: Harness;
let leadId: string;

const ARCHIVED = /archived/u;
const BUSY = /still working/u;
const LOCKED = /locked/u;

const as = (userId: string) => harness.withIdentity({ userId } as never);
const run = async <T>(body: (context: any) => Promise<T>): Promise<T> => await harness.run(body);

const newThread = async (userId: string, extra: Record<string, unknown> = {}): Promise<string> =>
    await run(async (context) => await context.db.insert("threads", { status: "active", title: "t", userId, ...extra }));

const runRows = async (): Promise<any[]> => await run(async (context) => await context.db.query("subAgentRuns").collect());

/** A worker with its first run already finished, so the next message is free to start. */
const idleWorker = async (): Promise<string> => {
    const admitted = await run(
        async (context) => await admitWorkerRun(context, { name: "Researcher", parentThreadId: leadId, task: "First", toolCallId: "call-1", userId: OWNER }),
    );

    if ("error" in admitted) {
        throw new Error(admitted.error);
    }

    await run(async (context) => await claimQueuedRun(context, admitted.run._id));
    await run(async (context) => await finishRun(context, admitted.run._id, { kind: "succeeded", result: "done" }));

    return admitted.run.childThreadId!;
};

const message = async (workerId: string, clientId: string, userId = OWNER) =>
    await as(userId).mutation(dispatchToWorker as never, { clientId, message: "Next question", workerId } as never);

beforeEach(async () => {
    jobsQueueMessages.length = 0;
    harness = lunoraTest(schema as never);
    leadId = await newThread(OWNER, { title: "Lead" });
});

afterEach(() => {
    harness.close();
});

describe("dispatchToWorker", () => {
    it("starts exactly one run per message, on the worker's one thread, and enqueues it", async () => {
        const workerId = await idleWorker();
        const receipt = (await message(workerId, "client-1")) as { runId: string; state: string; workerId: string };

        expect(receipt).toMatchObject({ state: "queued", workerId });

        const rows = await runRows();

        expect(rows).toHaveLength(2);
        expect(rows[1]).toMatchObject({
            _id: receipt.runId,
            childThreadId: workerId,
            clientId: "client-1",
            mode: "worker",
            status: "queued",
            task: "Next question",
        });
        expect(jobsQueueMessages.filter((queued) => queued.body.functionPath.includes("runSubAgent"))).toHaveLength(1);
    });

    it("returns the same run for the same clientId, starting and enqueuing nothing more", async () => {
        const workerId = await idleWorker();
        const first = (await message(workerId, "client-1")) as { runId: string };
        const again = (await message(workerId, "client-1")) as { runId: string };

        expect(again.runId).toBe(first.runId);
        expect(await runRows()).toHaveLength(2);
        expect(jobsQueueMessages.filter((queued) => queued.body.functionPath.includes("runSubAgent"))).toHaveLength(1);
    });

    it("refuses an archived worker with a clear error, and starts nothing", async () => {
        const workerId = await idleWorker();

        await run(async (context) => await context.db.patch(workerId, { status: "archived" }));

        await expect(message(workerId, "client-1")).rejects.toMatchObject({ code: "CONFLICT", message: expect.stringMatching(ARCHIVED) });
        expect(await runRows()).toHaveLength(1);
    });

    it("refuses a worker that is still working on an earlier message", async () => {
        const workerId = await idleWorker();

        await message(workerId, "client-1");
        await expect(message(workerId, "client-2")).rejects.toMatchObject({ code: "CONFLICT", message: expect.stringMatching(BUSY) });
    });

    it("answers a stranger as it would a worker that does not exist", async () => {
        const workerId = await idleWorker();

        await expect(message(workerId, "client-1", STRANGER)).rejects.toMatchObject({ code: "NOT_FOUND" });
        await expect(message(await newThread(OWNER), "client-2")).rejects.toMatchObject({ code: "NOT_FOUND" });
        expect(await runRows()).toHaveLength(1);
    });
});

describe("a locked worker", () => {
    it("refuses a message and shows no title", async () => {
        const workerId = await idleWorker();

        await run(async (context) => await context.db.patch(workerId, { lockedAt: Date.now() }));

        await expect(message(workerId, "client-1")).rejects.toMatchObject({ message: expect.stringMatching(LOCKED) });
        expect(await as(OWNER).query(listWorkers as never, { leadThreadId: leadId } as never)).toMatchObject([{ name: "Locked chat" }]);
        expect(await as(OWNER).query(getWorker as never, { workerId } as never)).toMatchObject({ name: "Locked chat" });
        expect(await runRows()).toHaveLength(1);
    });
});

describe("createWorker", () => {
    it("creates the worker with its first run for the lead's owner, and refuses anyone else", async () => {
        const receipt = (await as(OWNER).mutation(
            createWorker as never,
            { clientId: "c-1", leadThreadId: leadId, name: "Writer", task: "Draft it" } as never,
        )) as {
            workerId: string;
        };
        const again = (await as(OWNER).mutation(
            createWorker as never,
            { clientId: "c-1", leadThreadId: leadId, name: "Writer", task: "Draft it" } as never,
        )) as {
            workerId: string;
        };

        expect(again.workerId).toBe(receipt.workerId);
        expect(await runRows()).toHaveLength(1);

        await expect(
            as(STRANGER).mutation(createWorker as never, { clientId: "c-2", leadThreadId: leadId, name: "Writer", task: "Draft it" } as never),
        ).rejects.toThrow();
    });
});

describe("reading workers", () => {
    it("lists the lead's workers with their state, and the caller's live runs", async () => {
        const workerId = await idleWorker();

        expect(await as(OWNER).query(listWorkers as never, { leadThreadId: leadId } as never)).toMatchObject([
            { archived: false, name: "Researcher", state: "idle", workerId },
        ]);
        expect(await as(OWNER).query(listActiveWorkerRuns as never, {} as never)).toStrictEqual([]);

        await message(workerId, "client-1");

        expect(await as(OWNER).query(listWorkers as never, { leadThreadId: leadId } as never)).toMatchObject([{ state: "queued" }]);
        expect(await as(OWNER).query(listActiveWorkerRuns as never, {} as never)).toMatchObject([
            { leadThreadId: leadId, name: "Researcher", status: "queued", workerId },
        ]);
        expect(await as(OWNER).query(getWorker as never, { workerId } as never)).toMatchObject({ leadThreadId: leadId, state: "queued" });
    });

    it("shows a stranger nothing", async () => {
        const workerId = await idleWorker();

        await message(workerId, "client-1");

        expect(await as(STRANGER).query(listWorkers as never, { leadThreadId: leadId } as never)).toStrictEqual([]);
        expect(await as(STRANGER).query(listActiveWorkerRuns as never, {} as never)).toStrictEqual([]);
        expect(await as(STRANGER).query(getWorker as never, { workerId } as never)).toBeNull();
    });
});

describe("the chat entry points", () => {
    const gate = async (threadId: string, level: "read" | "write") =>
        await run(async (context) => await gateThreadActionHandler(context, { level, threadId: threadId as never, userId: OWNER }));

    it("flag a worker's thread at the write gate, which /chat/start, /chat/edit, /chat/media and the public API all pass through", async () => {
        const workerId = await idleWorker();

        expect(await gate(workerId, "write")).toMatchObject({ isWorker: true, outcome: "ok" });
        expect(await gate(workerId, "read")).not.toHaveProperty("isWorker");
    });

    it("leave an ordinary thread, and a plain sub-agent's, alone", async () => {
        expect(await gate(leadId, "write")).toMatchObject({ isWorker: false, outcome: "ok" });

        const child = await newThread(OWNER);

        await run(async (context) => {
            await context.db.insert("subAgentRuns", {
                childThreadId: child,
                createdAt: 1,
                depth: 1,
                parentThreadId: leadId,
                status: "succeeded",
                task: "t",
                updatedAt: 1,
                userId: OWNER,
            });
        });

        expect(await gate(child, "write")).toMatchObject({ isWorker: false });
    });
});
