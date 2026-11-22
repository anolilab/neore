import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { MAX_LEASE_MS, SessionHolds } from "./session-holds";
import { holdSession, LEASE_MS, SessionLock } from "./session-lock";

describe(SessionHolds, () => {
    it("refuses an exclusive hold while any other is in force, and a shared one only beside an exclusive one", () => {
        const holds = new SessionHolds();

        expect(holds.take("a", "shared", 1000, 0)).toStrictEqual({ held: true });
        expect(holds.take("b", "shared", 1000, 0)).toStrictEqual({ held: true });
        expect(holds.take("login", "exclusive", 1000, 0)).toStrictEqual({ busy: "shared", held: false });

        holds.release("a", 0);
        holds.release("b", 0);

        expect(holds.take("login", "exclusive", 1000, 0)).toStrictEqual({ held: true });
        expect(holds.take("c", "shared", 1000, 0)).toStrictEqual({ busy: "exclusive", held: false });
        expect(holds.take("other-login", "exclusive", 1000, 0)).toStrictEqual({ busy: "exclusive", held: false });
    });

    it("lets a shared hold lapse at its lease's end, so a dead isolate's action frees the session, and never brings it back", () => {
        const holds = new SessionHolds();

        holds.take("a", "shared", 1000, 0);

        expect(holds.take("login", "exclusive", 1000, 999)).toStrictEqual({ busy: "shared", held: false });
        expect(holds.renew("a", 1000, 1000)).toStrictEqual({ held: false });
        expect(holds.release("a", 1000)).toStrictEqual({ held: false });
        expect(holds.take("login", "exclusive", 1000, 1000)).toStrictEqual({ held: true });
        expect(holds.isRetired).toBe(false);
    });

    it("retires a session for good when a sign-in's hold lapses instead of being released: its browser may still show the answer", () => {
        const holds = new SessionHolds();

        holds.take("login", "exclusive", 1000, 0);

        expect(holds.take("a", "shared", 1000, 1000)).toStrictEqual({ busy: "exclusive", held: false });
        expect(holds.isRetired).toBe(true);
        expect(holds.take("other-login", "exclusive", 1000, 1_000_000)).toStrictEqual({ busy: "exclusive", held: false });
        expect(new SessionHolds([], true).take("a", "shared", 1000, 0)).toStrictEqual({ busy: "exclusive", held: false });
    });

    it("runs a renewed hold on from the renewal, and says a release of one in force was held all along", () => {
        const holds = new SessionHolds();

        holds.take("login", "exclusive", 1000, 0);

        expect(holds.renew("login", 1000, 900)).toStrictEqual({ held: true });
        expect(holds.take("a", "shared", 1000, 1500)).toStrictEqual({ busy: "exclusive", held: false });
        expect(holds.release("login", 1500)).toStrictEqual({ held: true });
        expect(holds.take("a", "shared", 1000, 1500)).toStrictEqual({ held: true });
    });

    it("renews the hold a token already has when it asks again, its first answer lost", () => {
        const holds = new SessionHolds();

        holds.take("login", "exclusive", 1000, 0);

        expect(holds.take("login", "exclusive", 1000, 500)).toStrictEqual({ held: true });
        expect(holds.entries(1400)).toStrictEqual([["login", { expiresAt: 1500, kind: "exclusive" }]]);
    });

    it("caps a lease", () => {
        const holds = new SessionHolds();

        holds.take("a", "shared", Number.MAX_SAFE_INTEGER, 0);

        expect(holds.entries(0)).toStrictEqual([["a", { expiresAt: MAX_LEASE_MS, kind: "shared" }]]);
    });
});

/** A `SESSION_LOCK` namespace of one lock on memory storage; `reachable` false has its calls never answer. */
const namespaceOf = () => {
    const stored = new Map<string, unknown>();
    const lock = new SessionLock({
        storage: {
            delete: async (key: string) => stored.delete(key),
            get: async (key: string) => stored.get(key),
            put: async (key: string, value: unknown) => {
                stored.set(key, value);
            },
        },
    } as never);
    const control = { calls: [] as unknown[], reachable: true };
    const namespace = {
        get: () => {
            return {
                fetch: async (url: string, init: RequestInit) => {
                    control.calls.push(JSON.parse(init.body as string));

                    return control.reachable
                        ? lock.fetch(new Request(url, init))
                        : new Promise<Response>(() => {
                              // Never answers.
                          });
                },
            };
        },
        idFromName: (name: string) => name,
    };

    return { control, namespace: namespace as unknown as DurableObjectNamespace, stored };
};

describe(SessionLock, () => {
    it("refuses a request it cannot read", async () => {
        const { namespace } = namespaceOf();
        const response = await namespace
            .get(namespace.idFromName("s"))
            .fetch("https://session-lock/", { body: JSON.stringify({ op: "take", token: "t" }), method: "POST" });

        expect(response.status).toBe(400);
    });

    it("keeps a retired session refused across its reads of storage", async () => {
        vi.useFakeTimers();

        const { namespace } = namespaceOf();
        const hold = await holdSession(namespace, "s", "exclusive");

        await (hold as Exclude<typeof hold, "unreachable" | { busy: unknown }>).linger(1000);
        await vi.advanceTimersByTimeAsync(1000);

        await expect(holdSession(namespace, "s", "shared")).resolves.toStrictEqual({ busy: "exclusive" });
        await expect(holdSession(namespace, "s", "shared")).resolves.toStrictEqual({ busy: "exclusive" });

        vi.useRealTimers();
    });

    it("keeps its holds in storage, and drops the key once none is left", async () => {
        const { namespace, stored } = namespaceOf();
        const hold = await holdSession(namespace, "s", "shared");

        expect(stored.get("holds")).toHaveLength(1);

        await (hold as Exclude<typeof hold, "unreachable" | { busy: unknown }>).release();

        expect(stored.has("holds")).toBe(false);
    });
});

describe(holdSession, () => {
    beforeEach(() => {
        vi.useFakeTimers();
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    const held = async (namespace: DurableObjectNamespace, kind: "exclusive" | "shared" = "exclusive") => {
        const hold = await holdSession(namespace, "s", kind);

        if (hold === "unreachable" || "busy" in hold) {
            throw new Error("not held");
        }

        return hold;
    };

    it("renews its hold while it runs, so another call stays refused past one lease", async () => {
        const { namespace } = namespaceOf();
        const hold = await held(namespace);

        await vi.advanceTimersByTimeAsync(LEASE_MS * 3);

        await expect(holdSession(namespace, "s", "shared")).resolves.toStrictEqual({ busy: "exclusive" });
        expect(hold.isLost()).toBe(false);
        await expect(hold.release()).resolves.toBe(true);
        await expect(holdSession(namespace, "s", "shared")).resolves.not.toBe("unreachable");
    });

    it("counts as unreachable a lock that does not answer in time, and releases what the take may have taken", async () => {
        const { control, namespace } = namespaceOf();

        control.reachable = false;

        const taking = holdSession(namespace, "s", "exclusive");

        await vi.advanceTimersByTimeAsync(3000);

        await expect(taking).resolves.toBe("unreachable");
        expect(control.calls).toStrictEqual([expect.objectContaining({ op: "take" }), expect.objectContaining({ op: "release" })]);
    });

    it("gives its hold up as lost 10 s before the lease could lapse when renewals go unanswered, and says so at release", async () => {
        const { control, namespace } = namespaceOf();
        const hold = await held(namespace);
        const onLost = vi.fn();

        hold.onLost(onLost);
        control.reachable = false;
        await vi.advanceTimersByTimeAsync(LEASE_MS - 10_000 - 1);

        expect(onLost).not.toHaveBeenCalled();

        await vi.advanceTimersByTimeAsync(1);

        expect(onLost).toHaveBeenCalledOnce();
        expect(hold.isLost()).toBe(true);

        control.reachable = true;

        await expect(hold.release()).resolves.toBe(false);
    });

    it("gives its hold up as lost at once when the lock says it lapsed", async () => {
        const { namespace, stored } = namespaceOf();
        const hold = await held(namespace, "shared");
        const onLost = vi.fn();

        hold.onLost(onLost);
        stored.delete("holds");
        await vi.advanceTimersByTimeAsync(5000);

        expect(onLost).toHaveBeenCalledOnce();
    });

    it("keeps a lingering hold for the time it is given, renewing it no more, and frees the session when released in it", async () => {
        const { namespace } = namespaceOf();
        const hold = await held(namespace);

        await hold.linger(90_000);
        await vi.advanceTimersByTimeAsync(89_000);

        await expect(holdSession(namespace, "s", "shared")).resolves.toStrictEqual({ busy: "exclusive" });
        await expect(hold.release()).resolves.toBe(true);
        await expect(holdSession(namespace, "s", "shared")).resolves.not.toHaveProperty("busy");
    });
});
