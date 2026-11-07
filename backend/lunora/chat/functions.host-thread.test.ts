/**
 * A host-run thread's turns are produced on a paired computer, so its messages never go to a cloud model: the
 * summary and follow-up actions, which read the thread and call one, refuse it (`http.host-thread.test.ts` pins
 * the chat entry points).
 */
import { lunoraTest } from "@lunora/testing";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { registeredApi, registerModule } from "../../test/registered-api";

import { enableThreadLock } from "../agent/thread-lock";
import { TITLE_CHARGE_SCOPE, TITLE_DISPATCH_TTL_MS, TITLE_READ_WINDOW, titleDispatchInFlight } from "../agent/thread-title";
import { claimFence } from "../lib/claim-once";
import { MAX_LENGTH } from "../lib/validators";
import schema from "../schema";
import {
    branchThread,
    continueThread,
    generateSummary,
    getFollowupSuggestions,
    autoTitleChargeKey,
    chargeToGiveBackOnLostAnswer,
    firstResultOf,
    runTitleWriteRetry,
    refusedBeforeDispatch,
    releaseTitleCharge,
    giveBackTitleCharge,
    releaseRegenerateClaim,
    titleDispatchGateway,
    titleModelPrompt,
    regenerateThreadTitle,
    titleUsageEvent,
    tryTimes,
} from "./functions";

const OWNER = "user-owner";

const registry = vi.hoisted(() => new Map<string, unknown>());

vi.mock("../_generated/api", async (importOriginal) => registeredApi(await importOriginal(), registry));
vi.mock("../_generated/internal", async (importOriginal) => registeredApi(await importOriginal(), registry));

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

let harness: ReturnType<typeof lunoraTest>;
let threadId: string;

beforeAll(async () => {
    registerModule(registry, "chat_functions", await import("./functions"));
    registerModule(registry, "agent_threads", await import("../agent/threads"));
    registerModule(registry, "lib_claim_once", await import("../lib/claim-once"));
    registerModule(registry, "agent_branches", await import("../agent/branches"));
    registerModule(registry, "agent_messages", await import("../agent/messages"));
    registerModule(registry, "agent_thread_title", await import("../agent/thread-title"));
    registerModule(registry, "agent_thread_lock", await import("../agent/thread-lock"));
}, 30_000);

beforeEach(async () => {
    harness = lunoraTest(schema as never);
    threadId = (await harness.run(
        async (ctx: any) => await ctx.db.insert("threads", { model: "gpt-4o", runner: "host", status: "active", title: "Agent", userId: OWNER }),
    )) as string;
});

afterEach(() => {
    harness.close();
});

/**
 * Appends a message to a thread's tree: a row with no parent is a root; any other row is linked by `parentMessageId`, as a branch stores
 * it. A parent must come before its child in storage order (`order` rises down a branch), so every row takes the next order.
 */
let lastOrder = 0;

const appendMessage = async (thread: string, parent: string | undefined, fields: Record<string, unknown>): Promise<string> => {
    lastOrder += 1;

    const order = lastOrder;

    return (await harness.run(
        async (context: any) =>
            await context.db.insert("messages", {
                order,
                status: "success",
                stepOrder: 0,
                threadId: thread,
                tool: false,
                userId: OWNER,
                ...(parent !== undefined && { parentMessageId: parent }),
                ...fields,
            }),
    )) as string;
};

describe("a host-run thread", () => {
    it("has no summary generated from its messages", async () => {
        await expect(harness.withIdentity({ userId: OWNER }).action(generateSummary as never, { threadId } as never)).rejects.toMatchObject({
            code: "CONFLICT",
        });
    });

    it("gets no regenerated title either: its messages must not reach a cloud model", async () => {
        await expect(harness.withIdentity({ userId: OWNER }).action(regenerateThreadTitle as never, { threadId } as never)).rejects.toMatchObject({
            code: "CONFLICT",
        });
    });

    it("gets no follow-up suggestions, and no error for asking", async () => {
        await expect(harness.withIdentity({ userId: OWNER }).action(getFollowupSuggestions as never, { threadId } as never)).resolves.toEqual({
            suggestions: [],
        });
    });

    it("cannot be forked into a cloud thread", async () => {
        await expect(harness.withIdentity({ userId: OWNER }).action(branchThread as never, { threadId } as never)).rejects.toMatchObject({
            code: "CONFLICT",
        });
    });
});

describe("the last check before a background model call", () => {
    const insertCloud = async (fields: Record<string, unknown>) =>
        (await harness.run(
            async (context: any) => await context.db.insert("threads", { model: "gpt-4o", status: "active", title: "Cloud", userId: OWNER, ...fields }),
        )) as string;

    it("refuses a locked or deleted thread just before the call, and allows an open one", async () => {
        const locked = await insertCloud({ lockedAt: 1000 });
        const deleted = await insertCloud({ deletedAt: 1000 });
        const open = await insertCloud({});

        await expect(harness.run(async (context: any) => await refusedBeforeDispatch(context, locked))).resolves.toBe(true);
        await expect(harness.run(async (context: any) => await refusedBeforeDispatch(context, deleted))).resolves.toBe(true);
        await expect(harness.run(async (context: any) => await refusedBeforeDispatch(context, open))).resolves.toBe(false);
    });
});

describe("the gateway a title's model call is sent through", () => {
    const PASSCODE = "correct horse battery";

    // Locking a chat mints an unlock proof, which needs the signing secret.
    let previousSecret: string | undefined;

    beforeEach(() => {
        previousSecret = process.env.STORAGE_SIGNING_SECRET;
        process.env.STORAGE_SIGNING_SECRET = "test-unlock-secret";
    });

    afterEach(() => {
        if (previousSecret === undefined) {
            delete process.env.STORAGE_SIGNING_SECRET;
        } else {
            process.env.STORAGE_SIGNING_SECRET = previousSecret;
        }
    });

    const insertCloud = async () =>
        (await harness.run(
            async (context: any) => await context.db.insert("threads", { model: "gpt-4o", status: "active", title: "Cloud", userId: OWNER }),
        )) as string;

    /** An action's context for the gateway: each mutation is its own transaction, so a lock attempted during a send runs beside it. */
    const actionContext = () =>
        ({
            log: { event: () => undefined },
            runMutation: async (reference: unknown, args: unknown) => await harness.run(async (context: any) => await context.runMutation(reference, args)),
        }) as never;

    const lock = async (cloud: string) =>
        await harness.withIdentity({ userId: OWNER }).mutation(enableThreadLock as never, { passcode: PASSCODE, threadId: cloud } as never);

    it("makes a lock attempted while a request is being sent wait, and lets it through once the request is answered", async () => {
        const cloud = await insertCloud();
        const sent: string[] = [];
        let lockDuringSend: unknown;

        {
            const gateway = titleDispatchGateway(actionContext(), cloud, async (input) => {
                // The owner locks the chat after the last lock check, while the request is on its way: the lock is refused.
                lockDuringSend = await lock(cloud).catch((error: unknown) => error);
                sent.push(String(input));

                return new Response("{}");
            });

            await gateway.fetch("https://gateway/chat");
            expect(gateway.refused()).toBe(false);
            expect(gateway.timedOut()).toBe(false);
        }

        expect(sent).toEqual(["https://gateway/chat"]);
        expect(lockDuringSend).toMatchObject({ code: "CONFLICT", message: expect.stringContaining("Try again in a moment") });
        await expect(harness.run(async (context: any) => await titleDispatchInFlight(context, cloud as never))).resolves.toBe(false);

        // The request has been answered: the lock goes through now.
        await expect(lock(cloud)).resolves.toMatchObject({ ok: true });
    });

    it("sends no request once the chat is locked, and says it refused", async () => {
        const cloud = await insertCloud();
        const sent: string[] = [];

        await lock(cloud);

        {
            const gateway = titleDispatchGateway(actionContext(), cloud, async (input) => {
                sent.push(String(input));

                return new Response("{}");
            });

            await expect(gateway.fetch("https://gateway/chat")).rejects.toMatchObject({ code: "CONFLICT" });
            expect(gateway.refused()).toBe(true);
        }

        expect(sent).toEqual([]);
    });

    it("sends nothing when the claim's result arrives too late for the claim to still hold, and releases it", async () => {
        const cloud = await insertCloud();
        const sent: string[] = [];

        vi.useFakeTimers({ now: 1_800_000_000_000, toFake: ["Date"] });

        try {
            // The claim commits, but the action resumes only once it may have lapsed: a lock could have committed meanwhile.
            const context = {
                log: { event: () => undefined },
                runMutation: async (reference: unknown, args: unknown) => {
                    const result = await harness.run(async (inner: any) => await inner.runMutation(reference, args));

                    if (typeof result === "number") {
                        vi.setSystemTime(Date.now() + TITLE_DISPATCH_TTL_MS);
                    }

                    return result;
                },
            } as never;
            const gateway = titleDispatchGateway(context, cloud, async (input) => {
                sent.push(String(input));

                return new Response("{}");
            });

            await expect(gateway.fetch("https://gateway/chat")).rejects.toMatchObject({ code: "CONFLICT" });
            expect(gateway.refused()).toBe(true);
        } finally {
            vi.useRealTimers();
        }

        expect(sent).toEqual([]);
        await expect(harness.run(async (context: any) => await titleDispatchInFlight(context, cloud as never))).resolves.toBe(false);
    });

    it("aborts a request still pending at its deadline, before its claim lapses, and releases the claim", async () => {
        const cloud = await insertCloud();
        let signal: AbortSignal | undefined;

        vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });

        try {
            const gateway = titleDispatchGateway(actionContext(), cloud, async (_input, init) => {
                signal = init?.signal ?? undefined;

                // The provider never answers: only the deadline ends the request.
                return await new Promise<Response>((_resolve, reject) => {
                    signal?.addEventListener("abort", () => reject(signal?.reason));
                });
            });
            // Settled as soon as the deadline aborts it, which happens while the clock is advanced below.
            const pending = gateway
                .fetch("https://gateway/chat")
                .then(() => "answered")
                .catch((error: unknown) => error);

            for (let step = 0; step < 50 && signal === undefined; step += 1) {
                await vi.advanceTimersByTimeAsync(1);
            }

            expect(signal?.aborted).toBe(false);

            await vi.advanceTimersByTimeAsync(TITLE_DISPATCH_TTL_MS - 1);

            await expect(pending).resolves.toMatchObject({ code: "TIMEOUT" });
            expect(signal?.aborted).toBe(true);
            // Cut off after it was sent: the run keeps its charge rather than give it back for a second paid call.
            expect(gateway.timedOut()).toBe(true);
            expect(gateway.refused()).toBe(false);
        } finally {
            vi.useRealTimers();
        }

        await expect(harness.run(async (context: any) => await titleDispatchInFlight(context, cloud as never))).resolves.toBe(false);
    });

    it("releases its dispatch when the request fails, so the chat can still be locked", async () => {
        const cloud = await insertCloud();

        {
            const gateway = titleDispatchGateway(actionContext(), cloud, async () => {
                throw new Error("gateway answered 503");
            });

            await expect(gateway.fetch("https://gateway/chat")).rejects.toThrow("503");
            expect(gateway.refused()).toBe(false);
        }

        await expect(lock(cloud)).resolves.toMatchObject({ ok: true });
    });
});

describe("a title answer that could be neither recorded nor written", () => {
    it("gives the run's own charge back, so a retry may ask again; a recorded answer or an earlier try's charge is kept", () => {
        expect(chargeToGiveBackOnLostAnswer(false, 42)).toBe(42);
        expect(chargeToGiveBackOnLostAnswer(true, 42)).toBeUndefined();
        expect(chargeToGiveBackOnLostAnswer(false, undefined)).toBeUndefined();
    });
});

describe("a scheduled write of a recorded title answer", () => {
    const retryContext = (outcome: "fails" | "none" | "written") => {
        const events: Record<string, unknown>[] = [];
        const mutations: Record<string, unknown>[] = [];
        let calls = 0;

        return {
            calls: () => calls,
            context: {
                log: {
                    event: (_name: string, fields: Record<string, unknown>) => {
                        events.push(fields);
                    },
                },
                runMutation: async (_reference: unknown, args: Record<string, unknown>) => {
                    calls += 1;
                    mutations.push(args);

                    if (outcome === "fails") {
                        throw new Error("storage down");
                    }

                    return "key" in args ? null : outcome;
                },
                scheduler: { runAfter: async () => null },
            } as never,
            events,
            mutations,
        };
    };
    const retry = { chargeKey: "thread-r:1", expectedTitleDigest: "digest", threadId: "thread-r" };

    it("makes one write per dispatch and throws a failure, so the scheduler's own retry policy bounds the retries", async () => {
        const { calls, context } = retryContext("fails");

        await expect(runTitleWriteRetry(context, retry)).rejects.toThrow("storage down");
        expect(calls()).toBe(1);
    });

    it("releases the regenerate claim it was handed once the write settles, and keeps it while the write keeps failing", async () => {
        const settled = retryContext("written");
        const failing = retryContext("fails");

        await runTitleWriteRetry(settled.context, { ...retry, regenerateClaimedAt: 7 });
        await expect(runTitleWriteRetry(failing.context, { ...retry, regenerateClaimedAt: 7 })).rejects.toThrow("storage down");

        expect(settled.mutations).toContainEqual({ claimedAt: 7, key: "thread-r", scope: "regenerate-title" });
        expect(failing.mutations.some((args) => "key" in args)).toBe(false);
    });

    it("logs a landed write, and an answer already written or dropped", async () => {
        const written = retryContext("written");
        const none = retryContext("none");

        await runTitleWriteRetry(written.context, retry);
        await runTitleWriteRetry(none.context, retry);

        expect(written.events).toEqual([{ retried: true }]);
        expect(none.events).toEqual([{ retried: true, skipped: "none-on-retry" }]);
    });
});

describe("the charge for a title's model call", () => {
    /** Takes a title charge the way `admitTitleRun` does once its checks pass. */
    const charge = async (key: string) =>
        (await harness.run(async (context: any) => await claimFence(context, TITLE_CHARGE_SCOPE, key, { ttlMs: 60_000, userId: OWNER }))) as number | null;

    it("gives each automatic title job its own key, and a retry of a job the same one", () => {
        expect(autoTitleChargeKey("thread-z", "job-a")).not.toBe(autoTitleChargeKey("thread-z", "job-b"));
        expect(autoTitleChargeKey("thread-z", "job-a")).toBe(autoTitleChargeKey("thread-z", "job-a"));
    });

    it("gives a charge back when its call threw before answering, so a retry may ask, and a stale give-back takes nothing", async () => {
        // Fake time, so the charges below cannot share a timestamp and the fence means what it says.
        vi.useFakeTimers({ now: 1_800_000_000_000, toFake: ["Date"] });

        try {
            const key = "thread-y:run-2";
            const first = (await charge(key)) as number;

            vi.setSystemTime(1_800_000_001_000);
            await harness.run(async (context: any) => await releaseTitleCharge(context, key, first));

            vi.setSystemTime(1_800_000_002_000);
            const retried = (await charge(key)) as number;

            expect(retried).toBeGreaterThan(first);

            // The first call's fence is stale: giving it back again does not drop the retried run's charge.
            await harness.run(async (context: any) => await releaseTitleCharge(context, key, first));
            await expect(charge(key)).resolves.toBeNull();
        } finally {
            vi.useRealTimers();
        }
    });
});

describe("writing a title after its model answered", () => {
    it("retries a transient write failure and answers the write's result", async () => {
        let tries = 0;

        await expect(
            firstResultOf(3, async () => {
                tries += 1;

                if (tries < 3) {
                    throw new Error("transient");
                }

                return true;
            }),
        ).resolves.toBe(true);
        expect(tries).toBe(3);
    });

    it("throws the last error once every try failed, so the run's retry resumes from the recorded answer", async () => {
        let tries = 0;
        const lastError = new Error("storage down");

        await expect(
            firstResultOf(3, async () => {
                tries += 1;

                throw tries === 3 ? lastError : new Error("transient");
            }),
        ).rejects.toBe(lastError);
        expect(tries).toBe(3);
    });
});

describe("the retries of a release", () => {
    it("retries a release up to the limit, and says whether it landed", async () => {
        let transient = 0;

        await expect(
            tryTimes(3, async () => {
                transient += 1;

                if (transient < 3) {
                    throw new Error("transient");
                }
            }),
        ).resolves.toBe(true);
        expect(transient).toBe(3);

        let down = 0;

        await expect(
            tryTimes(3, async () => {
                down += 1;

                throw new Error("down");
            }),
        ).resolves.toBe(false);
        expect(down).toBe(3);
    });
});

describe("continueThread", () => {
    it("refuses a prompt that is empty once the hidden characters are gone, before it touches the thread", async () => {
        await expect(
            harness.withIdentity({ userId: OWNER }).action(continueThread as never, { model: "gpt-4o", prompt: "\u{E0041}\u{202E}", threadId } as never),
        ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    });
});

describe("regenerating the title of a cloud thread", () => {
    const GRANTEE = "user-grantee";

    const insertThread = async (fields: Record<string, unknown> = {}) =>
        (await harness.run(
            async (context: any) => await context.db.insert("threads", { model: "gpt-4o", status: "active", title: "Shared", userId: OWNER, ...fields }),
        )) as string;

    /** A cloud thread whose first message is a user prompt, so there is a prompt to title it from. */
    const cloudThread = async (fields: Record<string, unknown> = {}) => {
        const created = await insertThread(fields);

        await harness.run(async (context: any) => {
            await context.db.insert("messages", {
                message: { content: "Plan a trip to Lisbon", role: "user" },
                order: 0,
                status: "success",
                stepOrder: 0,
                threadId: created,
                tool: false,
                userId: OWNER,
            });
        });

        return created;
    };

    /** The thread ids that hold a regenerate claim. */
    const regenerateClaimKeys = async (): Promise<string[]> => {
        const claims = (await harness.run(async (context: any) => await context.db.query("idempotencyClaims").collect())) as {
            key: string;
            scope: string;
        }[];

        return claims.filter((claim) => claim.scope === "regenerate-title").map((claim) => claim.key);
    };

    const grant = async (grantedThreadId: string, permission: "read" | "write") => {
        await harness.run(async (context: any) => {
            await context.db.insert("threadAccess", { grantedAt: 0, grantedBy: OWNER, permission, threadId: grantedThreadId, userId: GRANTEE });
        });
    };

    it("accepts the owner's request", async () => {
        const cloud = await cloudThread();

        await expect(harness.withIdentity({ userId: OWNER }).action(regenerateThreadTitle as never, { threadId: cloud } as never)).resolves.toEqual({
            success: true,
        });
    });

    it("refuses a chat with no user prompt to title it from, and schedules nothing", async () => {
        const empty = await insertThread();

        await expect(harness.withIdentity({ userId: OWNER }).action(regenerateThreadTitle as never, { threadId: empty } as never)).rejects.toMatchObject({
            code: "CONFLICT",
        });
        expect(await regenerateClaimKeys()).not.toContain(empty);
    });

    it("refuses a request made while one is in flight, and holds one claim", async () => {
        const cloud = await cloudThread();
        const owner = harness.withIdentity({ userId: OWNER });

        await expect(owner.action(regenerateThreadTitle as never, { threadId: cloud } as never)).resolves.toEqual({ success: true });
        await expect(owner.action(regenerateThreadTitle as never, { threadId: cloud } as never)).rejects.toMatchObject({ code: "CONFLICT" });

        const keys = await regenerateClaimKeys();

        expect(keys.filter((key) => key === cloud)).toHaveLength(1);
    });

    it("titles a chat whose stored leaf is gone from the path the thread shows, not refused as having no prompt", async () => {
        const cloud = await cloudThread();

        await harness.run(async (context: any) => {
            const gone = await context.db.insert("messages", {
                message: { content: "A prompt on an abandoned branch", role: "user" },
                order: 1,
                status: "success",
                stepOrder: 0,
                threadId: cloud,
                tool: false,
                userId: OWNER,
            });

            await context.db.delete("messages", gone);
            await context.db.patch("threads", cloud, { activeLeafMessageId: gone });
        });

        await expect(harness.withIdentity({ userId: OWNER }).action(regenerateThreadTitle as never, { threadId: cloud } as never)).resolves.toEqual({
            success: true,
        });
        expect(await regenerateClaimKeys()).toContain(cloud);
    });

    it("refuses a duplicate click at the claim, before it reads the prompt", async () => {
        const cloud = await cloudThread();
        const owner = harness.withIdentity({ userId: OWNER });

        await owner.action(regenerateThreadTitle as never, { threadId: cloud } as never);

        // The prompt is gone, so a read would find none: only the claim can explain the refusal.
        await harness.run(async (context: any) => {
            const rows = await context.db.query("messages").collect();

            for (const row of rows) {
                if (row.threadId === cloud) {
                    await context.db.delete("messages", row._id);
                }
            }
        });

        await expect(owner.action(regenerateThreadTitle as never, { threadId: cloud } as never)).rejects.toMatchObject({
            message: expect.stringContaining("already being generated"),
        });
    });

    it("titles a long branched chat from a prompt past the first page of its path", async () => {
        const cloud = await insertThread({});
        let parent: string | undefined;

        for (let index = 0; index < 520; index += 1) {
            parent = await appendMessage(cloud, parent, { message: { content: `Reply ${index}`, role: "assistant" } });
        }

        const prompt = await appendMessage(cloud, parent, { message: { content: "Plan a trip to Lisbon", role: "user" } });
        const reply = await appendMessage(cloud, prompt, { message: { content: "Sure", role: "assistant" } });

        await harness.run(async (context: any) => await context.db.patch("threads", cloud, { activeLeafMessageId: reply }));

        await expect(harness.withIdentity({ userId: OWNER }).action(regenerateThreadTitle as never, { threadId: cloud } as never)).resolves.toEqual({
            success: true,
        });
        // 520 rows written one by one: the explicit timeout is the repo's pattern for such a test, so a loaded runner does not fail it.
    }, 30_000);

    it("retitles a chat whose stored title is longer than the title limit", async () => {
        const cloud = await cloudThread({ title: "x".repeat(MAX_LENGTH.long + 1) });

        await expect(harness.withIdentity({ userId: OWNER }).action(regenerateThreadTitle as never, { threadId: cloud } as never)).resolves.toEqual({
            success: true,
        });
    });

    it("accepts a branched chat longer than the read window, titled from its recent prompt", async () => {
        const cloud = await insertThread({});
        let parent = await appendMessage(cloud, undefined, { message: { content: "An old subject", role: "user" } });

        for (let index = 0; index < TITLE_READ_WINDOW + 20; index += 1) {
            parent = await appendMessage(cloud, parent, { message: { content: `Reply ${index}`, role: "assistant" } });
        }

        const recent = await appendMessage(cloud, parent, { message: { content: "The subject now", role: "user" } });

        await harness.run(async (context: any) => await context.db.patch("threads", cloud, { activeLeafMessageId: recent }));

        await expect(harness.withIdentity({ userId: OWNER }).action(regenerateThreadTitle as never, { threadId: cloud } as never)).resolves.toEqual({
            success: true,
        });
    }, 60_000);

    it("records a title call's tokens and model whether or not the title was written", () => {
        expect(titleUsageEvent("model-a", { inputTokens: 5, outputTokens: 2 })).toStrictEqual({ inputTokens: 5, model: "model-a", outputTokens: 2 });
        expect(titleUsageEvent("model-a", { inputTokens: 5, outputTokens: 2 }, "changed-before-write")).toStrictEqual({
            inputTokens: 5,
            model: "model-a",
            outputTokens: 2,
            skipped: "changed-before-write",
        });
        // A run that wrote an earlier try's recorded answer made no call: it carries no tokens, and says it resumed.
        expect(titleUsageEvent("model-a", undefined)).toStrictEqual({ inputTokens: undefined, model: "model-a", outputTokens: undefined, resumed: true });
    });

    it("titles from the path the thread shows when a writer left the stored leaf behind new rows", async () => {
        const cloud = await insertThread({});
        const reply = await appendMessage(cloud, undefined, { message: { content: "Hello", role: "assistant" } });
        const prompt = await appendMessage(cloud, reply, { message: { content: "Plan a trip", role: "user" } });

        await appendMessage(cloud, prompt, { message: { content: "Sure", role: "assistant" } });

        // The stored leaf is the first reply; the thread shows the path that goes on from it, through the prompt.
        await harness.run(async (context: any) => await context.db.patch("threads", cloud, { activeLeafMessageId: reply }));

        await expect(harness.withIdentity({ userId: OWNER }).action(regenerateThreadTitle as never, { threadId: cloud } as never)).resolves.toEqual({
            success: true,
        });
    });

    it("does not coalesce requests for different threads", async () => {
        const first = await cloudThread();
        const second = await cloudThread();
        const owner = harness.withIdentity({ userId: OWNER });

        await owner.action(regenerateThreadTitle as never, { threadId: first } as never);
        await owner.action(regenerateThreadTitle as never, { threadId: second } as never);

        expect(await regenerateClaimKeys()).toEqual(expect.arrayContaining([first, second]));
    });

    it("refuses a locked chat, whose title is its content", async () => {
        const locked = await cloudThread({ lockedAt: 1000 });

        await expect(harness.withIdentity({ userId: OWNER }).action(regenerateThreadTitle as never, { threadId: locked } as never)).rejects.toMatchObject({
            code: "FORBIDDEN",
        });
    });

    it("refuses a grantee who may only read the thread", async () => {
        const cloud = await cloudThread();

        await grant(cloud, "read");

        await expect(harness.withIdentity({ userId: GRANTEE }).action(regenerateThreadTitle as never, { threadId: cloud } as never)).rejects.toThrow();
    });

    it("refuses a grantee with write access: a regenerate is admin-only, as a rename is", async () => {
        const cloud = await cloudThread();

        await grant(cloud, "write");

        await expect(harness.withIdentity({ userId: GRANTEE }).action(regenerateThreadTitle as never, { threadId: cloud } as never)).rejects.toThrow();
    });
});

describe("sending a title's prompt, and the errors around its give-back", () => {
    /** A context whose release fails `failures` times (all of them, when `failures` is Infinity), recording the events it logs. */
    const releasingContext = (failures: number) => {
        const events: { fields: Record<string, unknown>; name: string }[] = [];
        let calls = 0;

        return {
            calls: () => calls,
            context: {
                log: {
                    event: (name: string, fields: Record<string, unknown>) => {
                        events.push({ fields, name });
                    },
                },
                runMutation: async () => {
                    calls += 1;

                    if (calls <= failures) {
                        throw new Error("release failed");
                    }

                    return null;
                },
                scheduler: {
                    runAfter: async () => null,
                },
            } as never,
            events,
        };
    };

    it("sends a title model the prompt cut at the title's limit, not the whole of a long prompt", () => {
        const prompt = titleModelPrompt("Instructions.", "a".repeat(100_000));

        expect(prompt.length).toBeLessThan(2500);
        expect(prompt).toContain("a".repeat(2000));
        expect(prompt).not.toContain("a".repeat(2001));
    });

    it("logs a charge that could not be given back after a model error, and does not throw", async () => {
        const { context, events } = releasingContext(Infinity);

        await expect(giveBackTitleCharge(context as never, "thread-q:run", 1)).resolves.toBeUndefined();
        expect(events).toEqual([expect.objectContaining({ fields: { skipped: "charge-release-failed" }, name: "chat.thread_title" })]);
    });

    it("retries a charge give-back that fails once, without logging it", async () => {
        const { calls, context, events } = releasingContext(1);

        await giveBackTitleCharge(context as never, "thread-q:run-2", 1);

        expect(calls()).toBe(2);
        expect(events).toEqual([]);
    });

    it("schedules a later release when the immediate ones never land, sooner than the claim's TTL", async () => {
        const scheduled: { args: unknown; delay: number }[] = [];
        const events: { fields: Record<string, unknown>; name: string }[] = [];
        const context = {
            log: {
                event: (name: string, fields: Record<string, unknown>) => {
                    events.push({ fields, name });
                },
            },
            runMutation: async () => {
                throw new Error("storage down");
            },
            scheduler: {
                runAfter: async (delay: number, _reference: unknown, args: unknown) => {
                    scheduled.push({ args, delay });
                },
            },
        };

        await releaseRegenerateClaim(context as never, "thread-s", 9);

        expect(scheduled).toEqual([{ args: { claimedAt: 9, key: "thread-s", scope: "regenerate-title" }, delay: expect.any(Number) }]);
        expect(scheduled[0]!.delay).toBeLessThan(15 * 60 * 1000);
        expect(events).toEqual([expect.objectContaining({ fields: { skipped: "release-retry-scheduled" } })]);
    });

    it("logs a release that cannot be scheduled either, and does not throw", async () => {
        const events: { fields: Record<string, unknown>; name: string }[] = [];
        const context = {
            log: {
                event: (name: string, fields: Record<string, unknown>) => {
                    events.push({ fields, name });
                },
            },
            runMutation: async () => {
                throw new Error("storage down");
            },
            scheduler: {
                runAfter: async () => {
                    throw new Error("scheduler down");
                },
            },
        };

        await expect(releaseRegenerateClaim(context as never, "thread-t", 9)).resolves.toBeUndefined();
        expect(events).toEqual([expect.objectContaining({ fields: { skipped: "release-failed" } })]);
    });

    it("retries a regenerate claim's release, and logs one that never lands without throwing", async () => {
        const failing = releasingContext(Infinity);

        await expect(releaseRegenerateClaim(failing.context as never, "thread-r", 5)).resolves.toBeUndefined();
        expect(failing.calls()).toBe(3);
        expect(failing.events).toEqual([expect.objectContaining({ fields: { skipped: "release-retry-scheduled" }, name: "chat.regenerate_title" })]);

        const once = releasingContext(1);

        await releaseRegenerateClaim(once.context as never, "thread-r", 5);
        expect(once.calls()).toBe(2);
        expect(once.events).toEqual([]);
    });
});
