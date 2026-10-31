/* eslint-disable unicorn/no-await-expression-member */
/**
 * Workers that run on a paired computer's coding agent (plans/agent-orchestrator.md S5), against the in-memory
 * harness: a dispatch becomes the existing `acp_send` device call, the host's `turn_end` finishes the run, a
 * host that does not answer fails it at once, nothing is charged but the dispatch rate limit is, and a host
 * dispatch needs a person (never a headless lead, never an unattended or outside source).
 */
import { lunoraTest } from "@lunora/testing";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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

const keyBytes = new Uint8Array(32);

crypto.getRandomValues(keyBytes);
vi.stubEnv("ENCRYPTION_KEY", btoa(String.fromCodePoint(...keyBytes)));

const { jobsQueueMessages } = await import("../../test/stubs/cloudflare-workers");
const { default: schema } = await import("../schema");
const devices = await import("../devices/functions");
const { signDevicePayload } = await import("../devices/lib/signing");
const { applyHostEvents } = await import("../acp/ingest");
const remote = await import("../acp/remote");
const send = await import("../acp/send");
const functions = await import("./functions");
const { SUB_AGENT_STALE_MS } = await import("./logic");

type Row = Record<string, any>;

let OWNER = "";
const OFFER = { agentKey: "claude", agentLabel: "Claude Code", folderId: "f1", folderLabel: "neore" };

const NOT_APPROVED = /not approved/u;
const NOT_ONLINE = /not online/iu;
const NOT_ANSWERED = /host did not answer/iu;
const NEEDS_A_PERSON = /needs a person/iu;
const SESSION_ENDED = /session has ended/iu;
const REFUSED_THREAD = /alone|own|computer/iu;
const KEEPS_RUNNER = /keeps the runner/iu;
const NO_OUTSIDE_AGENT = /outside agent/iu;

let harness: ReturnType<typeof lunoraTest>;
let leadId: string;
let manifestAt = 0;

const as = (userId: string) => harness.withIdentity({ userId } as never);
const run = async <T>(body: (context: any) => Promise<T>): Promise<T> => (await harness.run(body)) as T;
const table = async (name: string, where: Row = {}): Promise<Row[]> =>
    await run(async (context) => {
        const { page } = await context.db[name].findMany({ where });

        return page as Row[];
    });
const get = async (id: string): Promise<Row> => (await run(async (context) => await context.db.get(id))) as Row;

const newThread = async (extra: Row = {}): Promise<string> =>
    await run(async (context) => await context.db.insert("threads", { status: "active", title: "Lead", userId: OWNER, ...extra }));

interface Device {
    deviceId: string;
    secret: string;
}

const manifest = async (deviceId: string, secret: string, extra: Row) => {
    manifestAt += 1;

    const payload = JSON.stringify({ deviceId, issuedAt: Date.now() + manifestAt, kind: "manifest", tools: [], v: 1, ...extra });

    return { deviceId, payload, signature: await signDevicePayload(secret, "manifest", payload) };
};

/** A paired, online computer that offers the (agent, folder) pair. */
const pairedDevice = async (): Promise<Device> => {
    const { deviceId, secret } = (await as(OWNER).mutation(devices.registerDevice as never, { name: "Laptop", platform: "linux" } as never)) as Device;

    await as(OWNER).mutation(devices.updateDeviceManifest as never, (await manifest(deviceId, secret, { acpOffers: [OFFER] })) as never);

    return { deviceId, secret };
};

const hostWorker = (device: Device, overrides: Row = {}) => {
    return {
        clientId: "make-1",
        host: { agentKey: "claude", deviceId: device.deviceId, folderId: "f1" },
        leadThreadId: leadId,
        name: "Coder",
        task: "Fix the bug",
        ...overrides,
    };
};

const HOST_NO_TOOLS_OR_SKILL = /no tool list or skill/u;
const HOST_OUT_OF_SCOPE = /not allowed in this conversation's project/u;

const createHostWorker = async (device: Device, overrides: Row = {}) =>
    (await as(OWNER).mutation(functions.createWorker as never, hostWorker(device, overrides) as never)) as { runId: string; state: string; workerId: string };

const sessionOf = async (workerId: string): Promise<Row> => ((await table("acpSessions", { threadId: workerId })) as Row[])[0]!;

const sessionOpen = async (device: Device, workerId: string) => {
    const session = await sessionOf(workerId);

    return await run(
        async (context) =>
            await context.runMutation(applyHostEvents, {
                deviceId: device.deviceId,
                events: [{ ...OFFER, kind: "session_open" }],
                sessionId: session.hostSessionId,
            }),
    );
};

const liveStream = async (workerId: string): Promise<Row> =>
    ((await table("persistentStreams", { threadId: workerId })) as Row[]).find((stream) => stream.status === "pending" || stream.status === "streaming")!;

/** The computer posts a turn of the worker's session from its first event to its end. */
const hostTurn = async (device: Device, workerId: string, events: Row[], firstSeq = 0) => {
    const session = await sessionOf(workerId);
    const stream = await liveStream(workerId);

    return await run(
        async (context) =>
            await context.runMutation(applyHostEvents, {
                deviceId: device.deviceId,
                events,
                firstSeq,
                sessionId: session.hostSessionId,
                threadId: workerId,
                turnId: stream.hostTurnId,
            }),
    );
};

const finishTurn = async (device: Device, workerId: string, text = "Fixed it.") =>
    await hostTurn(device, workerId, [
        { kind: "turn_start", text: "x" },
        { kind: "text", text },
        { kind: "turn_end", reason: "finished" },
    ]);

const dispatchFromUser = async (workerId: string, clientId: string, message = "Next question") =>
    (await as(OWNER).mutation(functions.dispatchToWorker as never, { clientId, message, workerId } as never)) as { runId: string; state: string };

const dispatchFromLead = async (workerId: string, toolCallId: string, extra: Row = {}) =>
    await run(
        async (context) =>
            await functions.dispatchWorkerRun(context, {
                childThreadId: workerId,
                parentThreadId: leadId,
                task: "From the lead",
                toolCallId,
                userId: OWNER,
                ...extra,
            }),
    );

const runRow = async (runId: string): Promise<Row> => await get(runId);

const sendCalls = async (): Promise<Row[]> => await table("deviceCalls", { toolName: "acp_send" });

const accountCharges = async (): Promise<string[]> => {
    const rows = await table("rateLimits");

    return rows.map((row) => decodeURIComponent(row.key as string)).filter((key) => key.includes("chat/dailyText"));
};

const runLimitRows = async (): Promise<Row[]> => (await table("rateLimits")).filter((row) => decodeURIComponent(row.key as string).includes("subAgents/run"));

const startLimitRows = async (): Promise<Row[]> => (await table("rateLimits")).filter((row) => decodeURIComponent(row.key as string).includes("hosts/start"));

/** The computer closes the worker's session (its agent process ended). */
const closeSession = async (device: Device, workerId: string) => {
    const session = await sessionOf(workerId);

    return await run(
        async (context) => await context.runMutation(applyHostEvents, { close: true, deviceId: device.deviceId, events: [], sessionId: session.hostSessionId }),
    );
};

const leadMessages = async (): Promise<string[]> => (await table("messages", { threadId: leadId })).map((message) => JSON.stringify(message.message.content));

const makeDeviceOffline = async (device: Device) => await run(async (context) => await context.db.patch(device.deviceId, { lastSeenAt: 0 }));

beforeEach(async () => {
    jobsQueueMessages.length = 0;
    harness = lunoraTest(schema as never);
    // Pairing a computer needs a real account row.
    OWNER = (await run(
        async (context) =>
            await context.db.insert("user", { createdAt: 0, email: `u${String(Math.random())}@example.com`, emailVerified: true, name: "U", updatedAt: 0 }),
    )) as string;
    leadId = await newThread();
});

afterEach(() => {
    vi.useRealTimers();
    harness.close();
});

describe("creating a worker on a computer", () => {
    it("makes a host thread with its session, starts the agent and sends the task to it", async () => {
        const device = await pairedDevice();
        const receipt = await createHostWorker(device);
        const thread = await get(receipt.workerId);
        const session = await sessionOf(receipt.workerId);
        const [first] = await table("subAgentRuns");

        expect(thread).toMatchObject({ runner: "host", userId: OWNER });
        expect(session).toMatchObject({ agentKey: "claude", deviceId: device.deviceId, folderId: "f1", status: "starting" });
        expect(first).toMatchObject({
            childThreadId: receipt.workerId,
            mode: "worker",
            runner: { deviceId: device.deviceId, kind: "host" },
            status: "running",
        });
        expect(receipt.state).toBe("running");
        expect(await table("deviceCalls", { toolName: "acp_start" })).toHaveLength(1);

        const [call] = await sendCalls();

        expect(JSON.parse(call!.envelope as string).input).toMatchObject({ sessionId: session.hostSessionId, text: expect.stringContaining("Fix the bug") });
        expect(first!.hostTurnId).toBe((await liveStream(receipt.workerId)).hostTurnId);
        // A host run is never put on the jobs queue.
        expect(jobsQueueMessages.filter((queued) => queued.body.functionPath.includes("runSubAgent"))).toHaveLength(0);
    });

    it("refuses a tool allowlist or a skill, which a coding agent on a computer would never receive", async () => {
        const device = await pairedDevice();

        await expect(createHostWorker(device, { toolAllowlist: ["webSearch"] })).rejects.toMatchObject({
            message: expect.stringMatching(HOST_NO_TOOLS_OR_SKILL),
        });
        await expect(createHostWorker(device, { skill: "summarise" })).rejects.toMatchObject({ message: expect.stringMatching(HOST_NO_TOOLS_OR_SKILL) });
        expect(await table("subAgentRuns")).toHaveLength(0);
        expect(await table("deviceCalls")).toHaveLength(0);
    });

    it("refuses a computer limited to other projects, creating nothing", async () => {
        const device = await pairedDevice();

        await run(async (context) => {
            const project = await context.db.insert("projects", { createdAt: 0, title: "Other", userId: OWNER });

            await context.db.patch(device.deviceId, { projectIds: [project] });
        });

        await expect(createHostWorker(device)).rejects.toMatchObject({ message: expect.stringMatching(HOST_OUT_OF_SCOPE) });
        expect(await table("subAgentRuns")).toHaveLength(0);
        expect(await table("deviceCalls")).toHaveLength(0);
    });

    it("refuses a pair the computer did not offer, creating nothing", async () => {
        const device = await pairedDevice();

        await expect(createHostWorker(device, { host: { agentKey: "claude", deviceId: device.deviceId, folderId: "other" } })).rejects.toMatchObject({
            message: expect.stringMatching(NOT_APPROVED),
        });
        expect(await table("subAgentRuns")).toHaveLength(0);
        expect(await table("acpSessions")).toHaveLength(0);
        expect(await table("deviceCalls")).toHaveLength(0);
    });

    it("refuses a computer that is not the caller's", async () => {
        const device = await pairedDevice();
        const mine = await newThread({ userId: "user-stranger" });

        await expect(as("user-stranger").mutation(functions.createWorker as never, hostWorker(device, { leadThreadId: mine }) as never)).rejects.toMatchObject({
            message: expect.stringMatching(NOT_APPROVED),
        });
        expect(await table("subAgentRuns")).toHaveLength(0);
    });

    it("refuses an outside agent creating a host worker", async () => {
        const device = await pairedDevice();
        const created = await run(
            async (context) =>
                await functions.dispatchWorkerRun(context, {
                    dispatchedBy: "outside_agent",
                    name: "Coder",
                    parentThreadId: leadId,
                    runner: { agentKey: "claude", deviceId: device.deviceId, folderId: "f1", kind: "host" },
                    task: "Fix it",
                    toolCallId: "call-1",
                    userId: OWNER,
                } as never),
        );

        expect(created).toMatchObject({ error: expect.stringMatching(NO_OUTSIDE_AGENT) });
        expect(await table("subAgentRuns")).toHaveLength(0);
        expect(await table("deviceCalls")).toHaveLength(0);
    });

    it("refuses a computer that is offline when the worker would be created", async () => {
        const device = await pairedDevice();

        await makeDeviceOffline(device);
        await expect(createHostWorker(device)).rejects.toMatchObject({ message: expect.stringMatching(NOT_ONLINE) });
        expect(await table("subAgentRuns")).toHaveLength(0);
        expect(await table("persistentStreams")).toHaveLength(0);
    });
});

describe("the charge", () => {
    it("charges no round for a host run and still spends the dispatch rate limit", async () => {
        const device = await pairedDevice();
        const receipt = await createHostWorker(device);

        expect(await accountCharges()).toHaveLength(0);

        const afterCreate = JSON.stringify(await runLimitRows());

        expect(afterCreate).not.toBe("[]");

        await sessionOpen(device, receipt.workerId);
        await finishTurn(device, receipt.workerId);
        await dispatchFromUser(receipt.workerId, "again");

        expect(await accountCharges()).toHaveLength(0);
        // The second dispatch moved the same counter on.
        expect(JSON.stringify(await runLimitRows())).not.toBe(afterCreate);
        expect(await sendCalls()).toHaveLength(2);
    });

    it("spends the start limit of a host session as well as the dispatch limit when a worker is created", async () => {
        const device = await pairedDevice();

        expect(await startLimitRows()).toHaveLength(0);
        await createHostWorker(device);
        expect(await startLimitRows()).not.toHaveLength(0);
    });

    it("charges a cloud worker's run when it is claimed, which is what the host run skips", async () => {
        const cloud = await run(
            async (context) =>
                await functions.dispatchWorkerRun(context, { name: "Researcher", parentThreadId: leadId, task: "First", toolCallId: "call-c", userId: OWNER }),
        );

        expect(cloud).toMatchObject({ state: "queued" });
        await run(async (context) => await functions.claimQueuedRun(context, (cloud as { runId: string }).runId as never));
        expect(await accountCharges()).toHaveLength(1);
    });
});

describe("the end of a host turn", () => {
    it("finishes the run with the agent's text and posts it to the lead", async () => {
        const device = await pairedDevice();
        const receipt = await dispatchWithLead(device);

        await sessionOpen(device, receipt.workerId);
        await finishTurn(device, receipt.workerId, "Patched the parser.");

        const finished = await runRow(receipt.runId);

        expect(finished).toMatchObject({ status: "succeeded" });
        expect(finished.result).toContain("Patched the parser.");
        expect(finished.resultPostedAt).toBeDefined();
        expect((await leadMessages()).join(",")).toContain("Patched the parser.");
        expect((await get(receipt.workerId)).status).toBe("active");
    });

    it("fails the run when the turn fails, and posts the failure to the lead", async () => {
        const device = await pairedDevice();
        const receipt = await dispatchWithLead(device);

        await sessionOpen(device, receipt.workerId);
        await hostTurn(device, receipt.workerId, [
            { kind: "turn_start", text: "x" },
            { error: "model refused", kind: "turn_end", reason: "failed" },
        ]);

        expect(await runRow(receipt.runId)).toMatchObject({ error: expect.stringContaining("model refused"), status: "failed" });
        expect((await leadMessages()).join(",")).toContain("model refused");
    });

    it("is a no-op for a turn nobody dispatched", async () => {
        const device = await pairedDevice();
        const receipt = await createHostWorker(device);

        await sessionOpen(device, receipt.workerId);
        await finishTurn(device, receipt.workerId);
        // A turn the person starts in the desktop window, with no run behind it.
        const session = await sessionOf(receipt.workerId);

        await run(
            async (context) =>
                await context.runMutation(applyHostEvents, {
                    deviceId: device.deviceId,
                    events: [
                        { kind: "turn_start", text: "local" },
                        { kind: "turn_end", reason: "finished" },
                    ],
                    firstSeq: 0,
                    sessionId: session.hostSessionId,
                    threadId: receipt.workerId,
                    turnId: "local-turn-1",
                }),
        );

        const runs = await table("subAgentRuns");

        expect(runs).toHaveLength(1);
        expect(runs[0]).toMatchObject({ status: "succeeded" });
    });

    it("starts the next queued message when the turn ends", async () => {
        const device = await pairedDevice();
        const receipt = await createHostWorker(device);

        await sessionOpen(device, receipt.workerId);

        const queued = await dispatchFromUser(receipt.workerId, "second");

        expect(queued.state).toBe("queued");
        expect(await sendCalls()).toHaveLength(1);

        await finishTurn(device, receipt.workerId);

        expect(await runRow(queued.runId)).toMatchObject({ status: "running" });
        expect(await sendCalls()).toHaveLength(2);
        expect((await sessionOf(receipt.workerId)).status).toBe("busy");
    });
});

const dispatchWithLead = async (device: Device) => {
    const receipt = await createHostWorker(device, { clientId: "make-lead" });

    // The lead asked for this run: it has a tool call, so its result is posted back.
    await run(async (context) => await context.db.patch(receipt.runId, { toolCallId: "call-lead" }));

    return receipt;
};

describe("a host that does not answer", () => {
    it("fails a dispatch at once when the computer is offline, and tells the lead", async () => {
        const device = await pairedDevice();
        const receipt = await createHostWorker(device);

        await sessionOpen(device, receipt.workerId);
        await finishTurn(device, receipt.workerId);
        await makeDeviceOffline(device);

        const dispatched = await dispatchFromLead(receipt.workerId, "call-2");

        expect(dispatched).toMatchObject({ state: "failed" });

        const failed = await runRow((dispatched as { runId: string }).runId);

        expect(failed).toMatchObject({ error: expect.stringMatching(NOT_ANSWERED), status: "failed" });
        expect(failed.resultPostedAt).toBeDefined();
        expect((await leadMessages()).join(",")).toMatch(NOT_ANSWERED);
        // Nothing queued for a host that may not return.
        expect(await sendCalls()).toHaveLength(1);
    });

    it("fails the run when the claim window closes on a send nobody took", async () => {
        const device = await pairedDevice();
        const receipt = await dispatchWithLead(device);
        const [call] = await sendCalls();

        vi.useFakeTimers({ toFake: ["Date"] });
        vi.setSystemTime(Date.now() + 120_000);
        await run(async (context) => await context.runMutation((await import("../acp/calls")).checkAcpCall, { callId: call!._id }));

        expect(await runRow(receipt.runId)).toMatchObject({ error: expect.stringMatching(NOT_ANSWERED), status: "failed" });
        expect((await leadMessages()).join(",")).toMatch(NOT_ANSWERED);
    });
});

describe("who may reach a host worker", () => {
    it("refuses a headless run, and an unattended or outside source, charging nothing", async () => {
        const device = await pairedDevice();
        const receipt = await createHostWorker(device);

        await sessionOpen(device, receipt.workerId);
        await finishTurn(device, receipt.workerId);

        const before = await runLimitRows();

        for (const [index, extra] of [
            { headless: true },
            { dispatchedBy: "trigger" },
            { dispatchedBy: "messenger" },
            { dispatchedBy: "outside_agent" },
        ].entries()) {
            const dispatched = await dispatchFromLead(receipt.workerId, `call-h${String(index)}`, extra);

            expect(dispatched).toMatchObject({ error: expect.any(String) });
        }

        expect(await table("subAgentRuns")).toHaveLength(1);
        expect(await sendCalls()).toHaveLength(1);
        expect(await runLimitRows()).toEqual(before);
    });

    it("says a person is needed for a headless dispatch", async () => {
        const device = await pairedDevice();
        const receipt = await createHostWorker(device);

        await sessionOpen(device, receipt.workerId);
        await finishTurn(device, receipt.workerId);

        expect(await dispatchFromLead(receipt.workerId, "call-h", { headless: true })).toMatchObject({ error: expect.stringMatching(NEEDS_A_PERSON) });
    });

    it("refuses a different runner for an existing worker", async () => {
        const device = await pairedDevice();
        const receipt = await createHostWorker(device);

        await sessionOpen(device, receipt.workerId);
        await finishTurn(device, receipt.workerId);

        const refused = await dispatchFromLead(receipt.workerId, "call-r", {
            runner: { agentKey: "claude", deviceId: "other-device", folderId: "f1", kind: "host" },
        });

        expect(refused).toMatchObject({ error: expect.any(String) });

        // The same computer is not enough: the agent and the folder are part of the runner.
        for (const [index, pair] of [
            { agentKey: "codex", folderId: "f1" },
            { agentKey: "claude", folderId: "f2" },
        ].entries()) {
            expect(
                await dispatchFromLead(receipt.workerId, `call-r${String(index)}`, { runner: { ...pair, deviceId: device.deviceId, kind: "host" } }),
            ).toMatchObject({
                error: expect.stringMatching(KEEPS_RUNNER),
            });
        }

        expect(await sendCalls()).toHaveLength(1);
    });
});

describe("a worker the lead created on a computer", () => {
    it("takes the lead's next message: the lead's own tool names are not a tool list it was given", async () => {
        const device = await pairedDevice();
        const first = (await run(
            async (context) =>
                await functions.dispatchWorkerRun(context, {
                    leadTools: ["webSearch"],
                    parentThreadId: leadId,
                    runner: { agentKey: "claude", deviceId: device.deviceId, folderId: "f1", kind: "host" },
                    task: "First",
                    toolCallId: "call-new",
                    userId: OWNER,
                }),
        )) as { runId: string };
        const workerId = (await runRow(first.runId)).childThreadId as string;

        await sessionOpen(device, workerId);
        await finishTurn(device, workerId);

        expect(await dispatchFromLead(workerId, "call-next")).not.toHaveProperty("error");
    });
});

describe("activity and waiting on a person", () => {
    it("reads a host run's activity from its host events, and pauses the clock while it waits on a permission", async () => {
        const device = await pairedDevice();
        const receipt = await createHostWorker(device);

        await sessionOpen(device, receipt.workerId);
        await hostTurn(device, receipt.workerId, [
            { kind: "turn_start", text: "x" },
            { kind: "text", text: "working" },
        ]);

        const view = (await as(OWNER).query(functions.getWorker as never, { workerId: receipt.workerId } as never)) as Row;

        expect(view.lastActivityAt).toBeGreaterThan(0);

        // Quiet since before the window, but the agent has just written: not stale.
        const started = await runRow(receipt.runId);

        await run(async (context) => await context.db.patch(receipt.runId, { startedAt: Date.now() - SUB_AGENT_STALE_MS - 1 }));
        await run(async (context) => await functions.reapSubAgentRun(context, receipt.runId as never, Date.now()));
        expect(await runRow(receipt.runId)).toMatchObject({ status: "running" });
        expect(started.status).toBe("running");

        // It then waits on a person: no notice, and not reaped however long it is quiet.
        const stream = await liveStream(receipt.workerId);

        await run(async (context) => await context.db.patch(stream._id, { hostPendingPermissions: ["req-1"] }));

        const waiting = (await as(OWNER).query(functions.getWorker as never, { workerId: receipt.workerId } as never)) as Row;

        expect(waiting.lastActivityAt).toBeNull();
        await run(async (context) => await functions.reapSubAgentRun(context, receipt.runId as never, Date.now() + SUB_AGENT_STALE_MS * 3));
        expect(await runRow(receipt.runId)).toMatchObject({ status: "running" });
    });

    it("fails a host run that has been silent for the whole window", async () => {
        const device = await pairedDevice();
        const receipt = await createHostWorker(device);

        await sessionOpen(device, receipt.workerId);
        await run(async (context) => await functions.reapSubAgentRun(context, receipt.runId as never, Date.now() + SUB_AGENT_STALE_MS + 1000));

        expect(await runRow(receipt.runId)).toMatchObject({ status: "failed" });
        // The turn it left running is ended with it.
        expect((await get((await liveStreamOrEnded(receipt.workerId))._id)).hostState).toBe("ended");
    });
});

const liveStreamOrEnded = async (workerId: string): Promise<Row> => ((await table("persistentStreams", { threadId: workerId })) as Row[])[0]!;

describe("stopping a host run", () => {
    it("stops the turn on the computer and lets the next message go at once", async () => {
        const device = await pairedDevice();
        const receipt = await createHostWorker(device);

        await sessionOpen(device, receipt.workerId);

        const queued = await dispatchFromUser(receipt.workerId, "second");

        await as(OWNER).mutation(
            functions.stopWorker as never,
            { clientId: "stop-1", runId: receipt.runId, scope: "current", workerId: receipt.workerId } as never,
        );

        expect(await runRow(receipt.runId)).toMatchObject({ status: "cancelled" });
        expect((await table("persistentStreams", { threadId: receipt.workerId }))[0]).toMatchObject({ hostState: "ended" });
        expect(await table("deviceCalls", { toolName: "acp_cancel" })).toHaveLength(1);
        // The loop is gone, so the queue is not held for it.
        expect(await runRow(queued.runId)).toMatchObject({ status: "running" });
    });
});

describe("a Stop in the worker's own thread", () => {
    it("leaves the thread running when the stop starts the next queued message", async () => {
        const device = await pairedDevice();
        const receipt = await createHostWorker(device);

        await sessionOpen(device, receipt.workerId);

        const queued = await dispatchFromUser(receipt.workerId, "second");
        const { stopActiveForThread } = await import("../chat/streaming/persistent/library");

        await run(async (context) => await context.runMutation(stopActiveForThread, { threadId: receipt.workerId }));

        expect(await runRow(queued.runId)).toMatchObject({ status: "running" });
        // The next message is live on the computer, so the thread must keep its Stop control.
        expect((await get(receipt.workerId)).status).toBe("running");
    });
});

describe("a worker's thread that is deleted", () => {
    it("ends the run that was waiting on its turn", async () => {
        const device = await pairedDevice();
        const receipt = await createHostWorker(device);

        await sessionOpen(device, receipt.workerId);

        const queued = await dispatchFromUser(receipt.workerId, "second");
        const { endHostThread } = await import("../acp/lib/thread-removed");

        await run(async (context) => await endHostThread(context, await context.db.get(receipt.workerId), Date.now()));

        expect(await runRow(receipt.runId)).toMatchObject({ status: "cancelled" });
        // The message behind it is not started on a thread that is going: no second send, no new stream.
        expect(await runRow(queued.runId)).toMatchObject({ status: "cancelled" });
        expect(await sendCalls()).toHaveLength(1);
        expect(await table("persistentStreams", { threadId: receipt.workerId })).toHaveLength(1);
        expect((await table("persistentStreams", { threadId: receipt.workerId }))[0]).toMatchObject({ hostState: "ended" });
    });
});

describe("the worker's thread", () => {
    it("takes no message through /hosts/send", async () => {
        const device = await pairedDevice();
        const receipt = await createHostWorker(device);

        await sessionOpen(device, receipt.workerId);
        await finishTurn(device, receipt.workerId);

        const result = await run(
            async (context) =>
                await context.runMutation(send.sendToHost, { plan: "free", requestId: "r1", text: "hi", threadId: receipt.workerId, userId: OWNER }),
        );

        expect(result.outcome).toBe("worker_thread");
        expect(remote).toBeDefined();
    });
});

describe("a session that closes with runs behind its turn", () => {
    it("fails the queued run at once and sends nothing more to the closing session", async () => {
        const device = await pairedDevice();
        const receipt = await createHostWorker(device);

        await sessionOpen(device, receipt.workerId);

        const queued = await dispatchFromUser(receipt.workerId, "second");

        expect(queued.state).toBe("queued");
        expect(await sendCalls()).toHaveLength(1);

        await closeSession(device, receipt.workerId);

        expect(await runRow(receipt.runId)).toMatchObject({ status: "failed" });
        expect(await runRow(queued.runId)).toMatchObject({ error: expect.stringMatching(SESSION_ENDED), status: "failed" });
        expect(await sendCalls()).toHaveLength(1);
        expect((await table("persistentStreams", { threadId: receipt.workerId })).filter((stream) => stream.hostState !== "ended")).toHaveLength(0);
        expect((await sessionOf(receipt.workerId)).status).toBe("ended");
    });
});

describe("which conversations may reach a computer", () => {
    const createFrom = async (lead: string, device: Device) =>
        await as(OWNER).mutation(functions.createWorker as never, hostWorker(device, { leadThreadId: lead }) as never);

    it("refuses a group, a shared, a public and a messenger conversation, creating nothing", async () => {
        const device = await pairedDevice();
        const group = await newThread({ groupChat: { mode: "parallel", participants: [] } });
        const shared = await newThread();
        const published = await newThread({ isPublic: true });
        const messenger = await newThread({ externalThreadId: "tg-1" });

        await run(
            async (context) =>
                await context.db.insert("threadAccess", {
                    grantedAt: 0,
                    grantedBy: OWNER,
                    ownerId: OWNER,
                    permission: "read",
                    threadId: shared,
                    userId: "user-guest",
                } as never),
        );

        for (const lead of [group, shared, published, messenger]) {
            await expect(createFrom(lead, device)).rejects.toMatchObject({ message: expect.stringMatching(REFUSED_THREAD) });
        }

        expect(await table("subAgentRuns")).toHaveLength(0);
        expect(await table("acpSessions")).toHaveLength(0);
        expect(await table("deviceCalls")).toHaveLength(0);
    });

    it("lets a conversation the user owns alone create one", async () => {
        const device = await pairedDevice();

        expect(await createFrom(leadId, device)).toMatchObject({ state: "running" });
    });

    it("refuses a message to an existing host worker once the lead is shared", async () => {
        const device = await pairedDevice();
        const receipt = await createHostWorker(device);

        await sessionOpen(device, receipt.workerId);
        await finishTurn(device, receipt.workerId);
        await run(
            async (context) =>
                await context.db.insert("threadAccess", {
                    grantedAt: 0,
                    grantedBy: OWNER,
                    ownerId: OWNER,
                    permission: "read",
                    threadId: leadId,
                    userId: "user-guest",
                } as never),
        );

        expect(await dispatchFromLead(receipt.workerId, "call-shared")).toMatchObject({ error: expect.stringMatching(REFUSED_THREAD) });
        expect(await sendCalls()).toHaveLength(1);
    });
});

describe("a turn that ends from this side with a message waiting behind it", () => {
    /** The signed calls to the computer, in the order they were made. */
    const callOrder = async (): Promise<string[]> =>
        (await table("deviceCalls"))
            .filter((call) => call.toolName === "acp_send" || call.toolName === "acp_cancel")
            .toSorted((a, b) => a._creationTime - b._creationTime)
            .map((call) => call.toolName as string);

    let paired: Device | undefined;
    const deviceOf = async (_workerId: string): Promise<Device> => paired!;

    const runningWithOneBehind = async () => {
        const device = await pairedDevice();

        paired = device;
        const receipt = await createHostWorker(device);

        await sessionOpen(device, receipt.workerId);
        await dispatchFromUser(receipt.workerId, "second");

        return { receipt, stream: await liveStream(receipt.workerId) };
    };

    it("tells the computer to cancel the stopped turn before it sends the next message", async () => {
        const { stream } = await runningWithOneBehind();
        const { stopHostTurn } = await import("../acp/lib/finish");

        await run(async (context) => await stopHostTurn(context, await context.db.get(stream._id), Date.now()));

        expect(await callOrder()).toEqual(["acp_send", "acp_cancel", "acp_send"]);
    });

    it("tells the computer to cancel a timed-out turn before it sends the next message", async () => {
        const { receipt } = await runningWithOneBehind();

        // The computer took the prompt and went quiet: a turn it never acknowledged is withdrawn instead, with no cancel.
        await hostTurn(await deviceOf(receipt.workerId), receipt.workerId, [
            { kind: "turn_start", text: "x" },
            { kind: "text", text: "working" },
        ]);

        const stream = await liveStream(receipt.workerId);
        const { expireHostStream } = await import("../acp/lib/reap");

        await run(async (context) => await expireHostStream(context, await context.db.get(stream._id), Date.now()));

        expect(await callOrder()).toEqual(["acp_send", "acp_cancel", "acp_send"]);
    });
});

describe("a host run that waits while the lead changes", () => {
    it("fails the queued run when the lead was shared in the meantime, sending nothing", async () => {
        const device = await pairedDevice();
        const receipt = await createHostWorker(device);

        await sessionOpen(device, receipt.workerId);

        const queued = await dispatchFromUser(receipt.workerId, "second");

        expect(queued.state).toBe("queued");
        await run(
            async (context) =>
                await context.db.insert("threadAccess", {
                    grantedAt: 0,
                    grantedBy: OWNER,
                    ownerId: OWNER,
                    permission: "read",
                    threadId: leadId,
                    userId: "user-guest",
                } as never),
        );
        await finishTurn(device, receipt.workerId);

        expect(await runRow(queued.runId)).toMatchObject({ error: expect.stringMatching(REFUSED_THREAD), status: "failed" });
        expect(await sendCalls()).toHaveLength(1);
    });
});

describe("a worker that is deleted or loses its prompt", () => {
    it("withdraws a send the computer has not taken when the person presses Stop", async () => {
        const device = await pairedDevice();
        const receipt = await createHostWorker(device);
        const { stopActiveForThread } = await import("../chat/streaming/persistent/library");

        await run(async (context) => await context.runMutation(stopActiveForThread, { threadId: receipt.workerId }));

        const [call] = await sendCalls();

        expect(call).toMatchObject({ status: "expired" });
    });

    it("withdraws the send the computer has not taken, so it cannot run after the delete", async () => {
        const device = await pairedDevice();
        const receipt = await createHostWorker(device);
        const { endHostThread } = await import("../acp/lib/thread-removed");

        await run(async (context) => await endHostThread(context, await context.db.get(receipt.workerId), Date.now()));

        const [call] = await sendCalls();

        expect(call).toMatchObject({ status: "expired" });
    });

    it("reports what the agent wrote even when the prompt message was deleted meanwhile", async () => {
        const device = await pairedDevice();
        const receipt = await createHostWorker(device);

        await sessionOpen(device, receipt.workerId);

        const stream = await liveStream(receipt.workerId);

        await run(async (context) => await context.db.delete(stream.messageId));
        await finishTurn(device, receipt.workerId, "Fixed it anyway.");

        expect(await runRow(receipt.runId)).toMatchObject({ result: expect.stringContaining("Fixed it anyway."), status: "succeeded" });
    });
});
