/* eslint-disable unicorn/no-await-expression-member -- the assertions read one field of an awaited result */
/**
 * Develop's freshness against the real schema and the real driver, with a fake host: an unchanged list costs one
 * conditional request per poll, polling stops for a repository nobody watches, a webhook only marks a repository dirty,
 * and a new review request notifies once.
 */
import { lunoraTest } from "@lunora/testing";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { registeredApi, registerModule } from "../../test/registered-api";
import schema from "../schema";
import { githubDriver } from "./drivers/github";
import {
    acceptWatchDelivery,
    dispatchDueRepoPolls,
    getWatchForPoll,
    getWatchForWebhook,
    leaseWatchedRepositoriesForRefresh,
    recordRepoPoll,
} from "./freshness-internal";
import { POLL_INTERVAL_MS, POLL_INTERVAL_WITH_WEBHOOK_MS, POLL_LEASE_MS } from "./freshness-logic";
import { hostPoll, runRepoPoll } from "./freshness-poll";
import { disableWatchWebhook, enableWatchWebhook, listWatchedRepositories, unwatchRepo, watchRepo } from "./freshness";
import { handleWatchWebhook } from "./webhook";

const { noteShardDue, registry } = vi.hoisted(() => {
    return { noteShardDue: vi.fn(async (..._arguments: unknown[]) => undefined), registry: new Map<string, unknown>() };
});

const { sessionFrom } = vi.hoisted(() => {
    return {
        sessionFrom: async (context: { auth: { userId?: string | null } }) =>
            context.auth.userId ? { activeOrganization: { id: "org-1" }, id: context.auth.userId, userId: context.auth.userId } : null,
    };
});

vi.mock("../_generated/internal", async (importOriginal) => registeredApi(await importOriginal(), registry));

vi.mock("../lib/shard-housekeeping", async (importOriginal) => {
    return { ...(await importOriginal<typeof import("../lib/shard-housekeeping")>()), noteShardDue };
});

vi.mock("../lib/rate-limiter", async (importOriginal) => {
    return { ...(await importOriginal<typeof import("../lib/rate-limiter")>()), checkRateLimit: async () => {return { ok: true }} };
});

vi.mock("../lib/crpc-auth-helpers", async (importOriginal) => {
    return {
        ...(await importOriginal<typeof import("../lib/crpc-auth-helpers")>()),
        getSessionUser: sessionFrom,
        getSessionUserForQuery: sessionFrom,
        getSessionUserForQueryLite: sessionFrom,
    };
});

vi.mock("../auth", async (importOriginal) => {
    return {
        ...(await importOriginal<typeof import("../auth")>()),
        getAuthUserIdentity: async (context: { auth: { userId?: string | null } }) =>
            context.auth.userId ? { subject: context.auth.userId, userId: context.auth.userId } : null,
    };
});

beforeAll(async () => {
    registerModule(registry, "source_control_freshness_internal", await import("./freshness-internal"));
});

const NOW = 1_800_000_000_000;
const USER = "user-a";
const OTHER = "user-b";
const REPO = "octo/hello";

let harness: ReturnType<typeof lunoraTest>;

beforeEach(() => {
    vi.useFakeTimers({ now: NOW, toFake: ["Date"] });
    noteShardDue.mockClear();
    harness = lunoraTest(schema as never);
});

afterEach(() => {
    harness.close();
    vi.useRealTimers();
});

const as = (userId: string) => harness.withIdentity({ userId });

// ─── The fake host ───────────────────────────────────────────────────────────

const pull = (number: number, overrides: Record<string, unknown> = {}) => {
    return {
        created_at: "2026-10-01T10:00:00Z",
        draft: false,
        html_url: `https://github.com/octo/hello/pull/${number}`,
        labels: [],
        number,
        requested_reviewers: [{ login: "me" }],
        title: `Pull ${number}`,
        updated_at: "2026-10-02T10:00:00Z",
        user: { login: "alice" },
        ...overrides,
    };
};

interface Call {
    ifNoneMatch: string | null;
    path: string;
}

/** A GitHub (as a transport) whose list changes when `change` is called, answers 304 to the current ETag and records every request. */
const fakeHost = () => {
    const state = { calls: [] as Call[], etag: 1, failWith: null as number | null, pulls: [pull(1)] as unknown[] };
    const via = async (input: Request | string | URL, init?: RequestInit): Promise<Response> => {
        const url = new URL(String(input));
        const ifNoneMatch = new Headers(init?.headers).get("if-none-match");

        state.calls.push({ ifNoneMatch, path: url.pathname });

        if (state.failWith !== null) {
            return new Response("limited", { headers: { "x-ratelimit-remaining": "0" }, status: state.failWith });
        }

        if (url.pathname === "/user") {
            return Response.json({ login: "me" });
        }

        if (ifNoneMatch === `W/"${state.etag}"`) {
            return new Response(null, { status: 304 });
        }

        return Response.json(state.pulls, { headers: { etag: `W/"${state.etag}"` } });
    };

    return {
        get calls() {
            return state.calls;
        },
        change: (pulls: unknown[]) => {
            state.etag += 1;
            state.pulls = pulls;
        },
        fail: (status: number | null) => {
            state.failWith = status;
        },
        via,
    };
};

const TOKEN = { accessToken: "t", renew: async () => {return { problem: "expired" as const }} };

// ─── Driving a repository the way the shard does ─────────────────────────────

const rowOf = async (repo = REPO): Promise<any> =>
    await harness.run(async (ctx: any) => (await ctx.db.query("watchedRepositories").collect()).find((row: { repository: string }) => row.repository === repo));

const notices = async (): Promise<any[]> => await harness.run(async (ctx: any) => await ctx.db.query("notifications").collect());

const watch = async (repo = REPO, userId = USER): Promise<void> => {
    await as(userId).mutation(watchRepo as never, { repository: repo } as never);
};

const advance = (to: number): void => {
    vi.setSystemTime(to);
};

/** One shard tick's worth: dispatch what is due, then run each scheduled poll against `host`. Answers the requests made. */
const tick = async (host: ReturnType<typeof fakeHost>, at: number): Promise<number> => {
    advance(at);

    const before = host.calls.length;
    const scheduledBefore = harness.scheduler.list().length;

    await harness.run(async (ctx: any) => await ctx.runMutation(dispatchDueRepoPolls, {}));

    for (const job of harness.scheduler.list().slice(scheduledBefore)) {
        const { lease, watchId } = job.args as { lease: number; watchId: string };

        await runRepoPoll(
            {
                fetch: hostPoll(githubDriver, TOKEN, host.via),
                read: async () => await harness.run(async (ctx: any) => await ctx.runQuery(getWatchForPoll, { watchId })),
                record: async (outcome) => await harness.run(async (ctx: any) => await ctx.runMutation(recordRepoPoll, { lease, outcome, watchId })),
            },
            lease,
        );
    }

    return host.calls.length - before;
};

describe("an unchanged list", () => {
    it("costs one conditional request per poll, and changes nothing", async () => {
        const host = fakeHost();

        await watch();

        // The first poll reads the login and the list in full, and stores the validator.
        expect(await tick(host, NOW)).toBe(2);
        expect(host.calls.map((call) => call.path)).toEqual(["/user", "/repos/octo/hello/pulls"]);

        const first = await rowOf();

        expect(first).toMatchObject({ etag: 'W/"1"', lastStatus: "ok", leasedAt: 0, login: "me", seeded: true });
        expect(first.requested.map((entry: { number: number }) => entry.number)).toEqual([1]);

        // Every later poll of the unchanged list: ONE request, carrying the ETag, answered 304.
        for (let poll = 1; poll <= 3; poll += 1) {
            expect(await tick(host, NOW + poll * POLL_INTERVAL_MS)).toBe(1);
        }

        expect(host.calls.slice(2).every((call) => call.path === "/repos/octo/hello/pulls" && call.ifNoneMatch === 'W/"1"')).toBe(true);

        const after = await rowOf();

        expect(after.requested).toEqual(first.requested);
        expect(after.etag).toBe(first.etag);
        expect(after.checkedAt).toBe(NOW + 3 * POLL_INTERVAL_MS);
        expect(await notices()).toEqual([]);
    });

    it("is read again in full once the host's list changes", async () => {
        const host = fakeHost();

        await watch();
        await tick(host, NOW);
        host.change([pull(1), pull(2)]);

        expect(await tick(host, NOW + POLL_INTERVAL_MS)).toBe(1);
        expect((await rowOf()).requested.map((entry: { number: number }) => entry.number)).toEqual([1, 2]);
        expect((await rowOf()).etag).toBe('W/"2"');
    });

    it("is not dispatched before it is due, and not twice for one due time", async () => {
        const host = fakeHost();

        await watch();
        await tick(host, NOW);

        expect(await tick(host, NOW + POLL_INTERVAL_MS - 1)).toBe(0);

        advance(NOW + POLL_INTERVAL_MS);
        await harness.run(async (ctx: any) => {
            await ctx.runMutation(dispatchDueRepoPolls, {});
            await ctx.runMutation(dispatchDueRepoPolls, {});
        });

        expect(harness.scheduler.list().filter((job) => job.args.lease === NOW + POLL_INTERVAL_MS)).toHaveLength(1);
    });
});

describe("a repository the user stops watching", () => {
    it("is never polled again", async () => {
        const host = fakeHost();

        await watch();
        await tick(host, NOW);
        await as(USER).mutation(unwatchRepo as never, { repository: REPO } as never);

        const asked = host.calls.length;

        for (let poll = 1; poll <= 3; poll += 1) {
            expect(await tick(host, NOW + poll * 2 * POLL_INTERVAL_MS)).toBe(0);
        }

        expect(host.calls).toHaveLength(asked);
        expect(await rowOf()).toBeUndefined();
    });

    it("records nothing for a poll that was already in flight", async () => {
        const host = fakeHost();

        await watch();
        advance(NOW);
        await harness.run(async (ctx: any) => await ctx.runMutation(dispatchDueRepoPolls, {}));

        const [job] = harness.scheduler.list();
        const { lease, watchId } = job!.args as { lease: number; watchId: string };

        await as(USER).mutation(unwatchRepo as never, { repository: REPO } as never);
        noteShardDue.mockClear();

        // The action wakes up after the unwatch: it finds no row and asks the host nothing.
        const ran = await runRepoPoll(
            {
                fetch: hostPoll(githubDriver, TOKEN, host.via),
                read: async () => await harness.run(async (ctx: any) => await ctx.runQuery(getWatchForPoll, { watchId })),
                record: async () => {
                    throw new Error("nothing is recorded for an unwatched repository");
                },
            },
            lease,
        );

        expect(ran).toEqual({ fetched: false });
        expect(host.calls).toEqual([]);

        // And an answer that does arrive late is dropped: no row, no notification, no re-arming.
        const late = await harness.run(
            async (ctx: any) =>
                await ctx.runMutation(recordRepoPoll, {
                    lease,
                    outcome: { etag: 'W/"9"', kind: "changed", login: "me", requested: [{ authorLogin: "a", number: 5, title: "T", updatedAt: 1, url: "https://github.com/o/r/pull/5" }] },
                    watchId,
                }),
        );

        expect(late).toEqual({ applied: false, notified: 0 });
        expect(await notices()).toEqual([]);
        expect(noteShardDue).not.toHaveBeenCalled();
    });

    it("drops a poll whose lease a newer poll took over", async () => {
        await watch();
        advance(NOW);
        await harness.run(async (ctx: any) => await ctx.runMutation(dispatchDueRepoPolls, {}));

        const { args } = harness.scheduler.list()[0] as unknown as { args: { lease: number; watchId: string } };

        // The first poll never reported; its lease lapsed and the repository was dispatched again.
        advance(NOW + POLL_LEASE_MS + 1);
        await harness.run(async (ctx: any) => await ctx.runMutation(dispatchDueRepoPolls, {}));

        const stale = await harness.run(
            async (ctx: any) => await ctx.runMutation(recordRepoPoll, { lease: args.lease, outcome: { kind: "not_modified" }, watchId: args.watchId }),
        );

        expect(stale.applied).toBe(false);
    });
});

describe("a review request", () => {
    const BASELINE = [pull(1)];

    it("notifies once, however many polls and records see it", async () => {
        const host = fakeHost();

        await watch();
        await tick(host, NOW);
        // The baseline poll told nobody about the request that was already there.
        expect(await notices()).toEqual([]);

        host.change([...BASELINE, pull(2, { title: "Please look" })]);
        await tick(host, NOW + POLL_INTERVAL_MS);

        const [notice, ...rest] = await notices();

        expect(rest).toEqual([]);
        expect(notice).toMatchObject({ body: "octo/hello#2 · alice", title: "Please look", type: "review_request", userId: USER });
        expect(notice.link).toBe("/develop?repository=octo%2Fhello&number=2");

        // The unchanged list, a changed one that still holds the request, and the same answer recorded again: nothing new.
        await tick(host, NOW + 2 * POLL_INTERVAL_MS);
        host.change([...BASELINE, pull(2, { title: "Please look" }), pull(3, { requested_reviewers: [{ login: "someone" }] })]);
        await tick(host, NOW + 3 * POLL_INTERVAL_MS);

        expect(await notices()).toHaveLength(1);
    });

    it("notifies again when the same pull request asks a second time", async () => {
        const host = fakeHost();

        await watch();
        await tick(host, NOW);
        host.change([...BASELINE, pull(2)]);
        await tick(host, NOW + POLL_INTERVAL_MS);
        // The reviewer reviewed: it leaves the list. Then it is requested again, later.
        host.change(BASELINE);
        await tick(host, NOW + 2 * POLL_INTERVAL_MS);
        host.change([...BASELINE, pull(2, { updated_at: "2026-10-05T10:00:00Z" })]);
        await tick(host, NOW + 3 * POLL_INTERVAL_MS);

        expect(await notices()).toHaveLength(2);
    });

    it("writes one row when the same answer is recorded twice under two leases", async () => {
        await watch();
        await harness.run(async (ctx: any) => {
            const [row] = await ctx.db.query("watchedRepositories").collect();

            await ctx.db.patch(row._id, { seeded: true });
        });

        const request = { authorLogin: "alice", number: 4, title: "T", updatedAt: 77, url: "https://github.com/octo/hello/pull/4" };
        const record = async (at: number): Promise<{ applied: boolean; notified: number }> => {
            advance(at);
            await harness.run(async (ctx: any) => await ctx.runMutation(dispatchDueRepoPolls, {}));

            const job = harness.scheduler.list().at(-1)!.args as { lease: number; watchId: string };

            return await harness.run(
                async (ctx: any) =>
                    await ctx.runMutation(recordRepoPoll, {
                        lease: job.lease,
                        outcome: { etag: null, kind: "changed", login: "me", requested: [request] },
                        watchId: job.watchId,
                    }),
            );
        };

        expect((await record(NOW)).notified).toBe(1);
        // The list was lost (an older snapshot restored): the same request enters again with the same version.
        await harness.run(async (ctx: any) => {
            const [row] = await ctx.db.query("watchedRepositories").collect();

            await ctx.db.patch(row._id, { requested: [] });
        });
        expect((await record(NOW + POLL_INTERVAL_MS)).notified).toBe(0);
        expect(await notices()).toHaveLength(1);
    });

    it("does not notify for a draft or for a request addressed to somebody else", async () => {
        const host = fakeHost();

        await watch();
        await tick(host, NOW);
        host.change([pull(1), pull(5, { draft: true }), pull(6, { requested_reviewers: [{ login: "someone" }] })]);
        await tick(host, NOW + POLL_INTERVAL_MS);

        expect(await notices()).toEqual([]);
    });
});

describe("a webhook", () => {
    const SECRET_HEADER = "x-hub-signature-256";

    const hmac = async (secret: string, body: string): Promise<string> => {
        const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { hash: "SHA-256", name: "HMAC" }, false, ["sign"]);
        const signed = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body));

        return `sha256=${[...new Uint8Array(signed)].map((byte) => byte.toString(16).padStart(2, "0")).join("")}`;
    };

    /** The handler's context: its queries and mutations run on the harness's copy of the procedures. */
    const context = {
        runMutation: async (reference: unknown, args: unknown) => await harness.run(async (ctx: any) => await ctx.runMutation(reference, args)),
        runQuery: async (reference: unknown, args: unknown) => await harness.run(async (ctx: any) => await ctx.runQuery(reference, args)),
    };

    const deliver = async (watchId: string, body: string, signature: string | null): Promise<Response> =>
        await handleWatchWebhook(
            context as never,
            new Request(`https://x/source-control/webhook/${watchId}`, { body, headers: signature === null ? {} : { [SECRET_HEADER]: signature }, method: "POST" }),
            watchId,
        );

    const enable = async (): Promise<{ id: string; secret: string }> => {
        await watch();

        const issued: any = await as(USER).mutation(enableWatchWebhook as never, { repository: REPO } as never);

        expect(issued.status).toBe("ok");

        return { id: issued.id, secret: issued.secret };
    };

    it("marks the repository dirty and changes nothing else, whatever the body claims", async () => {
        const host = fakeHost();
        const { id, secret } = await enable();

        await tick(host, NOW);

        const before = await rowOf();
        // A signed body that claims a new request on another repository, and a review request for the user.
        const body = JSON.stringify({
            action: "review_requested",
            pull_request: { number: 99, requested_reviewer: { login: "me" }, title: "FORGED" },
            repository: { full_name: "evil/other" },
        });

        advance(NOW + 1000);

        const response = await deliver(id, body, await hmac(secret, body));
        const after = await rowOf();

        expect(response.status).toBe(202);
        expect(after.dirtyAt).toBe(NOW + 1000);
        expect(after.webhookSeenAt).toBe(NOW + 1000);
        expect(after.nextPollAt).toBe(NOW + 1000);
        // Everything the poll owns is exactly as it was: the claim in the body never reached the cache or the inbox.
        expect({ ...after, dirtyAt: 0, nextPollAt: 0, webhookSeenAt: 0 }).toEqual({ ...before, dirtyAt: 0, nextPollAt: 0, webhookSeenAt: 0 });
        expect(after.requested).toEqual(before.requested);
        expect(JSON.stringify(await rowOf())).not.toContain("FORGED");
        expect(await notices()).toEqual([]);
        expect(host.calls).toHaveLength(2);
        expect(noteShardDue).toHaveBeenCalledWith(expect.anything(), NOW + 1000, USER);
    });

    it("makes the next tick poll, which reads what changed from the host", async () => {
        const host = fakeHost();
        const { id, secret } = await enable();

        await tick(host, NOW);
        host.change([pull(1), pull(2)]);

        const body = "{}";

        advance(NOW + 5000);
        await deliver(id, body, await hmac(secret, body));

        // Due now, not in five minutes; and the answer is what the host says, not the delivery.
        expect(await tick(host, NOW + 5000)).toBe(1);
        expect((await rowOf()).requested.map((entry: { number: number }) => entry.number)).toEqual([1, 2]);
        expect((await rowOf()).dirtyAt).toBe(0);
        expect(await notices()).toHaveLength(1);
    });

    it("polls less often while it is being heard from, and still polls", async () => {
        const host = fakeHost();
        const { id, secret } = await enable();

        advance(NOW);
        await deliver(id, "{}", await hmac(secret, "{}"));
        await tick(host, NOW);

        expect((await rowOf()).nextPollAt).toBe(NOW + POLL_INTERVAL_WITH_WEBHOOK_MS);
        expect(await tick(host, NOW + POLL_INTERVAL_WITH_WEBHOOK_MS)).toBe(1);
    });

    it("refuses a bad or missing signature and a body signed with another secret, and touches nothing", async () => {
        const { id, secret } = await enable();
        const body = "{}";
        const before = await rowOf();

        expect((await deliver(id, body, null)).status).toBe(401);
        expect((await deliver(id, body, "sha256=nothex")).status).toBe(401);
        expect((await deliver(id, body, await hmac("another secret", body))).status).toBe(401);
        expect((await deliver(id, body, await hmac(secret, "a different body"))).status).toBe(401);
        expect(await rowOf()).toEqual(before);
    });

    it("answers 404 for a repository without a webhook or that does not exist", async () => {
        await watch();

        const row = await rowOf();

        expect((await deliver(row._id, "{}", await hmac("x", "{}"))).status).toBe(404);
        expect((await deliver("not-an-id", "{}", await hmac("x", "{}"))).status).toBe(404);
    });

    it("accepts a signature once: a replay is answered but claims nothing new", async () => {
        const { id, secret } = await enable();
        const signature = await hmac(secret, "{}");

        expect((await deliver(id, "{}", signature)).status).toBe(202);

        // A poll clears the mark; the replay must not set it again.
        await harness.run(async (ctx: any) => await ctx.db.patch(id, { dirtyAt: 0 }));
        advance(NOW + 1000);

        const replay = await deliver(id, "{}", signature);

        expect(replay.status).toBe(200);
        expect((await rowOf()).dirtyAt).toBe(0);
    });

    it("looks again at once when it arrives during a poll", async () => {
        const host = fakeHost();
        const { id, secret } = await enable();

        advance(NOW);
        await harness.run(async (ctx: any) => await ctx.runMutation(dispatchDueRepoPolls, {}));

        const { lease, watchId } = harness.scheduler.list().at(-1)!.args as { lease: number; watchId: string };

        advance(NOW + 100);
        await deliver(id, "{}", await hmac(secret, "{}"));
        // The lease stays with the poll in flight; the delivery does not start a second one.
        expect((await rowOf()).nextPollAt).toBe(NOW + POLL_LEASE_MS);

        advance(NOW + 200);
        await harness.run(
            async (ctx: any) => await ctx.runMutation(recordRepoPoll, { lease, outcome: { kind: "not_modified" }, watchId }),
        );

        expect(await rowOf()).toMatchObject({ dirtyAt: NOW + 100, nextPollAt: NOW + 200 });
        expect(host.calls).toEqual([]);
    });

    it("stores the secret encrypted and returns it only when it is issued", async () => {
        const { id, secret } = await enable();
        const stored = (await rowOf()).webhookSecret as string;
        const listed = JSON.stringify(await as(USER).query(listWatchedRepositories as never, {} as never));

        expect(stored.startsWith("v1:")).toBe(true);
        expect(stored).not.toContain(secret);
        expect(listed).not.toContain(secret);
        expect(listed).not.toContain(stored);
        expect(JSON.parse(listed).watched[0]).toMatchObject({ id, webhook: { enabled: true } });

        await as(USER).mutation(disableWatchWebhook as never, { repository: REPO } as never);

        expect((await rowOf()).webhookSecret).toBeUndefined();
        expect((await harness.run(async (ctx: any) => await ctx.runQuery(getWatchForWebhook, { watchId: id }))) ?? null).toBeNull();
        expect((await deliver(id, "{}", await hmac(secret, "{}"))).status).toBe(404);
    });
});

describe("watching", () => {
    it("is the caller's own: another user's row is invisible and cannot be removed", async () => {
        await watch(REPO, USER);

        expect((await as(OTHER).query(listWatchedRepositories as never, {} as never) as any).watched).toEqual([]);
        expect(await as(OTHER).mutation(unwatchRepo as never, { repository: REPO } as never)).toEqual({ removed: false });
        expect(await rowOf()).toBeDefined();
    });

    it("takes one row per repository whatever its case, validates the address and stops at the cap", async () => {
        await watch("octo/hello");
        await watch("Octo/Hello");

        expect(await harness.run(async (ctx: any) => await ctx.db.query("watchedRepositories").collect())).toHaveLength(1);
        expect(await as(USER).mutation(watchRepo as never, { repository: "not a repo" } as never)).toEqual({ status: "invalid" });
        expect(await as(USER).mutation(watchRepo as never, { repository: "../../x/y" } as never)).toEqual({ status: "invalid" });

        for (let index = 0; index < 25; index += 1) {
            await watch(`octo/repo-${String(index)}`);
        }

        expect(await harness.run(async (ctx: any) => await ctx.db.query("watchedRepositories").collect())).toHaveLength(20);
        expect(await as(USER).mutation(watchRepo as never, { repository: "octo/one-more" } as never)).toEqual({ status: "limit" });
    });

    it("arms the shard so the first poll happens at the next tick", async () => {
        await watch();

        expect(await rowOf()).toMatchObject({ nextPollAt: NOW, seeded: false });
        expect(noteShardDue).toHaveBeenCalledWith(expect.anything(), NOW, USER);
    });
});

describe("refresh on open", () => {
    it("leases only what was not checked a moment ago and is not already being polled", async () => {
        const host = fakeHost();

        await watch("octo/hello");
        await watch("octo/second");
        await tick(host, NOW);
        advance(NOW + 5000);

        const fresh = await harness.run(async (ctx: any) => await ctx.runMutation(leaseWatchedRepositoriesForRefresh, { userId: USER }));

        expect(fresh).toEqual([]);

        advance(NOW + 60_000);

        const leased = await harness.run(async (ctx: any) => await ctx.runMutation(leaseWatchedRepositoriesForRefresh, { userId: USER }));
        const again = await harness.run(async (ctx: any) => await ctx.runMutation(leaseWatchedRepositoriesForRefresh, { userId: USER }));

        expect(leased).toHaveLength(2);
        expect(again).toEqual([]);
    });

    it("also leases a repository a webhook marked dirty", async () => {
        const host = fakeHost();
        const { id } = await (async () => {
            await watch();

            return { id: (await rowOf())._id as string };
        })();

        await tick(host, NOW);
        advance(NOW + 1000);
        await harness.run(async (ctx: any) => await ctx.db.patch(id, { dirtyAt: NOW + 900 }));

        expect(await harness.run(async (ctx: any) => await ctx.runMutation(leaseWatchedRepositoriesForRefresh, { userId: USER }))).toHaveLength(1);
    });
});

describe("a host that cannot be read", () => {
    it("keeps the cache, says why, and waits longer before asking again", async () => {
        const host = fakeHost();

        await watch();
        await tick(host, NOW);

        host.fail(403);
        advance(NOW + POLL_INTERVAL_MS);
        await harness.run(async (ctx: any) => await ctx.runMutation(dispatchDueRepoPolls, {}));

        const { lease, watchId } = harness.scheduler.list().at(-1)!.args as { lease: number; watchId: string };

        await runRepoPoll(
            {
                fetch: hostPoll(githubDriver, TOKEN, host.via),
                read: async () => await harness.run(async (ctx: any) => await ctx.runQuery(getWatchForPoll, { watchId })),
                record: async (outcome) => await harness.run(async (ctx: any) => await ctx.runMutation(recordRepoPoll, { lease, outcome, watchId })),
            },
            lease,
        );

        const row = await rowOf();

        expect(row.lastStatus).toBe("rate_limited");
        expect(row.requested).toHaveLength(1);
        expect(row.etag).toBe('W/"1"');
        expect(row.nextPollAt).toBeGreaterThan(NOW + POLL_INTERVAL_MS + POLL_INTERVAL_MS);
    });
});

describe("acceptWatchDelivery", () => {
    it("is not found for a row without a webhook", async () => {
        await watch();

        const row = await rowOf();

        expect(await harness.run(async (ctx: any) => await ctx.runMutation(acceptWatchDelivery, { signature: "a".repeat(64), watchId: row._id }))).toBe("not_found");
    });
});
