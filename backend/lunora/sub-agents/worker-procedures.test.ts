/**
 * The person-facing worker procedures, run as a signed-in caller with row-level security on: one
 * message starts one run, a retry with the same `clientId` returns it, an archived worker refuses,
 * and a stranger can neither list nor dispatch.
 */
import { lunoraTest } from "@lunora/testing";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { addMessagesHandler } from "../agent/messages";
import { gateThreadActionHandler } from "../chat/functions";
import { jobsQueueMessages } from "../../test/stubs/cloudflare-workers";
import {
    admitWorkerRun,
    admitSubAgentRun,
    cancelSubAgentRunsForStop,
    claimQueuedRun,
    createWorker,
    dispatchToWorker,
    dispatchWorkerRun,
    finishRun,
    finishRunFromLoop,
    getWorker,
    listActiveWorkerRuns,
    listWorkers,
    messageWorker,
    reapSubAgentRun,
    setWorkerPolicy,
    stopWorker,
} from "./functions";
import { SUB_AGENT_STALE_MS, SUB_WORKER_QUIET_MS } from "./logic";
import { createRatelimit } from "../lib/rate-limiter";
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
const FAN_OUT_CAP = /At most 3/u;
const LOCKED = /locked/u;
const NO_PROGRESS = /no progress/u;

const as = (userId: string) => harness.withIdentity({ userId } as never);
const run = async <T>(body: (context: any) => Promise<T>): Promise<T> => await harness.run(body);

const newThread = async (userId: string, extra: Record<string, unknown> = {}): Promise<string> =>
    await run(async (context) => await context.db.insert("threads", { status: "active", title: "t", userId, ...extra }));

const runRows = async (): Promise<any[]> => await run(async (context) => await context.db.query("subAgentRuns").collect());

const runRow = async (runId: string): Promise<any> => {
    const rows = await runRows();

    return rows.find((row) => row._id === runId);
};

const dailyCounter = async (): Promise<string[]> => {
    const rows = await run(async (context) => await context.db.query("rateLimits").collect());

    return rows.map((row: { key: string }) => decodeURIComponent(row.key)).filter((key: string) => key.includes("chat/dailyText"));
};

/** A worker with its first run already finished, so the next message is free to start. */
const idleWorker = async (toolCallId = "call-1"): Promise<string> => {
    const admitted = await run(
        async (context) => await admitWorkerRun(context, { name: "Researcher", parentThreadId: leadId, task: "First", toolCallId, userId: OWNER }),
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

/** A message the lead sent through its tool: the run is owed a post-back, which a typed one is not. */
const dispatchAsLead = async (workerId: string, toolCallId: string) =>
    await run(async (context) => {
        const dispatched = await dispatchWorkerRun(context, {
            childThreadId: workerId,
            parentThreadId: leadId,
            task: "From the lead",
            toolCallId,
            userId: OWNER,
        });

        if ("error" in dispatched) {
            throw new Error(dispatched.error);
        }

        return dispatched;
    });

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

    it("answers a stranger as it would a worker that does not exist", async () => {
        const workerId = await idleWorker();

        await expect(message(workerId, "client-1", STRANGER)).rejects.toMatchObject({ code: "NOT_FOUND" });
        await expect(message(await newThread(OWNER), "client-2")).rejects.toMatchObject({ code: "NOT_FOUND" });
        expect(await runRows()).toHaveLength(1);
    });
});

describe("a busy worker", () => {
    const startedRuns = () => jobsQueueMessages.filter((queued) => queued.body.functionPath.includes("runSubAgent")).map((queued) => queued.body.args?.runId);
    const claim = async (runId: string) => await run(async (context) => await claimQueuedRun(context, runId as never));
    const finish = async (runId: string, kind: "cancelled" | "succeeded" = "succeeded") =>
        await run(async (context) => await finishRun(context, runId as never, kind === "cancelled" ? { kind } : { kind, result: "done" }));

    it("queues two more messages behind the running one and runs them in order, the next past the lead's cap refused", async () => {
        const workerId = await idleWorker();
        const [a, b, c] = [await message(workerId, "c-a"), await message(workerId, "c-b"), await message(workerId, "c-c")] as { runId: string }[];

        // Only the first found the worker idle; the others wait without a job.
        expect(startedRuns()).toStrictEqual([a!.runId]);
        expect(await claim(a!.runId)).toMatchObject({ _id: a!.runId });

        const d = (await message(workerId, "c-d").catch((error: unknown) => error)) as { code: string; message: string };

        expect(d).toMatchObject({ code: "BAD_REQUEST", message: expect.stringMatching(FAN_OUT_CAP) });

        // A job for a run that is not at the head claims nothing and charges nothing.
        const charged = await dailyCounter();

        expect(await claim(c!.runId)).toBeNull();
        expect(await claim(b!.runId)).toBeNull();
        expect(await dailyCounter()).toStrictEqual(charged);

        await finish(a!.runId);
        expect(startedRuns()).toStrictEqual([a!.runId, b!.runId]);
        expect(await claim(c!.runId)).toBeNull();
        expect(await claim(b!.runId)).toMatchObject({ _id: b!.runId });

        await finish(b!.runId);
        expect(startedRuns()).toStrictEqual([a!.runId, b!.runId, c!.runId]);
    });

    it("never charges a queued run that is cancelled, and starts nothing when it was not the head", async () => {
        const workerId = await idleWorker();
        const [a, b, c] = [await message(workerId, "c-a"), await message(workerId, "c-b"), await message(workerId, "c-c")] as { runId: string }[];

        await claim(a!.runId);

        const charged = await dailyCounter();

        await finish(c!.runId, "cancelled");
        await finish(b!.runId, "cancelled");

        expect(await dailyCounter()).toStrictEqual(charged);
        expect(startedRuns()).toStrictEqual([a!.runId]);
        const rows = await runRows();

        expect(rows.filter((row) => row.status === "cancelled")).toHaveLength(2);

        await finish(a!.runId);
        expect(startedRuns()).toStrictEqual([a!.runId]);
    });

    it("moves the line on when the head is cancelled before it starts", async () => {
        const workerId = await idleWorker();
        const [a, b] = [await message(workerId, "c-a"), await message(workerId, "c-b")] as { runId: string }[];

        await finish(a!.runId, "cancelled");
        expect(startedRuns()).toStrictEqual([a!.runId, b!.runId]);
    });

    it("keeps seeing the running run behind a long run of cancelled messages", async () => {
        const workerId = await idleWorker();
        const a = (await message(workerId, "c-a")) as { runId: string };

        await claim(a.runId);

        // Seeded directly: sending that many messages would hit the dispatch rate limit.
        const [first] = await runRows();

        await run(async (context) => {
            for (let index = 1; index <= 25; index += 1) {
                const { _creationTime, _id, ...fields } = first;

                await context.db.insert("subAgentRuns", {
                    ...fields,
                    createdAt: first.createdAt + index,
                    startedAt: undefined,
                    status: "cancelled",
                    toolCallId: `seed-${String(index)}`,
                });
            }
        });

        const last = (await message(workerId, "c-last")) as { runId: string };

        // The first run is older than the newest 20 rows but still going: nothing starts beside it.
        expect(startedRuns()).toStrictEqual([a.runId]);

        await finish(a.runId);
        expect(startedRuns()).toStrictEqual([a.runId, last.runId]);
    });

    it("keeps seeing a stopped run's unwinding loop behind a long run of cancelled messages", async () => {
        const workerId = await idleWorker();
        const a = (await message(workerId, "c-a")) as { runId: string };

        await claim(a.runId);
        await run(async (context) => await cancelSubAgentRunsForStop(context, workerId, OWNER));

        const [first] = await runRows();

        // Seeded directly: sending that many messages would hit the dispatch rate limit.
        await run(async (context) => {
            for (let index = 1; index <= 25; index += 1) {
                const { _creationTime, _id, ...fields } = first;

                await context.db.insert("subAgentRuns", {
                    ...fields,
                    createdAt: first.createdAt + index,
                    startedAt: undefined,
                    toolCallId: `seed-${String(index)}`,
                });
            }
        });

        const last = (await message(workerId, "c-last")) as { runId: string };

        // The stopped loop is older than the newest 20 rows but has not exited: nothing starts beside it.
        expect(startedRuns()).toStrictEqual([a.runId]);
        expect(last.runId).toBeDefined();
    });

    it("reports a worker whose stopped run is still unwinding as stopping, not archivable", async () => {
        const workerId = await idleWorker();
        const a = (await message(workerId, "c-a")) as { runId: string };

        await claim(a.runId);
        await run(async (context) => await cancelSubAgentRunsForStop(context, workerId, OWNER));

        expect(await as(OWNER).query(getWorker as never, { workerId } as never)).toMatchObject({ activeRunId: null, state: "idle", stopping: true });
    });

    it("shows the running run as the worker's current one, with a Stop meaning that run", async () => {
        const workerId = await idleWorker();
        const [a, b] = [await message(workerId, "c-a"), await message(workerId, "c-b")] as { runId: string }[];

        await claim(a!.runId);

        expect(await as(OWNER).query(getWorker as never, { workerId } as never)).toMatchObject({ activeRunId: a!.runId, state: "running" });
        expect(await run(async (context) => await cancelSubAgentRunsForStop(context, workerId, OWNER))).toBe(1);
        const rows = await runRows();

        expect(rows.find((row) => row._id === a!.runId)).toMatchObject({ status: "cancelled" });
        // The stopped loop is still mid-step and writes into the thread: the next message waits for it.
        expect(startedRuns()).toStrictEqual([a!.runId]);

        // Its loop exits (the late success finds the run already ended), and the line moves on.
        expect(await run(async (context) => await finishRunFromLoop(context, a!.runId as never, { kind: "succeeded", result: "late" }))).toBe(false);
        expect(startedRuns()).toStrictEqual([a!.runId, b!.runId]);
    });

    it("moves the line on past a stopped run whose loop died, when the reaper fires", async () => {
        const workerId = await idleWorker();
        const [a, b] = [await message(workerId, "c-a"), await message(workerId, "c-b")] as { runId: string }[];

        await claim(a!.runId);
        await run(async (context) => await cancelSubAgentRunsForStop(context, workerId, OWNER));
        expect(startedRuns()).toStrictEqual([a!.runId]);

        await run(async (context) => await finishRunFromLoop(context, a!.runId as never, { error: "The sub-agent did not finish in time.", kind: "failed" }));
        expect(startedRuns()).toStrictEqual([a!.runId, b!.runId]);
    });

    it("queues a message sent while a stopped run's loop is still unwinding, and starts it once the loop exits", async () => {
        const workerId = await idleWorker();
        const a = (await message(workerId, "c-a")) as { runId: string };

        await claim(a.runId);
        expect(await run(async (context) => await cancelSubAgentRunsForStop(context, workerId, OWNER))).toBe(1);

        // The stopped loop is mid-step and still writes into the thread: a new message is not first in line.
        const b = (await message(workerId, "c-b")) as { runId: string; state: string };

        expect(b.state).toBe("queued");
        expect(startedRuns()).toStrictEqual([a.runId]);
        expect(await claim(b.runId)).toBeNull();
        expect(await as(OWNER).query(getWorker as never, { workerId } as never)).toMatchObject({ activeRunId: b.runId, state: "queued" });
        // The stopped run takes no slot of the lead's cap: only the queued message counts.
        const rows = await runRows();

        expect(rows.filter((row) => row.status === "queued" || row.status === "running")).toHaveLength(1);

        // The loop exits (its late report finds the run already ended), and the message starts.
        expect(await run(async (context) => await finishRunFromLoop(context, a.runId as never, { kind: "succeeded", result: "late" }))).toBe(false);
        expect(startedRuns()).toStrictEqual([a.runId, b.runId]);
        expect(await claim(b.runId)).toMatchObject({ _id: b.runId });

        // A message sent once the loop is gone finds nothing to wait for but the new head.
        await finish(b.runId);
        const c = (await message(workerId, "c-c")) as { runId: string; state: string };

        expect(startedRuns()).toStrictEqual([a.runId, b.runId, c.runId]);
    });

    it("starts the next message when the head ends, though both were sent in the same millisecond", async () => {
        vi.useFakeTimers({ toFake: ["Date"] });
        vi.setSystemTime(Date.now());

        try {
            const workerId = await idleWorker();
            const [a, b, c] = [await message(workerId, "c-a"), await message(workerId, "c-b"), await message(workerId, "c-c")] as { runId: string }[];
            const rows = await runRows();

            expect(new Set(rows.map((row) => row._creationTime)).size).toBe(1);
            expect(startedRuns()).toStrictEqual([a!.runId]);

            // Cancelled while queued: B was waiting behind it and takes the slot, then C behind B.
            await finish(a!.runId, "cancelled");
            expect(startedRuns()).toStrictEqual([a!.runId, b!.runId]);

            expect(await claim(b!.runId)).toMatchObject({ _id: b!.runId });
            await finish(b!.runId);
            expect(startedRuns()).toStrictEqual([a!.runId, b!.runId, c!.runId]);
        } finally {
            vi.useRealTimers();
        }
    });

    it.each([{ status: "archived" }, { lockedAt: 1 }, { deleted: true }])(
        "lets the whole queue drain as cancelled, uncharged, when the worker is changed meanwhile: %o",
        async (patch) => {
            const workerId = await idleWorker();
            const [a, b, c] = [await message(workerId, "c-a"), await message(workerId, "c-b"), await message(workerId, "c-c")] as { runId: string }[];
            const charged = await dailyCounter();

            await run(async (context) => await context.db.patch(workerId, patch));

            expect(await claim(a!.runId)).toBeNull();
            expect(startedRuns()).toStrictEqual([a!.runId, b!.runId]);
            expect(await claim(b!.runId)).toBeNull();
            expect(await claim(c!.runId)).toBeNull();
            expect(startedRuns()).toStrictEqual([a!.runId, b!.runId, c!.runId]);

            const rows = await runRows();

            expect([a, b, c].map((queued) => rows.find((row) => row._id === queued!.runId).status)).toStrictEqual(["cancelled", "cancelled", "cancelled"]);
            expect(await dailyCounter()).toStrictEqual(charged);
        },
    );

    it("fails each queued run at the claim while the daily limit is spent, the next one taking its turn", async () => {
        const workerId = await idleWorker();
        const [a, b] = [await message(workerId, "c-a"), await message(workerId, "c-b")] as { runId: string }[];

        await run(async (context) => {
            const limiter = createRatelimit("chat/dailyText:free", context.db as never);

            for (let attempt = 0; attempt < 1000; attempt += 1) {
                const { ok } = await limiter.limit(OWNER);

                if (!ok) {
                    break;
                }
            }
        });

        expect(await claim(a!.runId)).toBeNull();
        expect(startedRuns()).toStrictEqual([a!.runId, b!.runId]);
        expect(await claim(b!.runId)).toBeNull();

        const rows = await runRows();

        expect(rows.find((row) => row._id === a!.runId)).toMatchObject({ status: "failed" });
        expect(rows.find((row) => row._id === b!.runId)).toMatchObject({ status: "failed" });
    });

    it("offers no steer: a cloud worker's runner queues", async () => {
        const workerId = await idleWorker();

        expect(await as(OWNER).query(getWorker as never, { workerId } as never)).toMatchObject({ followUp: "queue" });
        expect(await as(OWNER).query(listWorkers as never, { leadThreadId: leadId } as never)).toMatchObject([{ followUp: "queue" }]);
    });
});

describe("reading a busy worker", () => {
    it("lists the running run as current, not a queued one behind it, and the lead's undelivered result", async () => {
        const workerId = await idleWorker();
        const [a] = [await message(workerId, "c-a"), await message(workerId, "c-b")] as { runId: string }[];

        await run(async (context) => await claimQueuedRun(context, a!.runId as never));
        // The first run, which the lead asked for, never reached the lead; the typed ones are not owed.
        const [first] = await runRows();

        await run(async (context) => await context.db.patch(first._id, { postFailed: "The conversation that started this run is gone." }));

        const expected = { activeRunId: a!.runId, postFailed: "The conversation that started this run is gone.", state: "running" };

        expect(await as(OWNER).query(listWorkers as never, { leadThreadId: leadId } as never)).toMatchObject([expected]);
        expect(await as(OWNER).query(getWorker as never, { workerId } as never)).toMatchObject(expected);
    });
});

describe("a locked worker", () => {
    it("refuses a message and shows no title", async () => {
        const workerId = await idleWorker();

        await run(async (context) => await context.db.patch(workerId, { lockedAt: Date.now() }));

        await expect(message(workerId, "client-1")).rejects.toMatchObject({ message: expect.stringMatching(LOCKED) });
        expect(await as(OWNER).query(listWorkers as never, { leadThreadId: leadId } as never)).toMatchObject([{ name: "Locked chat" }]);
        expect(await as(OWNER).query(getWorker as never, { workerId } as never)).toMatchObject({ name: "Locked chat" });

        // Nor its run list: tasks, times and delivery are the chat's content too.
        const view = (await as(OWNER).query(getWorker as never, { workerId } as never)) as { runs: unknown[] };

        expect(view.runs).toEqual([]);
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

describe("stopping a worker", () => {
    const startedRuns = () => jobsQueueMessages.filter((queued) => queued.body.functionPath.includes("runSubAgent")).map((queued) => queued.body.args?.runId);
    const claim = async (runId: string) => await run(async (context) => await claimQueuedRun(context, runId as never));
    const stop = async (workerId: string, scope: "all_queued" | "current", clientId: string, runId?: string, userId = OWNER) =>
        (await as(userId).mutation(stopWorker as never, { clientId, runId, scope, workerId } as never)) as { cancelled: number };
    const statusOf = async () => {
        const rows = await runRows();

        return Object.fromEntries(rows.map((row) => [row._id, row.status]));
    };

    it("ends only the run going with `current`, and the next message waits for the stopped loop", async () => {
        const workerId = await idleWorker();
        const [a, b, c] = [await message(workerId, "c-a"), await message(workerId, "c-b"), await message(workerId, "c-c")] as { runId: string }[];

        await claim(a!.runId);

        expect(await stop(workerId, "current", "stop-1", a!.runId)).toStrictEqual({ cancelled: 1 });
        expect(await statusOf()).toMatchObject({ [a!.runId]: "cancelled", [b!.runId]: "queued", [c!.runId]: "queued" });
        expect(startedRuns()).toStrictEqual([a!.runId]);

        // The loop unwinds, and the line moves on to the head.
        await run(async (context) => await finishRunFromLoop(context, a!.runId as never, { kind: "succeeded", result: "late" }));
        expect(startedRuns()).toStrictEqual([a!.runId, b!.runId]);
    });

    it("ends the queued runs too with `all_queued`, charging none of them and starting none", async () => {
        const workerId = await idleWorker();
        const [a, b, c] = [await message(workerId, "c-a"), await message(workerId, "c-b"), await message(workerId, "c-c")] as { runId: string }[];

        await claim(a!.runId);

        const charged = await dailyCounter();

        expect(await stop(workerId, "all_queued", "stop-1")).toStrictEqual({ cancelled: 3 });
        expect(await statusOf()).toMatchObject({ [a!.runId]: "cancelled", [b!.runId]: "cancelled", [c!.runId]: "cancelled" });
        expect(await dailyCounter()).toStrictEqual(charged);
        expect(startedRuns()).toStrictEqual([a!.runId]);

        await run(async (context) => await finishRunFromLoop(context, a!.runId as never, { kind: "succeeded", result: "late" }));
        expect(startedRuns()).toStrictEqual([a!.runId]);
        expect(await claim(b!.runId)).toBeNull();
    });

    it("is a no-op the second time, with the same id or a new one while the stopped loop unwinds", async () => {
        const workerId = await idleWorker();
        const [a, b] = [await message(workerId, "c-a"), await message(workerId, "c-b")] as { runId: string }[];

        await claim(a!.runId);
        expect(await stop(workerId, "current", "stop-1", a!.runId)).toStrictEqual({ cancelled: 1 });
        expect(await stop(workerId, "current", "stop-1", a!.runId)).toStrictEqual({ cancelled: 0 });
        // A new click on the run already stopped must not reach the message behind it.
        expect(await stop(workerId, "current", "stop-2", a!.runId)).toStrictEqual({ cancelled: 0 });
        const statuses = await statusOf();

        expect(statuses[b!.runId]).toBe("queued");
    });

    it("ends the run a stale view named only while it is live, never the one that took its place", async () => {
        const workerId = await idleWorker();
        const [a, b] = [await message(workerId, "c-a"), await message(workerId, "c-b")] as { runId: string }[];

        await claim(a!.runId);
        // A finishes and the line advances to B; the person's view still shows A when they click Stop.
        await run(async (context) => await finishRunFromLoop(context, a!.runId as never, { kind: "succeeded", result: "done" }));
        expect(startedRuns()).toStrictEqual([a!.runId, b!.runId]);

        expect(await stop(workerId, "current", "stop-1", a!.runId)).toStrictEqual({ cancelled: 0 });
        expect(await statusOf()).toMatchObject({ [a!.runId]: "succeeded", [b!.runId]: "queued" });

        // The same click aimed at B, which the person did see, ends it.
        expect(await stop(workerId, "current", "stop-2", b!.runId)).toStrictEqual({ cancelled: 1 });
    });

    it("needs a run for `current`, and ignores another worker's run", async () => {
        const workerId = await idleWorker();
        const other = await idleWorker("call-2");
        const a = (await message(other, "c-a")) as { runId: string };

        expect(await stop(workerId, "current", "stop-1").catch((error: unknown) => error)).toMatchObject({ code: "BAD_REQUEST" });
        expect(await stop(workerId, "current", "stop-2", a.runId)).toStrictEqual({ cancelled: 0 });
        expect(await statusOf()).toMatchObject({ [a.runId]: "queued" });
    });

    it("ends the sub-agents the stopped run started", async () => {
        const workerId = await idleWorker();
        const a = (await message(workerId, "c-a")) as { runId: string };

        await claim(a.runId);
        const nested = await run(async (context) => {
            const admitted = await admitSubAgentRun(context, { parentThreadId: workerId, task: "Nested", toolCallId: "nested", userId: OWNER });

            if (!("row" in admitted)) {
                throw new Error(admitted.error);
            }

            return await context.db.insert("subAgentRuns", admitted.row);
        });

        expect(await stop(workerId, "current", "stop-1", a.runId)).toStrictEqual({ cancelled: 1 });
        expect(await statusOf()).toMatchObject({ [a.runId]: "cancelled", [nested]: "cancelled" });
    });

    it("shows a stopped run as `stopping` until its loop exits", async () => {
        const workerId = await idleWorker();
        const [a] = [await message(workerId, "c-a"), await message(workerId, "c-b")] as { runId: string }[];

        await claim(a!.runId);
        expect(await as(OWNER).query(getWorker as never, { workerId } as never)).toMatchObject({ stopping: false });

        await stop(workerId, "current", "stop-1", a!.runId);
        expect(await as(OWNER).query(getWorker as never, { workerId } as never)).toMatchObject({ queuedRuns: 1, state: "queued", stopping: true });

        await run(async (context) => await finishRunFromLoop(context, a!.runId as never, { kind: "succeeded", result: "late" }));
        expect(await as(OWNER).query(getWorker as never, { workerId } as never)).toMatchObject({ stopping: false });
    });

    it("shows a stopped run as `stopping` on an otherwise idle worker, so the view can still say so", async () => {
        const workerId = await idleWorker();
        const a = (await message(workerId, "c-a")) as { runId: string };

        await claim(a.runId);
        await stop(workerId, "current", "stop-1", a.runId);

        expect(await as(OWNER).query(getWorker as never, { workerId } as never)).toMatchObject({ queuedRuns: 0, state: "idle", stopping: true });
    });

    it("clears the queue behind a stopped loop with `all_queued`", async () => {
        const workerId = await idleWorker();
        const [a, b] = [await message(workerId, "c-a"), await message(workerId, "c-b")] as { runId: string }[];

        await claim(a!.runId);
        await stop(workerId, "current", "stop-1", a!.runId);

        expect(await stop(workerId, "all_queued", "stop-2")).toStrictEqual({ cancelled: 1 });
        expect(await statusOf()).toMatchObject({ [b!.runId]: "cancelled" });
    });

    it("ends the head of the queue when it is the run named, and nothing for an idle worker's finished one", async () => {
        const idle = await idleWorker();
        const all = await runRows();
        const finished = all.find((row) => row.childThreadId === idle)!._id as string;

        expect(await stop(idle, "current", "stop-1", finished)).toStrictEqual({ cancelled: 0 });

        const a = (await message(idle, "c-a")) as { runId: string };

        expect(await stop(idle, "current", "stop-2", a.runId)).toStrictEqual({ cancelled: 1 });
        const statuses = await statusOf();

        expect(statuses[a.runId]).toBe("cancelled");
    });

    it("answers a stranger as it would a worker that does not exist", async () => {
        const workerId = await idleWorker();
        const error = (await stop(workerId, "current", "stop-1", undefined, STRANGER).catch((error_: unknown) => error_)) as { code: string };

        expect(error).toMatchObject({ code: "NOT_FOUND" });
    });
});

describe("the worker reaper", () => {
    const claim = async (runId: string) => await run(async (context) => await claimQueuedRun(context, runId as never));
    const reapAt = async (runId: string, now: number) => await run(async (context) => await reapSubAgentRun(context, runId as never, now));
    const statusOf = async (runId: string) => {
        const row = await runRow(runId);

        return row?.status;
    };
    const writeStep = async (workerId: string) =>
        await run(
            async (context) =>
                await addMessagesHandler(context, {
                    messages: [{ message: { content: "step", role: "assistant" }, status: "success" }],
                    threadId: workerId as never,
                    userId: OWNER,
                }),
        );

    beforeEach(() => {
        vi.useFakeTimers({ toFake: ["Date"] });
        vi.setSystemTime(1_800_000_000_000);
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    const minutes = (count: number) => count * 60_000;

    it("leaves a run that is still writing past the old fixed deadline, and fails it once it has been quiet for the whole window", async () => {
        const workerId = await idleWorker();
        // A lead-dispatched run: its failure is owed to the lead.
        const run1 = (await dispatchAsLead(workerId, "call-2")) as { runId: string };
        const startedAt = Date.now();

        await claim(run1.runId);

        vi.setSystemTime(startedAt + minutes(60));
        await writeStep(workerId);

        // Past the old deadline measured from the claim, but only 20 quiet minutes.
        const afterOldDeadline = startedAt + SUB_AGENT_STALE_MS + minutes(5);

        await reapAt(run1.runId, afterOldDeadline);
        expect(await statusOf(run1.runId)).toBe("running");

        // Quiet for the whole window since that step.
        await reapAt(run1.runId, startedAt + minutes(60) + SUB_AGENT_STALE_MS);
        expect(await statusOf(run1.runId)).toBe("failed");

        // The lead hears it as an error.
        const posted = await run(
            async (context) =>
                await context.db
                    .query("messages")
                    .withIndex("by_threadId_order_stepOrder", (q: any) => q.eq("threadId", leadId))
                    .collect(),
        );

        expect(JSON.stringify(posted.map((row: any) => row.message.content))).toContain("Sub-agent failed");
        const failedRun = await runRow(run1.runId);

        expect(failedRun?.error).toMatch(NO_PROGRESS);
    });

    it("fails a run that never wrote after the window from its claim", async () => {
        const workerId = await idleWorker();
        const run1 = (await dispatchAsLead(workerId, "call-2")) as { runId: string };
        const startedAt = Date.now();

        await claim(run1.runId);
        await reapAt(run1.runId, startedAt + SUB_AGENT_STALE_MS - 1);
        expect(await statusOf(run1.runId)).toBe("running");
        await reapAt(run1.runId, startedAt + SUB_AGENT_STALE_MS);
        expect(await statusOf(run1.runId)).toBe("failed");
    });

    it("never fails a queued run, however long it has waited", async () => {
        const workerId = await idleWorker();
        const a = (await message(workerId, "c-a")) as { runId: string };
        const b = (await message(workerId, "c-b")) as { runId: string };

        await claim(a.runId);
        await reapAt(b.runId, Date.now() + SUB_AGENT_STALE_MS * 3);
        expect(await statusOf(b.runId)).toBe("queued");
    });

    it("holds the next message while a stopped loop is still writing, and releases it once the loop has been quiet", async () => {
        const workerId = await idleWorker();
        const [a, b] = [await message(workerId, "c-a"), await message(workerId, "c-b")] as { runId: string }[];
        const startedAt = Date.now();

        await claim(a!.runId);
        await run(async (context) => await cancelSubAgentRunsForStop(context, workerId, OWNER));
        vi.setSystemTime(startedAt + minutes(70));
        await writeStep(workerId);

        await reapAt(a!.runId, startedAt + SUB_AGENT_STALE_MS + minutes(1));
        const unwinding = await runRow(a!.runId);

        expect(unwinding?.loopExitedAt).toBeUndefined();
        expect(await claim(b!.runId)).toBeNull();

        await reapAt(a!.runId, startedAt + minutes(70) + SUB_AGENT_STALE_MS);
        const exited = await runRow(a!.runId);

        expect(exited?.loopExitedAt).toBeDefined();
    });

    it("shows when a running worker last wrote and how long it may stay quiet, and nothing for an idle one", async () => {
        const workerId = await idleWorker();

        expect(await as(OWNER).query(getWorker as never, { workerId } as never)).toMatchObject({
            lastActivityAt: null,
            queuedRuns: 0,
            quietAfterMs: SUB_WORKER_QUIET_MS,
        });

        const a = (await message(workerId, "c-a")) as { runId: string };

        await message(workerId, "c-b");
        await claim(a.runId);
        vi.setSystemTime(Date.now() + minutes(5));
        await writeStep(workerId);

        expect(await as(OWNER).query(listWorkers as never, { leadThreadId: leadId } as never)).toMatchObject([{ lastActivityAt: Date.now(), queuedRuns: 1 }]);
    });
});

describe("receipts", () => {
    const claim = async (runId: string) => await run(async (context) => await claimQueuedRun(context, runId as never));
    const finishOk = async (runId: string) => await run(async (context) => await finishRun(context, runId as never, { kind: "succeeded", result: "done" }));
    const asLead = async (workerId: string, toolCallId: string, parentThreadId = leadId) =>
        await run(
            async (context) =>
                (await context.runMutation(messageWorker as never, {
                    dispatchedBy: "lead",
                    message: "Next",
                    parentThreadId,
                    toolCallId,
                    userId: OWNER,
                    workerId,
                })) as {
                    runId: string;
                    state: string;
                    workerId: string;
                },
        );

    it("answers a lead's message with the run's id, its state and the worker, and a redelivery with the same receipt", async () => {
        const workerId = await idleWorker();
        const receipt = await asLead(workerId, "call-next");

        expect(receipt).toStrictEqual({ runId: expect.any(String), state: "queued", workerId });
        expect(await asLead(workerId, "call-next")).toStrictEqual(receipt);
        expect(await runRows()).toHaveLength(2);

        // The same receipt names a run the worker list reads back, with nothing delivered yet.
        const worker = (await as(OWNER).query(getWorker as never, { workerId } as never)) as { runs: { delivery: string; runId: string; state: string }[] };

        expect(worker.runs.find((entry) => entry.runId === receipt.runId)).toMatchObject({ delivery: "none", dispatchedBy: "lead", state: "queued" });

        // A message the user typed shows as theirs.
        const typed = (await message(workerId, "c-typed")) as { runId: string };
        const after = (await as(OWNER).query(getWorker as never, { workerId } as never)) as { runs: { dispatchedBy: string; runId: string }[] };

        expect(after.runs.find((entry) => entry.runId === typed.runId)?.dispatchedBy).toBe("user");
    });

    it("tells each run's delivery apart: posted, given up, and never owed", async () => {
        const workerId = await idleWorker();
        const typed = (await message(workerId, "c-typed")) as { runId: string };

        await claim(typed.runId);
        await finishOk(typed.runId);

        const worker = (await as(OWNER).query(getWorker as never, { workerId } as never)) as { runs: { delivery: string; runId: string }[] };
        const deliveries = Object.fromEntries(worker.runs.map((entry) => [entry.runId, entry.delivery]));
        const [first] = await runRows();

        expect(deliveries[first._id]).toBe("posted");
        expect(deliveries[typed.runId]).toBe("none");

        // A run the lead asked for whose lead is then deleted gives up posting.
        const asked = await asLead(workerId, "call-asked");

        await claim(asked.runId);
        await run(async (context) => await context.db.patch(leadId as never, { deleted: true }));
        await finishOk(asked.runId);

        const after = (await as(OWNER).query(getWorker as never, { workerId } as never)) as { runs: { delivery: string; runId: string }[] };

        expect(after.runs.find((entry) => entry.runId === asked.runId)?.delivery).toBe("failed");
    });

    it("lands one run's result when another run's post has given up for good", async () => {
        const otherLead = await newThread(OWNER, { title: "Other lead" });
        const first = await run(
            async (context) => await admitWorkerRun(context, { name: "A", parentThreadId: leadId, task: "A", toolCallId: "call-a", userId: OWNER }),
        );
        const second = await run(
            async (context) => await admitWorkerRun(context, { name: "B", parentThreadId: otherLead, task: "B", toolCallId: "call-b", userId: OWNER }),
        );

        if ("error" in first || "error" in second) {
            throw new Error("setup refused");
        }

        await claim(first.run._id);
        await claim(second.run._id);
        // A message the user typed waits behind the first run.
        const waiting = (await message(first.run.childThreadId!, "c-waiting")) as { runId: string };

        // The first lead is deleted while both runs are going: its result can never land.
        await run(async (context) => await context.db.patch(leadId as never, { deleted: true }));

        await finishOk(first.run._id);
        await finishOk(second.run._id);

        const [gone, landed] = [await runRow(first.run._id), await runRow(second.run._id)];

        expect(gone).toMatchObject({ postFailed: expect.any(String), status: "succeeded" });
        expect(gone.resultPostedAt).toBeUndefined();
        expect(landed.resultPostedAt).toBeDefined();
        expect(landed.postFailed).toBeUndefined();

        const posted = await run(
            async (context) =>
                await context.db
                    .query("messages")
                    .withIndex("by_threadId_order_stepOrder", (q: any) => q.eq("threadId", otherLead))
                    .collect(),
        );

        expect(posted).toHaveLength(1);
        // The unpostable result did not hold the worker's line: the waiting message started.
        expect(jobsQueueMessages.some((queued) => queued.body.args?.runId === waiting.runId)).toBe(true);
    });
});

describe("setWorkerPolicy", () => {
    const setPolicy = async (userId: string, args: Record<string, unknown> = {}) =>
        await as(userId).mutation(setWorkerPolicy as never, { allowedSources: ["lead", "messenger", "messenger"], leadThreadId: leadId, ...args } as never);

    it("stores the policy for the lead's owner with host dispatch fixed to ask, and dispatch follows it", async () => {
        await setPolicy(OWNER, { maxDispatchesPerHour: 5 });

        const lead = await run(async (context) => await context.db.get(leadId));

        expect(lead.workerPolicy).toStrictEqual({ allowedSources: ["lead", "messenger"], hostDispatch: "ask", maxDispatchesPerHour: 5 });

        const refused = await run(
            async (context) =>
                await admitWorkerRun(context, { dispatchedBy: "trigger", name: "W", parentThreadId: leadId, task: "T", toolCallId: "call-t", userId: OWNER }),
        );

        expect(refused).toMatchObject({ kind: "forbidden" });
    });

    it("answers a stranger as it would a conversation that does not exist, and refuses an hourly cap past the tier limit", async () => {
        expect(await setPolicy(STRANGER).catch((error: unknown) => error)).toMatchObject({ code: "NOT_FOUND" });
        await expect(setPolicy(OWNER, { maxDispatchesPerHour: 1000 })).rejects.toBeDefined();
    });

    it("refuses a locked lead's policy change without its unlock proof", async () => {
        await run(async (context) => await context.db.patch(leadId, { lockedAt: Date.now() }));

        await expect(setPolicy(OWNER, { maxDispatchesPerHour: 5 })).rejects.toMatchObject({ message: expect.stringMatching(LOCKED) });
    });

    it("refuses a fractional hourly cap, which would admit one dispatch more than it says", async () => {
        await expect(setPolicy(OWNER, { maxDispatchesPerHour: 2.5 })).rejects.toBeDefined();
    });
});
