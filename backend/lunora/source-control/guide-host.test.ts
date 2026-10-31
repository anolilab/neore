/**
 * A guide written by a coding agent on the user's computer, against the in-memory harness: the transaction that
 * reserves the guide, starts the session and sends the prompt either happens whole or not at all, and the way the
 * turn ends decides what the guide becomes.
 */
import { lunoraTest } from "@lunora/testing";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { jobsQueueMessages } from "../../test/stubs/cloudflare-workers";

const { sessionFrom } = vi.hoisted(() => {
    return {
        sessionFrom: async (context: { auth: { userId?: string | null } }) =>
            context.auth.userId ? { activeOrganization: null, id: context.auth.userId, isAdmin: false, userId: context.auth.userId } : null,
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

const keyBytes = new Uint8Array(32);

crypto.getRandomValues(keyBytes);
vi.stubEnv("ENCRYPTION_KEY", btoa(String.fromCodePoint(...keyBytes)));

const { default: schema } = await import("../schema");
const devices = await import("../devices/functions");
const { signDevicePayload } = await import("../devices/lib/signing");
const remote = await import("../acp/remote");
const { finishHostTurn } = await import("../acp/lib/finish");
const { beginHostGuide, readHostGuideAnswer } = await import("./guide-host");

type Row = Record<string, any>;

const REPOSITORY = "octo/hello";
const OFFER = { agentKey: "claude", agentLabel: "Claude Code", folderId: "f1", folderLabel: "hello" };
const HEAD = "a".repeat(40);

let harness: ReturnType<typeof lunoraTest>;
let ownerId: string;

const as = (userId: string) => harness.withIdentity({ userId } as never);

const run = async <T>(read: (ctx: any) => Promise<T>): Promise<T> => (await harness.run(read)) as T;

const rows = async (table: string, where: Row = {}): Promise<Row[]> =>
    await run(async (ctx) => {
        const { page } = await ctx.db[table].findMany({ where });

        return page as Row[];
    });

const pairedDevice = async (userId: string, offers: unknown[] = [OFFER]): Promise<string> => {
    const { deviceId, secret } = (await as(userId).mutation(devices.registerDevice as never, { name: "Laptop", platform: "linux" } as never)) as {
        deviceId: string;
        secret: string;
    };
    const payload = JSON.stringify({ acpOffers: offers, deviceId, issuedAt: Date.now() + 1, kind: "manifest", tools: [], v: 1 });

    await as(userId).mutation(
        devices.updateDeviceManifest as never,
        { deviceId, payload, signature: await signDevicePayload(secret, "manifest", payload) } as never,
    );

    return deviceId;
};

const begin = async (deviceId: string, over: Record<string, unknown> = {}): Promise<any> =>
    await run(
        async (ctx) =>
            await ctx.runMutation(beginHostGuide, {
                agentKey: "claude",
                deviceId,
                folderId: "f1",
                headSha: HEAD,
                instructions: "Look at the error handling",
                number: 7,
                plan: "free",
                repository: REPOSITORY,
                text: "Write the guide.",
                userId: ownerId,
                ...over,
            }),
    );

const nothingLeftBehind = async (): Promise<void> => {
    for (const table of ["pullRequestGuides", "threads", "acpSessions", "deviceCalls", "persistentStreams"]) {
        expect(await rows(table), table).toEqual([]);
    }
};

beforeEach(async () => {
    harness = lunoraTest(schema as never);
    jobsQueueMessages.length = 0;
    ownerId = (await harness.run(
        async (ctx: any) =>
            await ctx.db.insert("user", { createdAt: 0, email: `u${String(Math.random())}@example.com`, emailVerified: true, name: "U", updatedAt: 0 }),
    )) as string;
});

afterEach(() => {
    harness.close();
});

describe("beginHostGuide", () => {
    it("reserves the guide, starts the session and sends the prompt in one go", async () => {
        const deviceId = await pairedDevice(ownerId);
        const started = await begin(deviceId);

        expect(started).toMatchObject({ status: "started" });

        const [guide] = await rows("pullRequestGuides");
        const [session] = await rows("acpSessions");

        expect(guide).toMatchObject({ headSha: HEAD, number: 7, repository: REPOSITORY, source: "host", status: "generating", threadId: started.threadId });
        expect(session).toMatchObject({ deviceId, threadId: started.threadId });
        const calls = await rows("deviceCalls");

        expect(calls.map((call) => call.toolName).toSorted((a, b) => a.localeCompare(b))).toEqual(["acp_send", "acp_start"]);
        expect(await rows("persistentStreams")).toHaveLength(1);
    });

    it("refuses a folder that is not offered for that agent, or not this repository, and writes nothing", async () => {
        const deviceId = await pairedDevice(ownerId);

        await expect(begin(deviceId, { folderId: "other" })).resolves.toEqual({ status: "folder_mismatch" });
        await expect(begin(deviceId, { repository: "octo/another" })).resolves.toEqual({ status: "folder_mismatch" });
        await nothingLeftBehind();
    });

    it("does not use another user's computer", async () => {
        const stranger = await run(
            async (ctx) => await ctx.db.insert("user", { createdAt: 0, email: "s@example.com", emailVerified: true, name: "S", updatedAt: 0 }),
        );
        const deviceId = await pairedDevice(stranger as string);

        await expect(begin(deviceId)).resolves.toEqual({ status: "folder_mismatch" });
        await nothingLeftBehind();
    });

    it("rolls the whole start back when the computer cannot take the prompt", async () => {
        const deviceId = await pairedDevice(ownerId);

        await expect(begin(deviceId, { text: "x".repeat(40_000) })).rejects.toThrow("guide_host:too_large");
        await nothingLeftBehind();
    });

    it("runs one guide at a time for a pull request", async () => {
        const deviceId = await pairedDevice(ownerId);

        await begin(deviceId);

        await expect(begin(deviceId)).resolves.toEqual({ status: "running" });
        expect(await rows("pullRequestGuides")).toHaveLength(1);
    });
});

describe("the end of a host guide's turn", () => {
    const startedGuide = async (): Promise<{ guide: Row; stream: Row }> => {
        await begin(await pairedDevice(ownerId));

        const [guide] = await rows("pullRequestGuides");
        const [stream] = await rows("persistentStreams");

        return { guide: guide as Row, stream: stream as Row };
    };

    const endTurn = async (stream: Row, reason: "failed" | "finished" | "interrupted" | "revoked" | "stopped" | "timeout"): Promise<void> => {
        await run(async (ctx) => {
            await finishHostTurn(ctx, stream as never, { reason }, Date.now());
        });
    };

    const statusOf = async (): Promise<Row> => {
        const [guide] = await rows("pullRequestGuides");

        return guide as Row;
    };

    it("queues the finalizer for a turn that finished, and leaves the guide generating until it has run", async () => {
        const { guide, stream } = await startedGuide();

        await endTurn(stream, "finished");

        expect(await statusOf()).toMatchObject({ status: "generating" });
        expect(jobsQueueMessages.map((message) => message.body.functionPath)).toEqual([expect.stringContaining("finalizeHostGuide")]);
        expect(jobsQueueMessages[0]?.body.args).toEqual({ guideId: guide._id, streamId: stream._id, userId: ownerId });
    });

    it.each(["failed", "interrupted", "revoked", "timeout"] as const)("fails the guide when the turn ended as %s", async (reason) => {
        const { stream } = await startedGuide();

        await endTurn(stream, reason);

        expect(await statusOf()).toMatchObject({ failure: "host_error", status: "failed" });
        expect(jobsQueueMessages).toEqual([]);
    });

    it("fails the guide with no answer when the user stopped the turn", async () => {
        const { stream } = await startedGuide();

        await endTurn(stream, "stopped");

        expect(await statusOf()).toMatchObject({ failure: "no_answer", status: "failed" });
    });

    it("leaves an ordinary host turn alone", async () => {
        const deviceId = await pairedDevice(ownerId);
        const { threadId } = (await as(ownerId).mutation(
            remote.startHostSession as never,
            { agentKey: "claude", clientId: "c-1", deviceId, folderId: "f1" } as never,
        )) as {
            threadId: string;
        };

        await as(ownerId).mutation(remote.cancelHostTurn as never, { threadId } as never);

        expect(jobsQueueMessages).toEqual([]);
        expect(await rows("pullRequestGuides")).toEqual([]);
    });
});

describe("readHostGuideAnswer", () => {
    const chunk = async (streamId: string, seq: number, text: string): Promise<void> => {
        await run(async (ctx) => {
            await ctx.db.persistentChunks.insert({ seq, streamId, text });
        });
    };

    it("reads the JSON object the agent answered with, out of the prose around it", async () => {
        await begin(await pairedDevice(ownerId));

        const [guide] = await rows("pullRequestGuides");
        const [stream] = await rows("persistentStreams");

        await chunk(stream!._id, 0, 'Here it is:\n```json\n{"summary":"S","stops":[]}');
        await chunk(stream!._id, 1, "\n```\n");

        const read = await run(async (ctx) => await ctx.runQuery(readHostGuideAnswer, { guideId: guide!._id, streamId: stream!._id, userId: ownerId }));

        expect(read).toMatchObject({ headSha: HEAD, number: 7, repository: REPOSITORY });
        expect(JSON.parse(read.answer)).toEqual({ stops: [], summary: "S" });
    });

    it("answers null for a guide that is not waiting for this stream's turn", async () => {
        await begin(await pairedDevice(ownerId));

        const [guide] = await rows("pullRequestGuides");
        const [stream] = await rows("persistentStreams");
        const read = (userId: string) => run(async (ctx) => await ctx.runQuery(readHostGuideAnswer, { guideId: guide!._id, streamId: stream!._id, userId }));

        await expect(read("someone-else")).resolves.toBeNull();

        await run(async (ctx) => {
            await ctx.db.patch(guide!._id, { status: "ready" });
        });

        await expect(read(ownerId)).resolves.toBeNull();
    });
});
