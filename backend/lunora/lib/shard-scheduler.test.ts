/**
 * The scheduler namespace wrapper (docs/plans/per-user-sharding.md): a job
 * defaults to the shard that scheduled it, and runs on its TARGET shard's own
 * SchedulerDO lane (anolilab/lunora#793) instead of the one app-wide instance.
 */
import { describe, expect, it } from "vitest";

import { currentShard, currentUserShard, runInShard, servesUser } from "./shard-context";
import { routeSchedule, runAfterOnShard, schedulerInstanceFor, shardScopedSchedulerNamespace } from "./shard-scheduler";

const SCHEDULE_URL = "https://scheduler.internal/schedule";

const fakeNamespace = () => {
    const calls: { body: unknown; instance: string; path: string }[] = [];

    return {
        calls,
        namespace: {
            get: (id: { name: string }) => {
                return {
                    fetch: async (input: Request | string, init?: RequestInit) => {
                        calls.push({
                            body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
                            instance: id.name,
                            path: new URL(typeof input === "string" ? input : input.url).pathname,
                        });

                        return Response.json({ id: "job-1" });
                    },
                };
            },
            idFromName: (name: string) => {
                return { name };
            },
        },
    };
};

describe("routeSchedule", () => {
    const init = (body: unknown): RequestInit => {
        return { body: JSON.stringify(body), method: "POST" };
    };

    it("defaults the job to the calling shard", () => {
        const routed = routeSchedule(SCHEDULE_URL, init({ functionPath: "a:b" }), "user-a");

        expect(routed?.targetShard).toBe("user-a");
        expect(JSON.parse(routed?.init?.body as string)).toStrictEqual({ functionPath: "a:b", shardKey: "user-a" });
    });

    it("keeps a named shard, and routes by it", () => {
        const routed = routeSchedule(SCHEDULE_URL, init({ functionPath: "a:b", shardKey: "user-b" }), undefined);

        expect(routed?.targetShard).toBe("user-b");
        expect(JSON.parse(routed?.init?.body as string)).toStrictEqual({ functionPath: "a:b", shardKey: "user-b" });
    });

    it("leaves root jobs on the default lane", () => {
        expect(routeSchedule(SCHEDULE_URL, init({ functionPath: "a:b" }), undefined)?.targetShard).toBeUndefined();
        expect(routeSchedule(SCHEDULE_URL, init({ functionPath: "a:b", shardKey: "__root__" }), "user-a")?.targetShard).toBeUndefined();
    });

    it("ignores anything but a JSON /schedule", () => {
        expect(routeSchedule("https://scheduler.internal/cancel", init({ id: "x" }), "user-a")).toBeUndefined();
        expect(routeSchedule(SCHEDULE_URL, { body: "nope", method: "POST" }, "user-a")).toBeUndefined();
    });
});

describe("shardScopedSchedulerNamespace", () => {
    it("sends a user shard's job to that user's lane, stamped with its shard", async () => {
        const { calls, namespace } = fakeNamespace();
        const wrapped = shardScopedSchedulerNamespace(namespace, () => "user-a");
        const stub = wrapped.get(wrapped.idFromName("default") as never);

        await stub.fetch(SCHEDULE_URL, { body: JSON.stringify({ functionPath: "a:b" }), method: "POST" });

        expect(calls).toStrictEqual([{ body: { functionPath: "a:b", shardKey: "user-a" }, instance: schedulerInstanceFor("user-a"), path: "/schedule" }]);
    });

    it("sends a root-scheduled job for a user to THAT user's lane", async () => {
        const { calls, namespace } = fakeNamespace();
        const wrapped = shardScopedSchedulerNamespace(namespace, () => undefined);

        await wrapped
            .get(wrapped.idFromName("default") as never)
            .fetch(SCHEDULE_URL, { body: JSON.stringify({ functionPath: "a:b", shardKey: "user-b" }), method: "POST" });

        expect(calls[0]?.instance).toBe(schedulerInstanceFor("user-b"));
    });

    it("routes the runtime HTTP-action scheduler's Request-shaped call the same way", async () => {
        const { calls, namespace } = fakeNamespace();
        const wrapped = shardScopedSchedulerNamespace(namespace, () => "user-a");
        const request = new Request(SCHEDULE_URL, {
            body: JSON.stringify({ functionPath: "a:b" }),
            headers: { "content-type": "application/json" },
            method: "POST",
        });

        await wrapped.get(wrapped.idFromName("default") as never).fetch(request);

        expect(calls).toStrictEqual([{ body: { functionPath: "a:b", shardKey: "user-a" }, instance: schedulerInstanceFor("user-a"), path: "/schedule" }]);
    });

    it("keeps root work, cancels and named instances where they were", async () => {
        const { calls, namespace } = fakeNamespace();
        const onRoot = shardScopedSchedulerNamespace(namespace, () => undefined);
        const onUser = shardScopedSchedulerNamespace(namespace, () => "user-a");

        await onRoot.get(onRoot.idFromName("default") as never).fetch(SCHEDULE_URL, { body: JSON.stringify({ functionPath: "a:b" }), method: "POST" });
        await onUser
            .get(onUser.idFromName("default") as never)
            .fetch("https://scheduler.internal/cancel", { body: JSON.stringify({ id: "x" }), method: "POST" });

        expect(calls.map((call) => call.instance)).toStrictEqual(["default", schedulerInstanceFor("user-a")]);
        expect(onUser.idFromName("pool-x")).toStrictEqual({ name: "pool-x" });
    });
});

describe("runAfterOnShard", () => {
    it("passes the shard as the fourth argument", async () => {
        const seen: unknown[][] = [];
        const scheduler = {
            runAfter: async (...arguments_: unknown[]) => {
                seen.push(arguments_);

                return "job";
            },
        };

        await runAfterOnShard(scheduler, 0, { __lunoraRef: "a:b" }, { x: 1 }, "user-a");

        expect(seen[0]).toStrictEqual([0, { __lunoraRef: "a:b" }, { x: 1 }, { shardKey: "user-a" }]);
    });
});

describe("shard context", () => {
    it("is empty outside a shard, and set inside one — across awaits", async () => {
        expect(currentShard()).toBeUndefined();
        expect(servesUser("anyone")).toBe(true);

        await runInShard("user-a", async () => {
            await Promise.resolve();

            expect(currentShard()).toBe("user-a");
            expect(currentUserShard()).toBe("user-a");
            expect(servesUser("user-a")).toBe(true);
            expect(servesUser("user-b")).toBe(false);
        });

        runInShard("__root__", () => {
            expect(currentUserShard()).toBeUndefined();
        });
    });
});
