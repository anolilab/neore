import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { MAX_LEASE_MS, SessionHolds, SHARED_DRAIN_MS } from "./session-holds";
import { holdSession, LEASE_MS, SessionLock } from "./session-lock";

/** A hold that was taken: what is left once every refusal is set aside. */
type Taken<T> = Exclude<T, "retired" | "unreachable" | { busy: unknown }>;

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
        expect(holds.take("login", "exclusive", 1000, 1000 + SHARED_DRAIN_MS)).toStrictEqual({ held: true });
        expect(holds.isRetired).toBe(false);
    });

    it("retires a session for good when a sign-in's hold lapses instead of being released: its browser may still show the answer", () => {
        const holds = new SessionHolds();

        holds.take("login", "exclusive", 1000, 0);

        expect(holds.take("a", "shared", 1000, 1000)).toStrictEqual({ held: false, retired: true });
        expect(holds.isRetired).toBe(true);
        expect(holds.take("other-login", "exclusive", 1000, 1_000_000)).toStrictEqual({ held: false, retired: true });
        expect(new SessionHolds([], true).take("a", "shared", 1000, 0)).toStrictEqual({ held: false, retired: true });
    });

    it("refuses a sign-in until a lapsed action's lease is waited out, while other actions still go on", () => {
        const holds = new SessionHolds();

        holds.take("a", "shared", 1000, 0);
        holds.release("released", 0);

        expect(holds.take("login", "exclusive", 1000, 1000)).toStrictEqual({ busy: "shared", held: false });
        expect(holds.take("login", "exclusive", 1000, 1000 + SHARED_DRAIN_MS - 1)).toStrictEqual({ busy: "shared", held: false });
        expect(holds.take("b", "shared", 1000, 1000 + SHARED_DRAIN_MS - 1)).toStrictEqual({ held: true });

        const released = new SessionHolds();

        released.take("a", "shared", 1000, 0);
        released.release("a", 500);

        // Released, not lapsed: nothing to wait out.
        expect(released.take("login", "exclusive", 1000, 500)).toStrictEqual({ held: true });
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
    const writes: string[] = [];
    const lock = new SessionLock({
        storage: {
            delete: async (key: string) => {
                writes.push(`delete ${key}`);

                return stored.delete(key);
            },
            get: async (key: string) => structuredClone(stored.get(key)),
            put: async (key: string, value: unknown) => {
                writes.push(`put ${key}`);
                stored.set(key, structuredClone(value));
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

    return { control, namespace: namespace as unknown as DurableObjectNamespace, stored, writes };
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

        await (hold as Taken<typeof hold>).linger(1000);
        await vi.advanceTimersByTimeAsync(1000);

        await expect(holdSession(namespace, "s", "shared")).resolves.toBe("retired");
        await expect(holdSession(namespace, "s", "exclusive")).resolves.toBe("retired");

        vi.useRealTimers();
    });

    it("drops a lapsed sign-in's hold and retires the session in one write, so no crash between two loses both", async () => {
        vi.useFakeTimers();

        const { namespace, stored, writes } = namespaceOf();
        const hold = await holdSession(namespace, "s", "exclusive");

        await (hold as Taken<typeof hold>).linger(1000);
        await vi.advanceTimersByTimeAsync(1000);
        writes.length = 0;

        await expect(holdSession(namespace, "s", "shared")).resolves.toBe("retired");
        expect(writes).toStrictEqual(["put state"]);
        expect(stored.get("state")).toStrictEqual({ holds: [], retired: true });

        vi.useRealTimers();
    });

    it("keeps its holds in storage, and drops the key once none is left", async () => {
        const { namespace, stored } = namespaceOf();
        const hold = await holdSession(namespace, "s", "shared");

        expect((stored.get("state") as { holds: unknown[] }).holds).toHaveLength(1);

        await (hold as Taken<typeof hold>).release();

        expect(stored.has("state")).toBe(false);
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

        if (hold === "unreachable" || hold === "retired" || "busy" in hold) {
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
        stored.delete("state");
        await vi.advanceTimersByTimeAsync(5000);

        expect(onLost).toHaveBeenCalledOnce();
    });

    it("says a hold was in force all along when the lock is only slow to answer its release, and not once the lock says it lapsed", async () => {
        const { control, namespace, stored } = namespaceOf();
        const slow = await held(namespace, "shared");

        control.reachable = false;

        const releasing = slow.release();

        await vi.advanceTimersByTimeAsync(3000);

        await expect(releasing).resolves.toBe(true);

        control.reachable = true;

        const dropped = await held(namespace, "shared");

        stored.delete("state");

        await expect(dropped.release()).resolves.toBe(false);
    });

    it("sends a sign-in's release again when its answer is lost, so the hold does not lapse and retire a clean session", async () => {
        const { control, namespace, stored } = namespaceOf();
        const hold = await held(namespace);

        control.reachable = false;

        const releasing = hold.release(500);

        await vi.advanceTimersByTimeAsync(500);
        await expect(releasing).resolves.toBe(true);

        const settling = hold.settle();

        // Two more releases lost, then the lock answers.
        await vi.advanceTimersByTimeAsync(3000 + 250 + 3000);
        control.reachable = true;
        await vi.advanceTimersByTimeAsync(500 + 3000);
        await settling;

        expect(stored.get("state")).toBeUndefined();

        await vi.advanceTimersByTimeAsync(LEASE_MS);

        await expect(holdSession(namespace, "s", "shared")).resolves.not.toBe("retired");
        expect(control.calls.filter((call) => (call as { op: string }).op === "release").length).toBeGreaterThanOrEqual(3);
    });

    it("stops sending the release once the lock answered one, and gives up when the lease it confirmed has run out", async () => {
        const answered = namespaceOf();
        const hold = await held(answered.namespace);

        await hold.release();
        await hold.settle();

        expect(answered.control.calls.filter((call) => (call as { op: string }).op === "release")).toHaveLength(1);

        const { control, namespace } = namespaceOf();
        const lost = await held(namespace);

        control.reachable = false;

        const settling = lost.settle();

        await vi.advanceTimersByTimeAsync(LEASE_MS);
        await expect(settling).resolves.toBeUndefined();
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
