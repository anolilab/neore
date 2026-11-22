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

    it("never shortens a hold when a short renewal arrives after a longer one", () => {
        const holds = new SessionHolds();

        holds.take("login", "exclusive", 1000, 0);
        // The long lease sent as the browser closes, then the periodic renewal sent before it, arriving late.
        expect(holds.renew("login", 60_000, 100)).toStrictEqual({ held: true });
        expect(holds.renew("login", 1000, 200)).toStrictEqual({ held: true });

        // Past the short lease's end, the long one still holds: nothing lapsed, nothing retired.
        expect(holds.take("a", "shared", 1000, 5000)).toStrictEqual({ busy: "exclusive", held: false });
        expect(holds.release("login", 5000)).toStrictEqual({ held: true });
    });

    it("renews the hold a token already has when it asks again, its first answer lost", () => {
        const holds = new SessionHolds();

        holds.take("login", "exclusive", 1000, 0);

        expect(holds.take("login", "exclusive", 1000, 500)).toStrictEqual({ held: true });
        expect(holds.entries(1400)).toStrictEqual([["login", { expiresAt: 1500, kind: "exclusive" }]]);
    });

    it("holds nothing for a take that arrives after its own release, and forgets the release once no hold of it could run", () => {
        const holds = new SessionHolds();

        expect(holds.release("late", 0)).toStrictEqual({ held: false });
        expect(holds.take("late", "exclusive", 1000, 1)).toStrictEqual({ held: false });
        expect(holds.take("other", "shared", 1000, 2)).toStrictEqual({ held: true });
        expect(holds.state(MAX_LEASE_MS - 1)?.cancelled).toStrictEqual([["late", MAX_LEASE_MS]]);
        expect(holds.state(MAX_LEASE_MS)?.cancelled).toBeUndefined();
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
    beforeEach(() => {
        vi.useFakeTimers();
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it("refuses a request it cannot read", async () => {
        const { namespace } = namespaceOf();
        const response = await namespace
            .get(namespace.idFromName("s"))
            .fetch("https://session-lock/", { body: JSON.stringify({ op: "take", token: "t" }), method: "POST" });

        expect(response.status).toBe(400);
    });

    it("keeps a retired session refused across its reads of storage", async () => {
        const { namespace } = namespaceOf();
        const hold = await holdSession(namespace, "s", "exclusive");

        // A linger only ever lengthens the hold: it lapses once the lease it already has runs out.
        await (hold as Taken<typeof hold>).linger(1000);
        await vi.advanceTimersByTimeAsync(LEASE_MS + 1000);

        await expect(holdSession(namespace, "s", "shared")).resolves.toBe("retired");
        await expect(holdSession(namespace, "s", "exclusive")).resolves.toBe("retired");
    });

    it("judges a lapse by the time its read of storage finished, so a release whose read outlasts the hold still retires the session", async () => {
        const stored = new Map<string, unknown>();
        let readTakes = 0;
        const lock = new SessionLock({
            storage: {
                delete: async (key: string) => stored.delete(key),
                get: async (key: string) => {
                    vi.setSystemTime(Date.now() + readTakes);

                    return structuredClone(stored.get(key));
                },
                put: async (key: string, value: unknown) => {
                    stored.set(key, structuredClone(value));
                },
            },
        } as never);
        const send = async (body: Record<string, number | string>) =>
            lock.fetch(new Request("https://session-lock/", { body: JSON.stringify(body), method: "POST" })).then(async (response) => response.json());

        await expect(send({ kind: "exclusive", leaseMs: 1000, op: "take", token: "login" })).resolves.toStrictEqual({ held: true });

        // The release is sent inside the lease; its read of storage ends past it.
        vi.setSystemTime(Date.now() + 900);
        readTakes = 500;

        await expect(send({ op: "release", token: "login" })).resolves.toMatchObject({ held: false });
        expect(stored.get("state")).toMatchObject({ retired: true });
    });

    it("drops a lapsed sign-in's hold and retires the session in one write, so no crash between two loses both", async () => {
        const { namespace, stored, writes } = namespaceOf();
        const hold = await holdSession(namespace, "s", "exclusive");

        // A linger only ever lengthens the hold: it lapses once the lease it already has runs out.
        await (hold as Taken<typeof hold>).linger(1000);
        await vi.advanceTimersByTimeAsync(LEASE_MS + 1000);
        writes.length = 0;

        await expect(holdSession(namespace, "s", "shared")).resolves.toBe("retired");
        expect(writes).toStrictEqual(["put state"]);
        expect(stored.get("state")).toStrictEqual({ holds: [], retired: true });
    });

    it("refuses a take that arrives after the deadline its caller gave it, holding nothing", async () => {
        const { namespace, stored } = namespaceOf();
        const response = await namespace.get(namespace.idFromName("s")).fetch("https://session-lock/", {
            body: JSON.stringify({ kind: "exclusive", leaseMs: LEASE_MS, notAfter: Date.now() - 1, op: "take", token: "late" }),
            method: "POST",
        });

        await expect(response.json()).resolves.toStrictEqual({ held: false });
        expect(stored.has("state")).toBe(false);
    });

    it("keeps its holds in storage, and drops the key once none is left", async () => {
        const { namespace, stored } = namespaceOf();
        const hold = await holdSession(namespace, "s", "shared");

        expect((stored.get("state") as { holds: unknown[] }).holds).toHaveLength(1);

        await (hold as Taken<typeof hold>).release();

        // The release is kept until no hold of its token could still run.
        expect(stored.get("state")).toStrictEqual({ cancelled: [[expect.any(String), expect.any(Number)]], holds: [] });

        vi.advanceTimersByTime(MAX_LEASE_MS);
        await namespace
            .get(namespace.idFromName("s"))
            .fetch("https://session-lock/", { body: JSON.stringify({ leaseMs: 1, op: "renew", token: "t" }), method: "POST" });

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

    it("waits for the lock no longer than the caller gives a take, and hands the release of one unanswered on past the answer", async () => {
        const { control, namespace } = namespaceOf();
        const kept: Promise<unknown>[] = [];

        await expect(holdSession(namespace, "s", "exclusive", { takeMs: 0 })).resolves.toBe("unreachable");
        expect(control.calls).toStrictEqual([{ op: "release", token: expect.any(String) }]);

        control.reachable = false;

        const taking = holdSession(namespace, "s", "exclusive", {
            keep: (work) => {
                kept.push(work);
            },
            takeMs: 1000,
        });

        await vi.advanceTimersByTimeAsync(1000);
        await expect(taking).resolves.toBe("unreachable");
        expect(kept).toHaveLength(1);

        // The lock answers only after the first release's own call ran out: the release is sent again until one lands.
        let isKept = false;

        kept[0]
            ?.finally(() => {
                isKept = true;
            })
            .catch(() => undefined);
        await vi.advanceTimersByTimeAsync(5000);
        expect(isKept).toBe(false);

        const before = control.calls.length;

        control.reachable = true;
        await vi.advanceTimersByTimeAsync(10_000);

        expect(isKept).toBe(true);
        expect(control.calls.slice(before)).toContainEqual({ op: "release", token: expect.any(String) });
    });

    it("keeps sending a lost take's release until the latest a lease of it could end, not one lease from its sending", async () => {
        const { control, namespace } = namespaceOf();
        const kept: Promise<unknown>[] = [];

        control.reachable = false;

        const taking = holdSession(namespace, "s", "exclusive", {
            keep: (work) => {
                kept.push(work);
            },
            takeMs: 1000,
        });

        await vi.advanceTimersByTimeAsync(1000);
        await expect(taking).resolves.toBe("unreachable");

        // A take the lock accepted just before its deadline holds a lease past that: the release is still sent then.
        let isKept = false;

        kept[0]
            ?.finally(() => {
                isKept = true;
            })
            .catch(() => undefined);
        await vi.advanceTimersByTimeAsync(LEASE_MS + 500);
        expect(isKept).toBe(false);

        // And no longer than that lease, give or take the clocks.
        await vi.advanceTimersByTimeAsync(2000);

        expect(isKept).toBe(true);
    });

    it("renews its hold while it runs, so another call stays refused past one lease", async () => {
        const { namespace } = namespaceOf();
        const hold = await held(namespace);

        await vi.advanceTimersByTimeAsync(LEASE_MS * 3);

        await expect(holdSession(namespace, "s", "shared")).resolves.toStrictEqual({ busy: "exclusive" });
        expect(hold.isLost()).toBe(false);
        await expect(hold.release()).resolves.toBe(true);
        await expect(held(namespace, "shared")).resolves.toHaveProperty("release");
    });

    it("counts as unreachable a lock that does not answer in time, and releases what the take may have taken", async () => {
        const { control, namespace } = namespaceOf();

        control.reachable = false;

        const taking = holdSession(namespace, "s", "exclusive");

        await vi.advanceTimersByTimeAsync(3000);

        await expect(taking).resolves.toBe("unreachable");
        expect(control.calls).toStrictEqual([expect.objectContaining({ op: "take" }), expect.objectContaining({ op: "release" })]);
    });

    it("leaves no hold when the release sent on a take's timeout reaches the lock before the take", async () => {
        const { control, namespace, stored } = namespaceOf();
        const lock = new SessionLock({
            storage: {
                delete: async (key: string) => stored.delete(key),
                get: async (key: string) => structuredClone(stored.get(key)),
                put: async (key: string, value: unknown) => {
                    stored.set(key, structuredClone(value));
                },
            },
        } as never);

        control.reachable = false;

        const taking = holdSession(namespace, "s", "exclusive");

        await vi.advanceTimersByTimeAsync(3000);
        await expect(taking).resolves.toBe("unreachable");

        // The release arrives first, then the delayed take.
        const [take, release] = control.calls as unknown[];
        const send = async (body: unknown) => lock.fetch(new Request("https://session-lock/", { body: JSON.stringify(body), method: "POST" }));

        await send(release);
        const late = await send(take);

        await expect(late.json()).resolves.toStrictEqual({ held: false });

        control.reachable = true;
        await expect(held(namespace, "exclusive")).resolves.toHaveProperty("release");
        await vi.advanceTimersByTimeAsync(LEASE_MS * 2);
        await expect(holdSession(namespace, "s", "shared")).resolves.not.toBe("retired");
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

        expect(stored.get("state")).toMatchObject({ holds: [] });

        await vi.advanceTimersByTimeAsync(LEASE_MS);

        await expect(holdSession(namespace, "s", "shared")).resolves.not.toBe("retired");
        expect(control.calls.filter((call) => (call as { op: string }).op === "release").length).toBeGreaterThanOrEqual(3);
    });

    it("keeps sending a lost release until a linger's hold ends, even when an older renewal answers after the linger", async () => {
        const { control, namespace: inner } = namespaceOf();
        const renewal = Promise.withResolvers<undefined>();
        let isRenewalHeld = false;
        const namespace = {
            get: (id: unknown) => {
                const stub = inner.get(id as never);

                return {
                    fetch: async (url: string, init: RequestInit) => {
                        const body = JSON.parse(init.body as string) as { leaseMs?: number; op: string };

                        if (!isRenewalHeld && body.op === "renew" && body.leaseMs === LEASE_MS) {
                            // The first periodic renewal is answered only once the linger has been.
                            isRenewalHeld = true;
                            await renewal.promise;
                        }

                        return stub.fetch(url, init);
                    },
                };
            },
            idFromName: inner.idFromName.bind(inner),
        } as unknown as DurableObjectNamespace;
        const hold = await held(namespace);

        await vi.advanceTimersByTimeAsync(5000);
        expect(isRenewalHeld).toBe(true);

        await hold.linger(90_000);
        renewal.resolve(undefined);
        await vi.advanceTimersByTimeAsync(0);

        control.reachable = false;

        let isSettled = false;
        const settling = hold.settle().finally(() => {
            isSettled = true;
        });

        // Past the renewal's own lease end, well inside the linger's.
        await vi.advanceTimersByTimeAsync(LEASE_MS + 20_000);
        expect(isSettled).toBe(false);

        await vi.advanceTimersByTimeAsync(90_000);
        await settling;

        expect(isSettled).toBe(true);
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
        await expect(held(namespace, "shared")).resolves.toHaveProperty("release");
    });
});
