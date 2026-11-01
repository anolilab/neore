/**
 * The guide's actions through the real procedures and tables, with the host, the queue, the quota and the model faked:
 * what `generateGuide` charges and when, how `runCloudGuide` and `finalizeHostGuide` map each way a run can end, and
 * that a refused send or quota leaves no row spinning.
 */
import { lunoraTest } from "@lunora/testing";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { registeredApi, registerModule } from "../../test/registered-api";
import schema from "../schema";
import { generateGuide } from "./guide-functions";
import { finalizeHostGuide } from "./guide-host";
import { runCloudGuide } from "./guide-job";

const { charge, enqueue, generateObject, hostRead, registry, sessionFrom, users } = vi.hoisted(() => {
    return {
        charge: vi.fn(),
        enqueue: vi.fn(),
        generateObject: vi.fn(),
        hostRead: vi.fn(),
        registry: new Map<string, unknown>(),
        sessionFrom: async (context: { auth: { userId?: string | null } }) =>
            context.auth.userId
                ? { activeOrganization: null, id: context.auth.userId, isAdmin: false, plan: null, role: null, userId: context.auth.userId }
                : null,
        users: new Map<string, { isAnonymous?: boolean }>(),
    };
});

vi.mock("../_generated/api", async (importOriginal) => registeredApi(await importOriginal(), registry));
vi.mock("../_generated/internal", async (importOriginal) => registeredApi(await importOriginal(), registry));

vi.mock("ai", async (importOriginal) => {
    return { ...(await importOriginal<typeof import("ai")>()), generateObject };
});

vi.mock("../lib/utility-model", async (importOriginal) => {
    return {
        ...(await importOriginal<typeof import("../lib/utility-model")>()),
        getUtilityModel: async () => {
            return {};
        },
    };
});

vi.mock("../connectors/lib/github-token", () => {
    return {
        resolveGithubToken: async () => {
            return { accessToken: "token" };
        },
    };
});

vi.mock("./read-host", async (importOriginal) => {
    return { ...(await importOriginal<typeof import("./read-host")>()), readFromHost: hostRead };
});

vi.mock("../lib/job-queue", async (importOriginal) => {
    return { ...(await importOriginal<typeof import("../lib/job-queue")>()), enqueueJob: enqueue };
});

vi.mock("../chat/lib/daily-limit", async (importOriginal) => {
    return { ...(await importOriginal<typeof import("../chat/lib/daily-limit")>()), chargeDailyLimit: charge };
});

vi.mock("../lib/crpc-auth-helpers", async (importOriginal) => {
    return {
        ...(await importOriginal<typeof import("../lib/crpc-auth-helpers")>()),
        getSessionUser: sessionFrom,
        getSessionUserForQuery: sessionFrom,
        getSessionUserForQueryLite: sessionFrom,
    };
});

// The per-hour bucket is not under test.
vi.mock("../lib/rate-limiter", async (importOriginal) => {
    return {
        ...(await importOriginal<typeof import("../lib/rate-limiter")>()),
        rateLimitGuard: async () => undefined,
    };
});

// `user` is a `.global()` (D1) table the in-memory harness cannot write.
vi.mock("../auth/lib/better-auth-queries", async (importOriginal) => {
    return {
        ...(await importOriginal<typeof import("../auth/lib/better-auth-queries")>()),
        getUser: async (_ctx: unknown, userId: string) => {
            const user = users.get(userId);

            return user ? { _id: userId, ...user } : null;
        },
    };
});

const MEMBER = "member-1";
const GUEST = "guest-1";
const PULL = { number: 7, repository: "octo/hello" };
const HEAD = "a".repeat(40);
const MOVED = "b".repeat(40);
const PATCH = "@@ -1,2 +1,3 @@\n a\n+b\n c";

type Row = Record<string, any>;

let harness: ReturnType<typeof lunoraTest>;

const run = async <T>(read: (ctx: any) => Promise<T>): Promise<T> => (await harness.run(read)) as T;

const guides = async (): Promise<Row[]> =>
    await run(async (ctx) => {
        const { page } = await ctx.db.pullRequestGuides.findMany({ where: {} });

        return page as Row[];
    });

const generate = async (userId: string, instructions = ""): Promise<any> =>
    await harness.withIdentity({ userId } as never).action(generateGuide as never, { ...PULL, instructions } as never);

/** What the host read answers: the pull request as `readPullRequestForGuide` returns it. */
const pullRequest = (headSha = HEAD) => {
    return {
        baseBranch: "main",
        body: "Adds a thing.",
        commits: [{ message: "add" }],
        files: [{ additions: 1, deletions: 0, patch: PATCH, patchState: "full", path: "src/a.ts", previousPath: null, status: "modified" }],
        headBranch: "feature",
        headSha,
        leftOut: 0,
        number: PULL.number,
        repository: PULL.repository,
        status: "ok" as const,
        threads: [],
        title: "Add a thing",
    };
};

const ANSWER = {
    stops: [{ explanation: "Read this first", files: [{ path: "src/a.ts", ranges: [{ end: 2, side: "new", start: 2 }] }], role: "core", title: "Core" }],
    summary: "Adds a thing.",
};

/** A guide the way `generateGuide` leaves it, for the job to pick up. */
const reserved = async (over: Row = {}): Promise<string> =>
    await run(
        async (ctx) =>
            await ctx.db.insert("pullRequestGuides", {
                createdAt: Date.now(),
                generatedAt: 0,
                headSha: HEAD,
                hostOrigin: "https://github.com",
                instructions: "",
                jobId: "job-1",
                leftOut: 0,
                ...PULL,
                proposals: [],
                source: "cloud",
                status: "generating",
                stops: [],
                summary: "",
                updatedAt: Date.now(),
                userId: MEMBER,
                ...over,
            }),
    );

beforeAll(async () => {
    registerModule(registry, "auth_functions", await import("../auth/functions"));
    registerModule(registry, "source_control_guide_internal", await import("./guide-internal"));
    registerModule(registry, "source_control_guide_host", await import("./guide-host"));
});

beforeEach(() => {
    harness = lunoraTest(schema as never);
    users.set(MEMBER, {});
    users.set(GUEST, { isAnonymous: true });
    hostRead.mockResolvedValue({ headSha: HEAD, status: "ok" });
    enqueue.mockResolvedValue(undefined);
    charge.mockResolvedValue({ ok: true });
});

afterEach(() => {
    harness.close();
    users.clear();

    for (const mock of [charge, enqueue, generateObject, hostRead]) {
        mock.mockReset();
    }
});

describe("generateGuide", () => {
    it("refuses a guest before it reads the host, reserves a row or spends anything", async () => {
        await expect(generate(GUEST)).resolves.toEqual({ status: "guest" });

        expect(hostRead).not.toHaveBeenCalled();
        expect(await guides()).toEqual([]);
        expect(charge).not.toHaveBeenCalled();
        expect(enqueue).not.toHaveBeenCalled();
    });

    it("hands a host failure back as it is, with nothing reserved or charged", async () => {
        hostRead.mockResolvedValue({ status: "not_connected" });

        await expect(generate(MEMBER)).resolves.toEqual({ status: "not_connected" });
        expect(await guides()).toEqual([]);
        expect(charge).not.toHaveBeenCalled();
    });

    it("reserves the row, queues the job and charges one unit, in that order", async () => {
        await expect(generate(MEMBER, " Focus on errors ")).resolves.toEqual({ status: "started" });

        const [guide] = await guides();

        expect(guide).toMatchObject({ headSha: HEAD, instructions: "Focus on errors", source: "cloud", status: "generating", userId: MEMBER });
        expect(enqueue).toHaveBeenCalledOnce();
        expect(enqueue.mock.calls[0]?.[1]).toEqual({ guideId: guide?._id, userId: MEMBER });
        expect(enqueue.mock.calls[0]?.[2]).toMatchObject({ once: { jobId: guide?.jobId }, shardKey: MEMBER });
        expect(charge).toHaveBeenCalledOnce();
        expect(charge.mock.calls[0]?.[2]).toBe("Text");
        expect(enqueue.mock.invocationCallOrder[0]).toBeLessThan(charge.mock.invocationCallOrder[0] as number);
    });

    it("says running for a second request while one is being written, and charges only the first", async () => {
        await generate(MEMBER);

        await expect(generate(MEMBER)).resolves.toEqual({ status: "running" });
        expect(charge).toHaveBeenCalledOnce();
        expect(enqueue).toHaveBeenCalledOnce();
        expect(await guides()).toHaveLength(1);
    });

    it("fails the reserved row with `quota` when the daily quota refuses, and says when to come back", async () => {
        charge.mockResolvedValue({ ok: false, retryAfter: 3600 });

        await expect(generate(MEMBER)).resolves.toEqual({ retryAfter: 3600, status: "quota" });
        expect(await guides()).toMatchObject([{ failure: "quota", status: "failed" }]);

        // The row is no longer running: asking again is not answered with "running".
        charge.mockResolvedValue({ ok: true });
        await expect(generate(MEMBER)).resolves.toEqual({ status: "started" });
    });

    it("leaves a job that was queued before the quota refused with nothing to do", async () => {
        charge.mockResolvedValue({ ok: false });
        await generate(MEMBER);

        const [guide] = await guides();

        hostRead.mockResolvedValue(pullRequest());
        await harness.action(async (ctx: any) => await ctx.runAction(runCloudGuide, { guideId: guide?._id, userId: MEMBER }));

        expect(generateObject).not.toHaveBeenCalled();
        expect(await guides()).toMatchObject([{ failure: "quota", status: "failed" }]);
    });

    it("charges nothing and fails the row when the queue refuses the send, so a retry can start", async () => {
        enqueue.mockRejectedValueOnce(new Error("queue unavailable"));

        await expect(generate(MEMBER)).rejects.toThrow("queue unavailable");

        expect(charge).not.toHaveBeenCalled();
        expect(await guides()).toMatchObject([{ failure: "abandoned", status: "failed" }]);

        await expect(generate(MEMBER)).resolves.toEqual({ status: "started" });
        expect(charge).toHaveBeenCalledOnce();
    });
});

describe("runCloudGuide", () => {
    const runJob = async (guideId: string): Promise<void> => {
        await harness.action(async (ctx: any) => await ctx.runAction(runCloudGuide, { guideId, userId: MEMBER }));
    };

    it("saves the guide the model wrote, from the head the host reports now", async () => {
        const guideId = await reserved();

        hostRead.mockResolvedValue(pullRequest(MOVED));
        generateObject.mockResolvedValue({ object: ANSWER });
        await runJob(guideId);

        const [guide] = await guides();

        expect(guide).toMatchObject({ headSha: MOVED, status: "ready", summary: "Adds a thing." });
        expect(guide?.stops.map((stop: Row) => stop.title)).toEqual(["Core"]);
    });

    it.each([
        ["not_connected", "not_connected"],
        ["needs_reconnect", "not_connected"],
        ["host_error", "host_error"],
        ["rate_limited", "host_error"],
        ["not_found", "host_error"],
    ])("fails the guide as %s -> %s when the host read does", async (status, failure) => {
        const guideId = await reserved();

        hostRead.mockResolvedValue({ status });
        await runJob(guideId);

        expect(await guides()).toMatchObject([{ failure, status: "failed" }]);
        expect(generateObject).not.toHaveBeenCalled();
    });

    it("fails the guide as model_error when the model call throws", async () => {
        const guideId = await reserved();

        hostRead.mockResolvedValue(pullRequest());
        generateObject.mockRejectedValue(new Error("gateway down"));
        await runJob(guideId);

        expect(await guides()).toMatchObject([{ failure: "model_error", status: "failed" }]);
    });

    it("does nothing for a guide that is gone or already finished", async () => {
        const guideId = await reserved({ status: "ready" });

        hostRead.mockResolvedValue(pullRequest());
        await runJob(guideId);

        expect(hostRead).not.toHaveBeenCalled();
        expect(generateObject).not.toHaveBeenCalled();
    });

    it("does not ask the model when the row was failed while the pull request was being read", async () => {
        const guideId = await reserved();

        hostRead.mockImplementation(async () => {
            await run(async (ctx) => await ctx.db.patch(guideId, { failure: "quota", status: "failed" }));

            return pullRequest();
        });
        await runJob(guideId);

        expect(generateObject).not.toHaveBeenCalled();
        expect(await guides()).toMatchObject([{ failure: "quota", status: "failed" }]);
    });
});

describe("finalizeHostGuide", () => {
    /** A host guide whose turn ended with `answer` as the agent's last word. */
    const finishedTurn = async (answer: string): Promise<{ guideId: string; streamId: string }> => {
        const { createHostStream } = await import("../chat/streaming/persistent/host");
        const threadId = await run(async (ctx) => await ctx.db.insert("threads", { runner: "host", status: "active", title: "Guide", userId: MEMBER }));
        const guideId = await reserved({ source: "host", threadId });
        const streamId = await run(
            async (ctx) =>
                await createHostStream(ctx, { hostState: "accepted", messageId: "m1", threadId, turnId: crypto.randomUUID(), userId: MEMBER }, Date.now()),
        );

        await run(async (ctx) => await ctx.db.persistentChunks.insert({ seq: 0, streamId, text: answer }));

        return { guideId, streamId: streamId as string };
    };

    const finalize = async (ids: { guideId: string; streamId: string }): Promise<void> => {
        await harness.action(async (ctx: any) => await ctx.runAction(finalizeHostGuide, { ...ids, userId: MEMBER }));
    };

    it("fails the guide as head_moved when the pull request has a newer head than the agent read", async () => {
        const ids = await finishedTurn(JSON.stringify(ANSWER));

        hostRead.mockResolvedValue(pullRequest(MOVED));
        await finalize(ids);

        expect(await guides()).toMatchObject([{ failure: "head_moved", status: "failed" }]);
    });

    it("saves the agent's answer once it has been checked against the same head", async () => {
        const ids = await finishedTurn(`Here you go:\n${JSON.stringify(ANSWER)}`);

        hostRead.mockResolvedValue(pullRequest(HEAD));
        await finalize(ids);

        expect(await guides()).toMatchObject([{ headSha: HEAD, status: "ready", summary: "Adds a thing." }]);
    });

    it("fails the guide as no_answer, without a host read, when the transcript holds no guide", async () => {
        const ids = await finishedTurn("I could not do it.");

        await finalize(ids);

        expect(hostRead).not.toHaveBeenCalled();
        expect(await guides()).toMatchObject([{ failure: "no_answer", status: "failed" }]);
    });
});
