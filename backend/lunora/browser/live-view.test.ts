/**
 * Watching the agent's cloud browser: who gets the running browser's status and a live view URL, and that a browser
 * that ended (closed, idle past the provider's reap, or gone at the provider) gives neither.
 */
import { lunoraTest } from "@lunora/testing";
import { v } from "lunorash/server";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import type { Id } from "../_generated/dataModel";
import { registeredApi, registerModule } from "../../test/registered-api";
import { applyLimit } from "../lib/rate-limiter-mutations";
import { internalMutation, internalQuery } from "../lib/crpc";
import schema from "../schema";
import { getBrowserActions } from "../chat/functions";
import { logAction } from "./functions";
import { controlHolder, getThreadBrowser, handBack, keepControl, navigateInControl, openLiveView, takeControl } from "./live-view";
import { releaseControlHttpAction } from "./release-http";
import { runInShard } from "../lib/shard-context";
import { releaseTokenFor } from "./release-token";
import { BROWSER_IDLE_REAP_MS, browserIdOf, BROWSER_REAP_MARGIN_MS, CONTROL_IDLE_MS, RENDERER_CALL_SETTLE_MS, rendererCallHold } from "./live-view-logic";

const OWNER = "user-owner";
const READER = "user-reader";
const STRANGER = "user-stranger";
const WRITER = "user-writer";
/** The frozen clock every test reads, in the code and in the assertions alike. */
const NOW = Date.UTC(2026, 10, 20, 12);
/** The provider session ids the tests use: a browser name a client sees must hold neither. */
const PROVIDER_SESSION_ID = /s-[12]/u;
/** What a lease's holder looks like on the row: a SHA-256 HMAC in hex. */
const HOLDER = /^[\da-f]{64}$/u;
/** A claim's public name in the status: a truncated SHA-256 in hex. */
const CLAIM_ID = /^[\da-f]{32}$/u;
/** The backend's signing secret: the key of a lease's opaque holder. */
const SIGNING_SECRET = "browser-control-test-secret";
const VIEW_URL = "https://live.browser.run/ui/view?mode=tab&wss=live.browser.run/api/devtools/browser/s-1?jwt=signed";

const { config, impersonation, registry, sessionFrom } = vi.hoisted(() => {
    // Set while a test acts as an admin impersonating the signed-in user.
    const state: { by?: string } = {};

    return {
        config: { accountId: "account-1", token: "token-1" },
        impersonation: state,
        registry: new Map<string, unknown>(),
        sessionFrom: async (context: { auth: { userId?: string | null } }) =>
            context.auth.userId
                ? { activeOrganization: null, id: context.auth.userId, impersonatedBy: state.by, isAdmin: false, userId: context.auth.userId }
                : null,
    };
});

vi.mock("../_generated/api", async (importOriginal) => registeredApi(await importOriginal(), registry));
vi.mock("../_generated/internal", async (importOriginal) => registeredApi(await importOriginal(), registry));

vi.mock("../env", async (importOriginal) => {
    const original = await importOriginal<typeof import("../env")>();

    return {
        ...original,
        get BROWSER_LIVE_VIEW_API_TOKEN() {
            return config.token;
        },
        get CLOUDFLARE_ACCOUNT_ID() {
            return config.accountId;
        },
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

// A read replica that still holds a grant the primary no longer has: every grant read that does not ask for the
// primary gets `replica.grant` while it is set, the way a lagging replica answers after an admin removed a reader.
const { replica } = vi.hoisted(() => {
    return { replica: {} as { grant?: Record<string, unknown> } };
});

vi.mock("../agent/thread-read-access", async (importOriginal) => {
    const original = await importOriginal<typeof import("../agent/thread-read-access")>();
    const lagging = (context: any): any => {
        const findFirst = async (query: { consistency?: string }) =>
            query.consistency !== "primary" && replica.grant !== undefined ? replica.grant : await context.db.threadAccess.findFirst(query);
        const db = new Proxy(context.db, {
            get: (target, key) =>
                key === "threadAccess"
                    ? new Proxy(target.threadAccess, { get: (table, name) => (name === "findFirst" ? findFirst : table[name]) })
                    : target[key],
        });

        return new Proxy(context, { get: (target, key) => (key === "db" ? db : target[key]) });
    };

    return {
        ...original,
        resolveThreadReadAccess: async (context: any, ...rest: Parameters<typeof original.resolveThreadReadAccess> extends [unknown, ...infer R] ? R : never) =>
            await original.resolveThreadReadAccess(lagging(context), ...rest),
    };
});

const { actionStart, renderer, rendererStart } = vi.hoisted(() => {
    // `rendererStart` runs when a renderer call is about to start: a test makes the call start late with it.
    // `actionStart` runs as `navigateInControl` begins, after the action's own clock was read.
    return { actionStart: { hook: undefined as (() => void) | undefined }, renderer: vi.fn(), rendererStart: { hook: undefined as (() => void) | undefined } };
});

vi.mock("../lib/services", async (importOriginal) => {
    return {
        ...(await importOriginal<typeof import("../lib/services")>()),
        isServiceBound: () => {
            actionStart.hook?.();

            return true;
        },
        serviceFetch: () => fetch,
    };
});

vi.mock("@neore/service-sdk/browser-renderer", async (importOriginal) => {
    const original = await importOriginal<typeof import("@neore/service-sdk/browser-renderer")>();

    return {
        ...original,
        browserAction: renderer,
        createBrowserRendererClient: (...options: Parameters<typeof original.createBrowserRendererClient>) => {
            rendererStart.hook?.();

            return original.createBrowserRendererClient(...options);
        },
    };
});

// The release route crosses to the shard its token names as the system: here, straight into the harness, and the
// shard it asked for is kept for the test to check.
const { releaseLimit, releaseShards } = vi.hoisted(() => {
    return { releaseLimit: { down: false, keys: [] as string[], limited: false }, releaseShards: [] as string[] };
});

vi.mock("../lib/http-shard", async (importOriginal) => {
    return {
        ...(await importOriginal<typeof import("../lib/http-shard")>()),
        inSystemShard: async (_context: unknown, shardKey: string, handler: (context: unknown) => Promise<unknown>) => {
            releaseShards.push(shardKey);

            return await handler({
                runMutation: async (reference: unknown, args: unknown) => await harness.run(async (ctx: any) => await ctx.runMutation(reference, args)),
            });
        },
    };
});

vi.mock("../lib/rate-limiter", async (importOriginal) => {
    return {
        ...(await importOriginal<typeof import("../lib/rate-limiter")>()),
        // The release route's per-address limit: `releaseLimit.limited` refuses it, and `down` is a limiter outage, answered as
        // the caller's `failMode` says (closed unless it asks for open).
        checkRateLimit: async (_context: unknown, _operation: string, options?: { failMode?: "closed" | "open"; key?: string }) => {
            releaseLimit.keys.push(options?.key ?? "");

            if (releaseLimit.down) {
                return { ok: options?.failMode === "open" };
            }

            return { ok: !releaseLimit.limited };
        },
        rateLimitGuard: async () => undefined,
    };
});

let harness: ReturnType<typeof lunoraTest>;
let threadId: string;
const fetchMock = vi.fn();

const as = (userId: string) => harness.withIdentity({ userId } as never);
const statusFor = async (userId: string): Promise<unknown> => await as(userId).query(getThreadBrowser as never, { threadId } as never);
const open = async (userId: string): Promise<any> => await as(userId).action(openLiveView as never, { threadId } as never);
/** The claim the lease holds now, as the person's newest view got it from `takeControl`. */
const heldClaim = async (): Promise<string> =>
    ((await harness.run(async (ctx: any) => await ctx.db.query("browserSessions").first())) as any)?.control?.claim ?? "none";
const keep = async (userId: string, claim?: string): Promise<any> =>
    await as(userId).mutation(keepControl as never, { claim: claim ?? (await heldClaim()), threadId } as never);
const giveBack = async (userId: string, reason: "handed_back" | "left", claim?: string): Promise<unknown> =>
    await as(userId).mutation(handBack as never, { claim: claim ?? (await heldClaim()), reason, threadId } as never);

const addSession = async (fields: Record<string, unknown> = {}): Promise<string> =>
    (await harness.run(
        async (ctx: any) =>
            await ctx.db.insert("browserSessions", {
                currentUrl: "https://example.com/login",
                lastActivityAt: NOW,
                providerSessionId: "s-1",
                source: "browserbase",
                startedAt: NOW,
                status: "active",
                threadId,
                userId: OWNER,
                ...fields,
            }),
    )) as string;

const answer = (status: number, body: unknown): Response => Response.json(body, { status });

/**
 * A lease as the tests read it: `by` holds an opaque holder, never a user id, so it is named back here by the person whose
 * holder it is (`unknown` for any other value: a raw id on the row would read as that).
 */
const named = async (control: any): Promise<any> => {
    if (control === undefined) {
        return undefined;
    }

    const session = await harness.run(async (ctx: any) => await ctx.db.query("browserSessions").first());
    const sessionId = (session as { _id: Id<"browserSessions"> })._id;

    for (const userId of [OWNER, READER, STRANGER, WRITER]) {
        if (control.by === (await controlHolder(sessionId, userId))) {
            return { ...control, by: userId };
        }
    }

    return { ...control, by: "unknown" };
};

beforeAll(async () => {
    registerModule(registry, "agent_threads", await import("../agent/threads"));
    registerModule(registry, "browser_functions", await import("./functions"));
    registerModule(registry, "browser_live_view", await import("./live-view"));
    registerModule(registry, "lib_rate_limiter_mutations", await import("../lib/rate-limiter-mutations"));
}, 30_000);

beforeEach(async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW);
    vi.stubEnv("STORAGE_SIGNING_SECRET", SIGNING_SECRET);
    harness = lunoraTest(schema as never);
    config.accountId = "account-1";
    config.token = "token-1";
    fetchMock.mockResolvedValue(answer(200, { devtoolsFrontendUrl: VIEW_URL, id: "v-1" }));
    vi.stubGlobal("fetch", fetchMock);
    threadId = (await harness.run(async (ctx: any) => {
        const id = await ctx.db.insert("threads", { status: "active", title: "T", userId: OWNER });

        await ctx.db.insert("threadAccess", { grantedAt: 0, grantedBy: OWNER, permission: "read", threadId: id, userId: READER });
        await ctx.db.insert("threadAccess", { grantedAt: 0, grantedBy: OWNER, permission: "write", threadId: id, userId: WRITER });

        return id;
    })) as string;
});

afterEach(() => {
    releaseShards.length = 0;
    releaseLimit.down = false;
    releaseLimit.keys.length = 0;
    releaseLimit.limited = false;
    delete replica.grant;
    impersonation.by = undefined;
    actionStart.hook = undefined;
    rendererStart.hook = undefined;
    vi.restoreAllMocks();
    harness.close();
    fetchMock.mockReset();
    renderer.mockReset();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    vi.useRealTimers();
});

describe("a running browser", () => {
    it("shows the owner and a reader where it is, and mints them a read-only view", async () => {
        await addSession();

        await expect(statusFor(OWNER)).resolves.toMatchObject({ currentUrl: "https://example.com/login" });
        await expect(statusFor(READER)).resolves.toMatchObject({ currentUrl: "https://example.com/login" });
        await expect(open(READER)).resolves.toMatchObject({ status: "ok", url: VIEW_URL });

        const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];

        expect(url).toBe("https://api.cloudflare.com/client/v4/accounts/account-1/browser-rendering/devtools/browser/s-1/live_view");
        expect(JSON.parse(init.body as string)).toMatchObject({ guardrails: { mode: "readonly" } });
    });

    it("gives a caller who cannot read the thread no status and no URL, and never asks the provider", async () => {
        await addSession();

        await expect(statusFor(STRANGER)).resolves.toBeNull();
        await expect(open(STRANGER)).rejects.toMatchObject({ code: "NOT_FOUND" });
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it("gives nothing for a locked thread, even to its owner", async () => {
        await addSession();
        await harness.run(async (ctx: any) => await ctx.db.patch("threads", threadId, { lockedAt: 1 }));

        await expect(statusFor(OWNER)).resolves.toBeNull();
        await expect(open(OWNER)).rejects.toMatchObject({ code: "NOT_FOUND" });
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it("gives nothing for a trashed thread, to its owner or a reader", async () => {
        await addSession();
        await harness.run(async (ctx: any) => await ctx.db.patch("threads", threadId, { deleted: true }));

        await expect(statusFor(OWNER)).resolves.toBeNull();
        await expect(statusFor(READER)).resolves.toBeNull();
        await expect(open(READER)).resolves.toEqual({ status: "ended" });
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it("stays watchable while an action holds it past the idle window, until the action's deadline", async () => {
        const heldUntil = NOW + 30_000;

        await addSession({ inUseHolds: [heldUntil], lastActivityAt: NOW - BROWSER_IDLE_REAP_MS - 1000 });

        await expect(statusFor(OWNER)).resolves.toEqual({
            browserId: expect.any(String),
            canControl: true,
            currentUrl: "https://example.com/login",
            idleUntil: heldUntil,
            // The server's clock, so a client tells a lease's end without a clock of its own.
            now: NOW,
        });
        await expect(open(OWNER)).resolves.toMatchObject({ status: "ok" });
    });

    it("tells a reader when their grant ends, and shows them nothing once it has", async () => {
        const expiresAt = NOW + 10_000;

        await addSession();
        await harness.run(async (ctx: any) => {
            const grant = await ctx.db.threadAccess.findFirst({ where: { threadId, userId: READER } });

            await ctx.db.patch("threadAccess", grant._id, { expiresAt });
        });

        await expect(statusFor(READER)).resolves.toMatchObject({ accessUntil: expiresAt });
        // The owner's access does not end.
        await expect(statusFor(OWNER)).resolves.not.toHaveProperty("accessUntil");

        vi.setSystemTime(expiresAt + 1);

        await expect(statusFor(READER)).resolves.toBeNull();
        await expect(open(READER)).rejects.toMatchObject({ code: "NOT_FOUND" });
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it("mints no view for a reader an admin removed, while a replica still holds their grant", async () => {
        await addSession();
        await harness.run(async (ctx: any) => {
            const grant = await ctx.db.threadAccess.findFirst({ where: { threadId, userId: READER } });

            replica.grant = grant;
            await ctx.db.delete("threadAccess", grant._id);
        });

        await expect(open(READER)).rejects.toMatchObject({ code: "NOT_FOUND" });
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it("returns no URL to a reader whose grant was removed while the provider minted it", async () => {
        await addSession();
        fetchMock.mockImplementation(async () => {
            await harness.run(async (ctx: any) => {
                const grant = await ctx.db.threadAccess.findFirst({ where: { threadId, userId: READER } });

                await ctx.db.delete("threadAccess", grant._id);
            });

            return answer(200, { devtoolsFrontendUrl: VIEW_URL, id: "v-1" });
        });

        await expect(open(READER)).rejects.toMatchObject({ code: "NOT_FOUND" });
        expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it("returns no URL when the chat was trashed while the provider minted it", async () => {
        await addSession();
        fetchMock.mockImplementation(async () => {
            await harness.run(async (ctx: any) => await ctx.db.patch("threads", threadId, { deleted: true }));

            return answer(200, { devtoolsFrontendUrl: VIEW_URL, id: "v-1" });
        });

        await expect(open(OWNER)).resolves.toEqual({ status: "ended" });
    });

    it("returns no URL when an agent action replaced the browser while the provider minted it", async () => {
        const sessionId = await addSession();

        fetchMock.mockImplementation(async () => {
            await harness.run(async (ctx: any) => await ctx.db.patch("browserSessions", sessionId, { providerSessionId: "s-2" }));

            return answer(200, { devtoolsFrontendUrl: VIEW_URL, id: "v-1" });
        });

        await expect(open(OWNER)).resolves.toEqual({ status: "ended" });
    });

    it("returns no URL when the chat was locked while the provider minted it", async () => {
        await addSession();
        fetchMock.mockImplementation(async () => {
            await harness.run(async (ctx: any) => await ctx.db.patch("threads", threadId, { lockedAt: 1 }));

            return answer(200, { devtoolsFrontendUrl: VIEW_URL, id: "v-1" });
        });

        await expect(open(OWNER)).rejects.toMatchObject({ code: "NOT_FOUND" });
    });

    it("refuses a view URL that does not point at the live view host", async () => {
        await addSession();
        fetchMock.mockResolvedValue(answer(200, { devtoolsFrontendUrl: "https://evil.example/ui/view" }));

        await expect(open(OWNER)).resolves.toEqual({ status: "unavailable" });
    });

    it("is unavailable without the platform token, without asking the provider", async () => {
        await addSession();
        config.token = "";

        await expect(open(OWNER)).resolves.toEqual({ status: "unavailable" });
        expect(fetchMock).not.toHaveBeenCalled();
    });
});

describe("an agent action", () => {
    const sessionRow = async (sessionId: string) =>
        (await harness.run(async (ctx: any) => await ctx.db.get("browserSessions", sessionId))) as {
            currentUrl?: string;
            inUseHolds?: number[];
            lastActivityAt: number;
            providerSessionId: string;
        };
    const log = async (args: Record<string, unknown>): Promise<void> =>
        await harness.run(
            async (ctx: any) => await ctx.runMutation(logAction, { startedAt: NOW, startedWithProviderSessionId: "s-1", success: true, ...args }),
        );

    it("ends a hold in the list it was taken in, also beside another action's hold with the same deadline", async () => {
        const sessionId = await addSession({ inUseHolds: [NOW + 20_000], reapedHolds: [NOW + 20_000] });

        await log({ action: "click", heldReaped: true, heldUntil: NOW + 20_000, sessionId });
        await expect(sessionRow(sessionId)).resolves.toMatchObject({ inUseHolds: [NOW + 20_000] });
        await expect(sessionRow(sessionId)).resolves.not.toHaveProperty("reapedHolds");

        await log({ action: "click", heldUntil: NOW + 20_000, sessionId });
        await expect(sessionRow(sessionId)).resolves.not.toHaveProperty("inUseHolds");
    });

    it("keeps the browser watchable past the idle window it started in, and records the page it left it on", async () => {
        const sessionId = await addSession({ lastActivityAt: NOW - BROWSER_IDLE_REAP_MS + 1000 });

        await log({ action: "navigate", currentUrl: "https://example.com/next", sessionId });

        expect(await sessionRow(sessionId)).toMatchObject({ currentUrl: "https://example.com/next", lastActivityAt: NOW });
    });

    it("ends only its own hold: an action still running keeps the browser held", async () => {
        const sessionId = await addSession({ inUseHolds: [NOW + 20_000, NOW + 30_000] });

        await log({ action: "click", heldUntil: NOW + 20_000, sessionId });

        const row = await sessionRow(sessionId);

        expect(row.inUseHolds).toEqual([NOW + 30_000]);
    });

    it("forgets the old browser's page when the renderer replaced the browser", async () => {
        const sessionId = await addSession();

        await log({ action: "scroll", providerSessionId: "s-2", sessionId });

        const row = await sessionRow(sessionId);

        expect(row.providerSessionId).toBe("s-2");
        expect(row.currentUrl).toBeUndefined();
    });

    it("names the replacement as another browser, without the provider's session id, so an open view asks again", async () => {
        const sessionId = await addSession();
        const before = (await statusFor(READER)) as { browserId: string };

        await log({ action: "navigate", providerSessionId: "s-2", sessionId });
        const after = (await statusFor(READER)) as { browserId: string };

        expect(after.browserId).not.toBe(before.browserId);
        expect([before.browserId, after.browserId].join(" ")).not.toMatch(PROVIDER_SESSION_ID);
        // A "Needs you" card records the name the action that showed the check got (`browser-node.ts`): the same one.
        await expect(browserIdOf(sessionId, "s-2")).resolves.toBe(after.browserId);
    });

    it("does not bring back the old browser when an older action finishes after a newer one replaced it", async () => {
        // Both started on s-1; the later one replaced the browser with s-2 and finished first.
        const sessionId = await addSession({ inUseHolds: [NOW + 20_000, NOW + 30_000], lastActivityAt: NOW - 1000 });

        await log({ action: "navigate", currentUrl: "https://example.com/new", heldUntil: NOW + 30_000, providerSessionId: "s-2", sessionId });
        vi.setSystemTime(NOW + 5000);
        await log({ action: "click", currentUrl: "https://example.com/old", heldUntil: NOW + 20_000, providerSessionId: "s-1", sessionId });

        const row = await sessionRow(sessionId);

        expect(row).toMatchObject({ currentUrl: "https://example.com/new", lastActivityAt: NOW, providerSessionId: "s-2" });
        // The stale action's hold still ends, and it is still on the record.
        expect(row.inUseHolds).toBeUndefined();
        const actions = (await harness.run(async (ctx: any) => await ctx.db.query("browserActions").collect())) as { action: string }[];

        expect(actions.map((a) => a.action)).toEqual(["navigate", "click"]);
    });
});

describe("a browser that ended", () => {
    it("gives no status and no URL once its row is closed", async () => {
        await addSession({ completedAt: NOW, status: "completed" });

        await expect(statusFor(OWNER)).resolves.toBeNull();
        await expect(open(OWNER)).resolves.toEqual({ status: "ended" });
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it("gives no status and no URL once it sat idle past the provider's reap", async () => {
        await addSession({ lastActivityAt: NOW - BROWSER_IDLE_REAP_MS - 1000 });

        await expect(statusFor(OWNER)).resolves.toBeNull();
        await expect(open(OWNER)).resolves.toEqual({ status: "ended" });
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it("gives no URL when the provider no longer has the browser, and leaves the agent's session row alone", async () => {
        const sessionId = await addSession();

        fetchMock.mockResolvedValue(answer(404, { errors: [{ message: "not found" }] }));

        await expect(open(READER)).resolves.toEqual({ status: "ended" });

        const row = (await harness.run(async (ctx: any) => await ctx.db.get("browserSessions", sessionId))) as { status: string };

        expect(row.status).toBe("active");
    });

    it.each([
        [404, "ended"],
        [500, "unavailable"],
    ])("releases the provider's refused answer (%i) unread", async (status, outcome) => {
        await addSession();
        let released = false;

        fetchMock.mockResolvedValue(
            new Response(
                new ReadableStream({
                    cancel: () => {
                        released = true;
                    },
                }),
                { status },
            ),
        );

        await expect(open(OWNER)).resolves.toEqual({ status: outcome });
        expect(released).toBe(true);
    });

    it.each([
        ["the extension's browser", { source: "extension" }],
        ["a session the renderer did not keep", { providerSessionId: "cf-browser-rendering" }],
    ])("gives nothing for %s", async (_name, fields) => {
        await addSession(fields);

        await expect(statusFor(OWNER)).resolves.toBeNull();
        await expect(open(OWNER)).resolves.toEqual({ status: "ended" });
        expect(fetchMock).not.toHaveBeenCalled();
    });
});

describe("taking control of the browser", () => {
    const take = async (userId: string): Promise<any> => await as(userId).action(takeControl as never, { threadId } as never);
    const control = async (): Promise<any> =>
        await named(((await harness.run(async (ctx: any) => await ctx.db.query("browserSessions").first())) as any).control);

    it("gives the owner an interactive view and refuses the agent's turn to anyone else meanwhile", async () => {
        await addSession();

        await expect(take(OWNER)).resolves.toMatchObject({ status: "ok", until: NOW + CONTROL_IDLE_MS, url: VIEW_URL });

        const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];

        // Interactive: the read-only guardrail is left out, so the person's input reaches the page.
        expect(JSON.parse(init.body as string)).not.toHaveProperty("guardrails");
        await expect(control()).resolves.toMatchObject({ by: OWNER, since: NOW, until: NOW + CONTROL_IDLE_MS });
        await expect(statusFor(OWNER)).resolves.toMatchObject({ control: { byYou: true, until: NOW + CONTROL_IDLE_MS } });
        // Someone else watching sees that a person drives it, and gets no view of what they type.
        await expect(statusFor(READER)).resolves.toMatchObject({ canControl: false, control: { byYou: false } });
        await expect(open(READER)).resolves.toEqual({ status: "controlled" });
        expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it("says, to a view that names its claim, whether the person's lease is that view's", async () => {
        await addSession();
        fetchMock.mockImplementation(async () => answer(200, { devtoolsFrontendUrl: VIEW_URL, id: "v-1" }));

        const first = await take(OWNER);
        // The same person in a second tab: the lease goes on under that tab's claim.
        const second = await take(OWNER);
        const statusOf = async (claim: string): Promise<unknown> => await as(OWNER).query(getThreadBrowser as never, { claim, threadId } as never);

        await expect(statusOf(second.claim)).resolves.toMatchObject({ control: { byClaim: true, byYou: true } });
        await expect(statusOf(first.claim)).resolves.toMatchObject({ control: { byClaim: false, byYou: true } });
        await expect(statusFor(OWNER)).resolves.not.toHaveProperty("control.byClaim");
    });

    it("lets a writer take control, but only one person at a time", async () => {
        await addSession();

        await expect(take(WRITER)).resolves.toMatchObject({ status: "ok" });
        await expect(take(OWNER)).resolves.toEqual({ status: "taken" });
        await expect(control()).resolves.toMatchObject({ by: WRITER });
    });

    it("refuses a read-only reader, a stranger, and a reader whose grant the primary no longer has", async () => {
        await addSession();

        await expect(take(READER)).rejects.toMatchObject({ code: "FORBIDDEN" });
        await expect(take(STRANGER)).rejects.toMatchObject({ code: "NOT_FOUND" });
        await harness.run(async (ctx: any) => {
            const grant = await ctx.db.threadAccess.findFirst({ where: { threadId, userId: WRITER } });

            replica.grant = grant;
            await ctx.db.delete("threadAccess", grant._id);
        });
        await expect(take(WRITER)).rejects.toMatchObject({ code: "NOT_FOUND" });
        await expect(control()).resolves.toBeUndefined();
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it("waits while an agent action still runs on the browser", async () => {
        await addSession({ inUseHolds: [NOW + 10_000] });

        await expect(take(OWNER)).resolves.toEqual({ status: "busy" });
        await expect(control()).resolves.toBeUndefined();
    });

    it("drops the claim when no view could be opened, so the agent is never stopped for nothing", async () => {
        await addSession();
        fetchMock.mockResolvedValue(answer(500, {}));

        await expect(take(OWNER)).resolves.toEqual({ status: "unavailable" });
        await expect(control()).resolves.toBeUndefined();
    });

    it("renews on input, and ends when handed back or left, only for the person in control", async () => {
        await addSession();
        await take(OWNER);
        vi.setSystemTime(NOW + 60_000);

        await expect(keep(OWNER)).resolves.toEqual({ until: NOW + 60_000 + CONTROL_IDLE_MS });
        await expect(keep(WRITER)).resolves.toBeNull();
        await expect(giveBack(WRITER, "handed_back")).resolves.toBe(false);
        await expect(control()).resolves.toMatchObject({ by: OWNER, until: NOW + 60_000 + CONTROL_IDLE_MS });

        await expect(giveBack(OWNER, "left")).resolves.toBe(true);
        // Sent again (its answer was lost): it says so again, and changes nothing.
        await expect(giveBack(OWNER, "left")).resolves.toBe(true);
        // Someone else sending that claim is told nothing about the lease.
        await expect(giveBack(WRITER, "left")).resolves.toBe(false);

        await expect(control()).resolves.toMatchObject({ ended: "left", until: NOW + 60_000 });
        await expect(statusFor(READER)).resolves.not.toHaveProperty("control");
        await expect(keep(OWNER)).resolves.toBeNull();
    });

    it("lets only the newest of a person's views renew, hand back or navigate: an older tab never ends a newer one's lease", async () => {
        fetchMock.mockImplementation(async () => answer(200, { devtoolsFrontendUrl: VIEW_URL, id: "v-1" }));
        await addSession();
        const first = await take(OWNER);
        const second = await take(OWNER);
        const older = first.claim as string;
        const newer = second.claim as string;

        expect(newer).not.toBe(older);
        await expect(heldClaim()).resolves.toBe(newer);
        // The renewal settled: the claim it replaced is no longer the lease's.
        await expect(control()).resolves.not.toHaveProperty("renewing");
        await expect(keep(OWNER, older)).resolves.toBeNull();
        await expect(as(OWNER).action(navigateInControl as never, { claim: older, threadId, url: "https://example.com/next" } as never)).resolves.toEqual({
            error: "You do not have control of the browser.",
            status: "refused",
        });
        expect(renderer).not.toHaveBeenCalled();
        // The older tab closes: the newer tab's lease goes on, and the agent is still refused. It is told so.
        await expect(giveBack(OWNER, "handed_back", older)).resolves.toBe(false);
        await expect(control()).resolves.not.toHaveProperty("ended");
        await expect(statusFor(READER)).resolves.toMatchObject({ control: { byYou: false } });

        await expect(keep(OWNER, newer)).resolves.toEqual({ until: NOW + CONTROL_IDLE_MS });
        await giveBack(OWNER, "handed_back", newer);
        await expect(control()).resolves.toMatchObject({ claim: newer, ended: "handed_back" });
    });

    it("keeps the browser watchable after a hand back that ends control longer than the idle window", async () => {
        await addSession();
        await take(OWNER);

        for (const minute of [1, 2, 3]) {
            vi.setSystemTime(NOW + minute * 60_000);
            await keep(OWNER);
        }

        await giveBack(OWNER, "handed_back");

        await expect(statusFor(READER)).resolves.toMatchObject({ idleUntil: NOW + 3 * 60_000 + BROWSER_IDLE_REAP_MS - BROWSER_REAP_MARGIN_MS });
    });

    it("returns control on its own after the idle timeout", async () => {
        // A fresh answer per call: a body is read once.
        fetchMock.mockImplementation(async () => answer(200, { devtoolsFrontendUrl: VIEW_URL, id: "v-1" }));
        await addSession();
        await take(OWNER);
        vi.setSystemTime(NOW + CONTROL_IDLE_MS);

        await expect(statusFor(OWNER)).resolves.not.toHaveProperty("control");
        await expect(take(WRITER)).resolves.toMatchObject({ status: "ok" });
    });

    it("keeps the lease for the view that holds it while a renewal by its holder mints, and when that mint fails", async () => {
        await addSession();
        const { claim } = await take(OWNER);
        const duringMint: unknown[] = [];

        fetchMock.mockImplementation(async () => {
            // The open view is still at work while the renewal is minted: it is never told to close.
            duringMint.push(await keep(OWNER, claim));

            return answer(500, {});
        });

        await expect(take(OWNER)).resolves.toEqual({ status: "unavailable" });
        expect(duringMint).toEqual([{ until: NOW + CONTROL_IDLE_MS }]);
        await expect(control()).resolves.not.toHaveProperty("renewing");
        await expect(control()).resolves.toMatchObject({ by: OWNER, claim, until: NOW + CONTROL_IDLE_MS });
        // The view that got no URL never held a claim: the one still open renews and hands back as before.
        await expect(keep(OWNER, claim)).resolves.toEqual({ until: NOW + CONTROL_IDLE_MS });
        await giveBack(OWNER, "handed_back", claim);
        await expect(control()).resolves.toMatchObject({ claim, ended: "handed_back" });
    });

    it("keeps a newer view's lease when the older view closes while it is minted, and ends it if that mint fails", async () => {
        await addSession();
        const { claim: older } = await take(OWNER);

        fetchMock.mockImplementationOnce(async () => {
            await giveBack(OWNER, "left", older);

            return answer(200, { devtoolsFrontendUrl: VIEW_URL, id: "v-1" });
        });

        const { claim: newer } = await take(OWNER);

        await expect(control()).resolves.toMatchObject({ by: OWNER, claim: newer });
        await expect(control()).resolves.not.toHaveProperty("ended");
        await expect(keep(OWNER, older)).resolves.toBeNull();

        // The view that held the lease closed and the renewal got no view: no one holds it.
        fetchMock.mockImplementationOnce(async () => {
            await giveBack(OWNER, "left", newer);

            return answer(500, {});
        });

        await expect(take(OWNER)).resolves.toEqual({ status: "unavailable" });
        await expect(control()).resolves.toMatchObject({ by: OWNER, ended: "left", until: NOW });
    });

    it("ends the lease the way a view closed while its own renewal minted, and gives that renewal no URL", async () => {
        await addSession();
        const { claim } = await take(OWNER);

        fetchMock.mockImplementationOnce(async () => {
            // The card closes while its expired URL is renewed: it hands back the claim it holds.
            await expect(giveBack(OWNER, "left", claim)).resolves.toBe(false);

            return answer(200, { devtoolsFrontendUrl: VIEW_URL, id: "v-1" });
        });

        await expect(as(OWNER).action(takeControl as never, { renews: claim, threadId } as never)).resolves.toEqual({ status: "unavailable" });
        // No view shows the renewal's claim: the agent is not held off until the idle timeout.
        await expect(control()).resolves.toMatchObject({ by: OWNER, ended: "left", until: NOW });
        await expect(control()).resolves.not.toHaveProperty("renewing");
        await expect(control()).resolves.not.toHaveProperty("renewingEnded");
        // The renewal's own claim, handed back once its answer came, changes nothing and says the lease is back.
        await expect(giveBack(OWNER, "left")).resolves.toBe(true);
        await expect(control()).resolves.toMatchObject({ ended: "left", until: NOW });
    });

    it.each(["handed_back", "left"] as const)(
        "ends the lease as %s, after a page still loading, when its view closed while its own renewal minted",
        async (reason) => {
            await addSession();
            const { claim } = await take(OWNER);
            const loadsUntil = NOW + 10_000;

            fetchMock.mockImplementationOnce(async () => {
                await harness.run(async (ctx: any) => {
                    const row = await ctx.db.query("browserSessions").first();

                    await ctx.db.patch("browserSessions", row._id, { control: { ...row.control, navigatingUntil: loadsUntil } });
                });
                await giveBack(OWNER, reason, claim);

                return answer(200, { devtoolsFrontendUrl: VIEW_URL, id: "v-1" });
            });

            await expect(as(OWNER).action(takeControl as never, { renews: claim, threadId } as never)).resolves.toEqual({ status: "unavailable" });
            // The agent waits for the person's page, then hears how the view closed.
            await expect(control()).resolves.toMatchObject({ ended: reason, until: loadsUntil });
        },
    );

    it("settles a renewal naming a claim other than the one it replaces as a takeover, though that view closed", async () => {
        await addSession();
        const { claim } = await take(OWNER);

        fetchMock.mockImplementationOnce(async () => {
            await giveBack(OWNER, "left", claim);

            return answer(200, { devtoolsFrontendUrl: VIEW_URL, id: "v-1" });
        });

        await expect(as(OWNER).action(takeControl as never, { renews: "another-tab", threadId } as never)).resolves.toMatchObject({ status: "ok" });
        await expect(control()).resolves.not.toHaveProperty("ended");
        await expect(control()).resolves.not.toHaveProperty("renewingEnded");
    });

    it("ends the lease as handed back when the view that held it handed back while a failed renewal minted", async () => {
        await addSession();
        const { claim } = await take(OWNER);

        fetchMock.mockImplementationOnce(async () => {
            await giveBack(OWNER, "handed_back", claim);

            return answer(500, {});
        });

        await expect(take(OWNER)).resolves.toEqual({ status: "unavailable" });
        // The agent's next action hears that the person gave the browser back, not that they left the view.
        await expect(control()).resolves.toMatchObject({ by: OWNER, ended: "handed_back", until: NOW });
        await expect(control()).resolves.not.toHaveProperty("renewingEnded");
    });

    it("ends the lease as handed back when a second renewal fails after the open view handed back under the first", async () => {
        await addSession();
        const { claim } = await take(OWNER);

        fetchMock.mockImplementationOnce(async () => {
            await giveBack(OWNER, "handed_back", claim);
            // Another tab renews while the first renewal still mints, and gets no view either.
            fetchMock.mockResolvedValueOnce(answer(500, {}));
            await expect(take(OWNER)).resolves.toEqual({ status: "unavailable" });

            return answer(200, { devtoolsFrontendUrl: VIEW_URL, id: "v-1" });
        });

        await expect(take(OWNER)).resolves.toEqual({ status: "unavailable" });
        await expect(control()).resolves.toMatchObject({ by: OWNER, ended: "handed_back", until: NOW });
    });

    it("takes, keeps and drives no browser for an admin impersonating the owner, but lets a lease be handed back", async () => {
        await addSession();
        const { claim } = await take(OWNER);

        impersonation.by = "admin-1";
        fetchMock.mockClear();

        await expect(take(OWNER)).rejects.toMatchObject({ code: "FORBIDDEN" });
        await expect(keep(OWNER, claim)).rejects.toMatchObject({ code: "FORBIDDEN" });
        await expect(as(OWNER).action(navigateInControl as never, { claim, threadId, url: "https://example.com/next" } as never)).rejects.toMatchObject({
            code: "FORBIDDEN",
        });
        expect(fetchMock).not.toHaveBeenCalled();
        expect(renderer).not.toHaveBeenCalled();

        await giveBack(OWNER, "handed_back", claim);
        await expect(control()).resolves.toMatchObject({ claim, ended: "handed_back" });
    });

    it("keeps the open view's claim through a renewal made while another renewal is minted", async () => {
        await addSession();
        const { claim } = await take(OWNER);

        fetchMock.mockImplementationOnce(async () => {
            fetchMock.mockResolvedValueOnce(answer(500, {}));
            await expect(take(OWNER)).resolves.toEqual({ status: "unavailable" });
            await expect(keep(OWNER, claim)).resolves.toEqual({ until: NOW + CONTROL_IDLE_MS });

            return answer(200, { devtoolsFrontendUrl: VIEW_URL, id: "v-1" });
        });

        // The first renewal's claim was replaced while it minted: it gets no URL, and the open view goes on.
        await expect(take(OWNER)).resolves.toEqual({ status: "unavailable" });
        await expect(control()).resolves.toMatchObject({ claim });
        await expect(keep(OWNER, claim)).resolves.toEqual({ until: NOW + CONTROL_IDLE_MS });
    });

    it("stops renewing a writer whose grant was lowered to read", async () => {
        await addSession();
        await take(WRITER);
        await harness.run(async (ctx: any) => {
            const grant = await ctx.db.threadAccess.findFirst({ where: { threadId, userId: WRITER } });

            await ctx.db.patch("threadAccess", grant._id, { permission: "read" });
        });

        await expect(keep(WRITER)).resolves.toBeNull();
    });
    it("returns no URL when the lease was handed back, or the grant lowered, while the provider minted it", async () => {
        await addSession();
        fetchMock.mockImplementationOnce(async () => {
            await giveBack(OWNER, "left");

            return answer(200, { devtoolsFrontendUrl: VIEW_URL, id: "v-1" });
        });

        await expect(take(OWNER)).resolves.toEqual({ status: "unavailable" });
        // The hand back stands: the agent still hears of it.
        await expect(control()).resolves.toMatchObject({ by: OWNER, ended: "left" });

        fetchMock.mockImplementationOnce(async () => {
            await harness.run(async (ctx: any) => {
                const grant = await ctx.db.threadAccess.findFirst({ where: { threadId, userId: WRITER } });

                await ctx.db.patch("threadAccess", grant._id, { permission: "read" });
            });

            return answer(200, { devtoolsFrontendUrl: VIEW_URL, id: "v-1" });
        });

        await expect(take(WRITER)).rejects.toMatchObject({ code: "FORBIDDEN" });
        // The writer's claim is gone, and the agent's note of the owner's hand back is back.
        await expect(control()).resolves.toMatchObject({ by: WRITER, ended: "left", until: NOW });
    });

    it("returns no URL when the lease lapsed on the server's clock while the provider minted it, though nothing ended it", async () => {
        await addSession();
        fetchMock.mockImplementationOnce(async () => {
            vi.setSystemTime(NOW + CONTROL_IDLE_MS);

            return answer(200, { devtoolsFrontendUrl: VIEW_URL, id: "v-1" });
        });

        await expect(take(OWNER)).resolves.toEqual({ status: "unavailable" });
        // The lapsed claim is dropped: the agent was never stopped by a view the person never got.
        await expect(control()).resolves.toBeUndefined();
    });

    it("keeps a lease its holder renewed while their first claim's mint failed", async () => {
        await addSession();
        fetchMock
            .mockImplementationOnce(async () => {
                // A second request of the same person renews the lease and gets its view first.
                await expect(take(OWNER)).resolves.toMatchObject({ status: "ok" });

                return answer(500, {});
            })
            .mockResolvedValueOnce(answer(200, { devtoolsFrontendUrl: VIEW_URL, id: "v-2" }));

        await expect(take(OWNER)).resolves.toEqual({ status: "unavailable" });
        await expect(control()).resolves.toMatchObject({ by: OWNER, until: NOW + CONTROL_IDLE_MS });
        await expect(statusFor(READER)).resolves.toMatchObject({ control: { byYou: false } });
    });

    it("returns no URL to a view whose claim another of the person's tabs replaced while the provider minted it", async () => {
        let newer = "";

        await addSession();
        fetchMock
            .mockImplementationOnce(async () => {
                // A second tab of the same person takes control and gets its view first.
                newer = ((await take(OWNER)) as { claim: string }).claim;

                return answer(200, { devtoolsFrontendUrl: VIEW_URL, id: "v-1" });
            })
            .mockResolvedValueOnce(answer(200, { devtoolsFrontendUrl: VIEW_URL, id: "v-2" }));

        await expect(take(OWNER)).resolves.toEqual({ status: "unavailable" });
        // The newer tab's lease goes on.
        await expect(control()).resolves.toMatchObject({ by: OWNER, claim: newer, until: NOW + CONTROL_IDLE_MS });
        expect(newer).not.toBe("");
    });

    it("drops the claim when the re-read after the mint fails, and returns no URL", async () => {
        const key = "browser_live_view:getReaderBrowser";
        const reader = registry.get(key);

        await addSession();
        registry.set(
            key,
            internalQuery
                .input({ at: v.optional(v.number()), claim: v.optional(v.string()), threadId: v.id("threads"), userId: v.string() })
                .query(async () => {
                    throw new Error("read failed");
                }),
        );

        try {
            await expect(take(OWNER)).rejects.toThrow("read failed");
        } finally {
            registry.set(key, reader);
        }

        await expect(control()).resolves.toBeUndefined();
    });

    it("refuses a claim while an agent action runs on a browser the row reads as reaped: the renderer may reconnect to it", async () => {
        await addSession({ reapedHolds: [NOW + 10_000] });

        await expect(take(WRITER)).resolves.toEqual({ status: "busy" });
        await expect(control()).resolves.toBeUndefined();
    });

    it("never stores the id of the person in control on the owner's row: only an opaque holder, also once the lease ended", async () => {
        await addSession();

        await expect(take(WRITER)).resolves.toMatchObject({ status: "ok" });
        await giveBack(WRITER, "handed_back");

        const stored = (await harness.run(async (ctx: any) => await ctx.db.query("browserSessions").first())) as any;

        expect(JSON.stringify(stored)).not.toContain(WRITER);
        expect(stored.control.by).toMatch(HOLDER);
        await expect(control()).resolves.toMatchObject({ by: WRITER, ended: "handed_back" });
    });

    it("takes no lease on a deploy without the backend's signing secret", async () => {
        vi.stubEnv("STORAGE_SIGNING_SECRET", "");
        await addSession();

        await expect(take(OWNER)).resolves.toEqual({ status: "unavailable" });
        await expect(control()).resolves.toBeUndefined();
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it("keeps the agent's note of an earlier hand back when a new claim's mint fails", async () => {
        const sessionId = await addSession();
        const by = await controlHolder(sessionId as never, WRITER);

        await harness.run(
            async (ctx: any) =>
                await ctx.db.patch("browserSessions", sessionId, { control: { by, claim: "c-0", ended: "handed_back", since: NOW - 5000, until: NOW - 1 } }),
        );
        fetchMock.mockResolvedValue(answer(500, {}));

        await expect(take(OWNER)).resolves.toEqual({ status: "unavailable" });

        const after = await control();

        expect(after).toMatchObject({ ended: "handed_back" });
        expect(after.until).toBeLessThanOrEqual(NOW);
    });
});

describe("a closing page's hand back", () => {
    const take = async (userId: string): Promise<any> => await as(userId).action(takeControl as never, { threadId } as never);
    const lease = async (): Promise<any> => {
        const session: any = await harness.run(async (ctx: any) => await ctx.db.query("browserSessions").first());

        return session.control;
    };
    const release = async (token: string, ip?: string): Promise<number> => {
        const headers = ip === undefined ? undefined : { "cf-connecting-ip": ip };
        const response = await releaseControlHttpAction(
            {} as never,
            new Request("https://backend.test/browser/release", { body: token, headers, method: "POST" }),
        );

        return response.status;
    };

    beforeEach(() => {
        fetchMock.mockImplementation(async () => answer(200, { devtoolsFrontendUrl: VIEW_URL, id: "v-1" }));
    });

    it("names the lease's claim to its holder alone, so a tab sees at once that another of theirs took over", async () => {
        await addSession();
        const first = await take(OWNER);

        expect(first.claimId).toMatch(CLAIM_ID);
        await expect(statusFor(OWNER)).resolves.toMatchObject({ control: { byYou: true, claimIds: [first.claimId] } });
        await expect(statusFor(READER)).resolves.not.toHaveProperty("control.claimIds");

        const second = await take(OWNER);

        await expect(statusFor(OWNER)).resolves.toMatchObject({ control: { claimIds: [second.claimId] } });
    });

    it("ends the lease its token names, once, on the owner's shard, without a session", async () => {
        await addSession();
        const taken = await take(WRITER);

        expect(taken.release).toEqual(expect.any(String));
        await expect(release(taken.release)).resolves.toBe(204);
        expect(releaseShards).toEqual([OWNER]);
        await expect(named(await lease())).resolves.toMatchObject({ by: WRITER, claim: taken.claim, ended: "left", until: NOW });

        // A beacon sent twice changes nothing more.
        const ended = await lease();

        await expect(release(taken.release)).resolves.toBe(204);
        await expect(lease()).resolves.toEqual(ended);
    });

    it("ends a collaborator's lease on the owner's shard when the collaborator opened the shared thread's browser", async () => {
        // The collaborator's first action opened the browser: the row names them, but it lives on the owner's shard.
        await addSession({ userId: WRITER });
        const taken = await take(WRITER);

        await expect(release(taken.release)).resolves.toBe(204);
        expect(releaseShards).toEqual([OWNER]);
        await expect(named(await lease())).resolves.toMatchObject({ by: WRITER, claim: taken.claim, ended: "left" });
    });

    it("names the shard serving the claim, where the session row is, in the token", async () => {
        await addSession({ userId: WRITER });
        const taken = await runInShard("owner-shard", async () => await take(WRITER));

        await expect(release(taken.release)).resolves.toBe(204);
        expect(releaseShards).toEqual(["owner-shard"]);
    });

    it("never ends a newer claim: another tab's of the same person, or someone else's", async () => {
        await addSession();
        const first = await take(OWNER);
        const second = await take(OWNER);

        await expect(release(first.release)).resolves.toBe(204);
        await expect(lease()).resolves.toMatchObject({ claim: second.claim });
        await expect(lease()).resolves.not.toHaveProperty("ended");

        await release(second.release);
        const writer = await take(WRITER);

        await expect(release(second.release)).resolves.toBe(204);
        await expect(named(await lease())).resolves.toMatchObject({ by: WRITER, claim: writer.claim });
        await expect(lease()).resolves.not.toHaveProperty("ended");
    });

    it("only notes how the view closed when its claim is being replaced by a renewal, which then decides", async () => {
        await addSession();
        const first = await take(OWNER);
        const held = await lease();

        // A renewal of the lease is still being minted under a new claim: the closing view's claim is `renewing`.
        await harness.run(async (ctx: any) => {
            const session = await ctx.db.query("browserSessions").first();

            await ctx.db.patch("browserSessions", session._id, {
                control: { by: held.by, claim: "claim-renewal", renewing: first.claim, since: NOW, until: NOW + CONTROL_IDLE_MS },
            });
        });

        await expect(release(first.release)).resolves.toBe(204);
        await expect(lease()).resolves.toMatchObject({ claim: "claim-renewal", renewingEnded: "left" });
        await expect(lease()).resolves.not.toHaveProperty("ended");
        await expect(lease()).resolves.not.toHaveProperty("renewing");
    });

    it("ends the lease as handed back when the page closed while the person's own hand back was out, once", async () => {
        await addSession();
        const taken = await take(WRITER);

        await expect(release(`${taken.release}\nhanded_back`)).resolves.toBe(204);
        await expect(named(await lease())).resolves.toMatchObject({ by: WRITER, claim: taken.claim, ended: "handed_back", until: NOW });

        // The hand back's own mutation lands after the beacon: it changes nothing, and still answers for its claim.
        const ended = await lease();

        await expect(giveBack(WRITER, "handed_back", taken.claim)).resolves.toBe(true);
        await expect(lease()).resolves.toEqual(ended);
    });

    it("refuses a body that names any other way to close, and ends nothing", async () => {
        await addSession();
        const taken = await take(OWNER);
        const held = await lease();

        await expect(release(`${taken.release}\nidle`)).resolves.toBe(401);
        await expect(release(`${taken.release}\nleft\nleft`)).resolves.toBe(401);
        await expect(lease()).resolves.toEqual(held);
    });

    it("leaves a lease that already lapsed as it is", async () => {
        await addSession();
        const taken = await take(OWNER);

        vi.setSystemTime(NOW + CONTROL_IDLE_MS + 1);
        const lapsed = await lease();

        await expect(release(taken.release)).resolves.toBe(204);
        await expect(lease()).resolves.toEqual(lapsed);
    });

    it("charges an IPv6 sender by its /64, so stepping through its addresses buys no fresh allowance", async () => {
        await addSession();
        const taken = await take(OWNER);

        await release(taken.release, "2001:db8:1:2::1");
        await release(taken.release, "2001:db8:1:2:ffff::9");
        await release(taken.release, "203.0.113.7");

        expect(releaseLimit.keys).toHaveLength(3);
        expect(releaseLimit.keys[0]).toBe(releaseLimit.keys[1]);
        expect(releaseLimit.keys[2]).toBe("203.0.113.7");
    });

    it("refuses a proven token while the limiter is down, so no replay reaches the owner's shard", async () => {
        await addSession();
        const taken = await take(OWNER);

        releaseLimit.down = true;
        await expect(release(taken.release)).resolves.toBe(429);
        await expect(release(taken.release)).resolves.toBe(429);
        expect(releaseShards).toEqual([]);
        await expect(lease()).resolves.not.toHaveProperty("ended");
    });

    it("refuses a sender over its limit once the token is proven, and ends nothing", async () => {
        await addSession();
        const taken = await take(OWNER);

        releaseLimit.limited = true;
        await expect(release(taken.release)).resolves.toBe(429);
        expect(releaseShards).toEqual([]);
        await expect(lease()).resolves.not.toHaveProperty("ended");
        // A token naming another thread's claim ends nothing here either.
        releaseLimit.limited = false;
        const elsewhere = await releaseTokenFor({ claim: taken.claim, shardKey: OWNER, threadId: "other-thread" });

        await expect(release(elsewhere!)).resolves.toBe(204);
        await expect(lease()).resolves.not.toHaveProperty("ended");
    });

    it("refuses a token this backend did not sign, and one changed in any part", async () => {
        await addSession();
        const taken = await take(OWNER);
        const [version, payload, signature] = (taken.release as string).split(".") as [string, string, string];
        const flipped = (hex: string): string => `${hex.slice(0, -1)}${hex.endsWith("0") ? "1" : "0"}`;

        for (const token of [
            "",
            "nonsense",
            `${version}.${flipped(payload)}.${signature}`,
            `${version}.${payload}.${flipped(signature)}`,
            `${taken.release}.x`,
        ]) {
            await expect(release(token)).resolves.toBe(401);
        }

        vi.stubEnv("STORAGE_SIGNING_SECRET", `${SIGNING_SECRET}-rotated`);
        await expect(release(taken.release)).resolves.toBe(401);
        expect(releaseShards).toEqual([]);
        await expect(lease()).resolves.not.toHaveProperty("ended");
    });
});

describe("opening a page while in control", () => {
    const take = async (userId: string): Promise<any> => await as(userId).action(takeControl as never, { threadId } as never);
    const navigate = async (userId: string, url = "https://example.com/next"): Promise<any> =>
        await as(userId).action(navigateInControl as never, { claim: await heldClaim(), threadId, url } as never);
    const session = async (): Promise<any> => await harness.run(async (ctx: any) => await ctx.db.query("browserSessions").first());

    it("navigates the browser for the person in control, and never writes their page for others to read", async () => {
        await addSession();
        await take(OWNER);
        renderer.mockResolvedValueOnce({ data: { sessionId: "s-1", success: true, url: "https://example.com/next?token=1" }, response: { ok: true } });

        await expect(navigate(OWNER)).resolves.toEqual({ status: "ok", url: "https://example.com/next?token=1" });
        expect(renderer.mock.calls[0]?.[0]).toMatchObject({ body: { action: "navigate", sessionId: "s-1", url: "https://example.com/next" } });

        const after = await session();

        expect(after.currentUrl).toBe("https://example.com/login");
        expect(after.control).not.toHaveProperty("navigatingUntil");
    });

    it("forgets a browser the renderer retired for good, and tells the person it is gone", async () => {
        await addSession();
        await take(OWNER);
        renderer.mockResolvedValueOnce({ data: undefined, error: { code: "SESSION_RETIRED", success: false }, response: { ok: false, status: 410 } });

        await expect(navigate(OWNER)).resolves.toEqual({ status: "closed" });
        await expect(session()).resolves.toMatchObject({ providerSessionId: "cf-browser-rendering" });
    });

    it("gives back the charge of a navigation the renderer ran none of even when logging it fails", async () => {
        const key = "browser_functions:logAction";
        const logging = registry.get(key);

        await addSession();
        await take(OWNER);
        // The hour's 240 spent, this navigation's unit with them (the guard that takes it is stubbed here).
        await harness.run(async (ctx: any) => await applyLimit(ctx, { count: 240, identifier: OWNER, key: "browser/control:free" }));
        renderer.mockResolvedValueOnce({ data: undefined, error: { code: "SESSION_RETIRED", success: false }, response: { ok: false, status: 410 } });
        registry.set(
            key,
            internalMutation.input({ sessionId: v.string() }).mutation(async () => {
                throw new Error("log failed");
            }),
        );

        try {
            await expect(navigate(OWNER)).rejects.toThrow("log failed");
        } finally {
            registry.set(key, logging);
        }

        await expect(harness.run(async (ctx: any) => await applyLimit(ctx, { identifier: OWNER, key: "browser/control:free" }))).resolves.toMatchObject({
            ok: true,
        });
    });

    it("keeps the browser a navigation whose hold the renderer lost names, and tells the person the page may have opened", async () => {
        const lost =
            "The browser session's hold could not be confirmed for the whole action, so its result is withheld. The action may have run: look at the page before you repeat it";

        await addSession();
        await take(OWNER);
        // The row's browser could not be reconnected: the renderer opened the page in a new one, then lost the hold.
        renderer.mockResolvedValueOnce({
            data: undefined,
            error: { error: lost, sessionId: "s-2", success: false },
            response: { headers: new Headers(), ok: false, status: 503 },
        });

        await expect(navigate(OWNER)).resolves.toEqual({ status: "closed" });
        await expect(session()).resolves.toMatchObject({ providerSessionId: "s-2" });
    });

    it("tells the person a page may have opened when the renderer lost the hold of a navigation on the row's own browser", async () => {
        const lost =
            "The browser session's hold could not be confirmed for the whole action, so its result is withheld. The action may have run: look at the page before you repeat it";

        await addSession();
        await take(OWNER);
        renderer.mockResolvedValueOnce({
            data: undefined,
            error: { error: lost, sessionId: "s-1", success: false },
            response: { headers: new Headers(), ok: false, status: 503 },
        });

        await expect(navigate(OWNER)).resolves.toEqual({ error: lost, status: "refused" });
        await expect(session()).resolves.toMatchObject({ providerSessionId: "s-1" });
    });

    it("gives back the person's charge for a navigation the renderer ran none of because it retired the browser", async () => {
        await addSession();
        await take(OWNER);
        // The hour's 240 spent, this navigation's unit with them (the guard that takes it is stubbed here).
        await harness.run(async (ctx: any) => await applyLimit(ctx, { count: 240, identifier: OWNER, key: "browser/control:free" }));
        renderer.mockResolvedValueOnce({ data: undefined, error: { code: "SESSION_RETIRED", success: false }, response: { ok: false, status: 410 } });

        await expect(navigate(OWNER)).resolves.toEqual({ status: "closed" });
        // That unit was given back.
        await expect(harness.run(async (ctx: any) => await applyLimit(ctx, { identifier: OWNER, key: "browser/control:free" }))).resolves.toMatchObject({
            ok: true,
        });
    });

    it("refuses someone who does not hold control, and a page the owner's lists or the address guard block", async () => {
        await addSession();
        await take(OWNER);
        await harness.run(
            async (ctx: any) => await ctx.db.insert("aiUserPreferences", { browserSettings: { domainBlocklist: ["blocked.example"] }, userId: OWNER }),
        );

        await expect(navigate(WRITER)).resolves.toMatchObject({ status: "refused" });
        await expect(navigate(STRANGER)).rejects.toMatchObject({ code: "NOT_FOUND" });
        await expect(navigate(OWNER, "https://blocked.example/")).resolves.toMatchObject({ status: "refused" });
        await expect(navigate(OWNER, "http://169.254.169.254/")).resolves.toMatchObject({ status: "refused" });
        expect(renderer).not.toHaveBeenCalled();
    });

    it("keeps the agent off the browser until the person's page has loaded, also when they hand back meanwhile", async () => {
        await addSession();
        await take(OWNER);
        let duringLoad: any;

        renderer.mockImplementationOnce(async () => {
            await giveBack(OWNER, "handed_back");
            const loading = await session();

            duringLoad = loading.control;

            return { data: { sessionId: "s-1", success: true, url: "https://example.com/next" }, response: { ok: true } };
        });

        await navigate(OWNER);

        // Handed back mid-load: the lease still runs until the navigation's deadline, so the agent is still refused.
        expect(duringLoad).toMatchObject({ ended: "handed_back", navigatingUntil: rendererCallHold(NOW), until: rendererCallHold(NOW) });
        // Loaded: the lease ends now, and the agent's next action hears of the hand back.
        const loaded = await session();

        await expect(named(loaded.control)).resolves.toMatchObject({ by: OWNER, ended: "handed_back", since: NOW, until: NOW });
        expect(loaded.control).not.toHaveProperty("navigatingUntil");
    });

    it("gives the person a full idle window once their page has loaded, however late in the lease it started", async () => {
        await addSession();
        await take(OWNER);
        // Late in the idle window: the hold outlasts the lease, and the page loads near the hold's end.
        vi.setSystemTime(NOW + 100_000);
        renderer.mockImplementationOnce(async () => {
            vi.setSystemTime(NOW + 170_000);

            return { data: { sessionId: "s-1", success: true, url: "https://example.com/next" }, response: { ok: true } };
        });

        await navigate(OWNER);

        const after = await session();

        expect(after.control.until).toBe(NOW + 170_000 + CONTROL_IDLE_MS);
        expect(after.lastActivityAt).toBe(NOW + 170_000);
    });

    it("gives no fresh idle window to a writer whose grant was lowered to read while their page loaded", async () => {
        await addSession();
        await take(WRITER);
        vi.setSystemTime(NOW + 100_000);
        renderer.mockImplementationOnce(async () => {
            await harness.run(async (ctx: any) => {
                const grant = await ctx.db.threadAccess.findFirst({ where: { threadId, userId: WRITER } });

                await ctx.db.patch("threadAccess", grant._id, { permission: "read" });
            });
            vi.setSystemTime(NOW + 170_000);

            return { data: { sessionId: "s-1", success: true, url: "https://example.com/next" }, response: { ok: true } };
        });

        await navigate(WRITER);

        const after = await session();

        expect(after.control.until).toBe(rendererCallHold(NOW + 100_000));
    });

    it("refuses a page once the lease lapsed after the action started, though the action's clock still reads it held", async () => {
        await addSession();
        await take(OWNER);
        vi.setSystemTime(NOW + CONTROL_IDLE_MS - 1);
        actionStart.hook = () => vi.setSystemTime(NOW + CONTROL_IDLE_MS);

        await expect(navigate(OWNER)).resolves.toEqual({ error: "You do not have control of the browser.", status: "refused" });
        expect(renderer).not.toHaveBeenCalled();
    });

    it("keeps the page's hold until it runs out when the renderer call was cut off, also after a hand back", async () => {
        await addSession();
        await take(OWNER);
        renderer.mockImplementationOnce(async () => {
            await giveBack(OWNER, "handed_back");
            // The call's deadline: the renderer may still be loading the page.
            vi.setSystemTime(NOW + 60_000);

            throw new DOMException("The operation timed out.", "TimeoutError");
        });

        await expect(navigate(OWNER)).resolves.toEqual({ error: "The page could not be opened.", status: "refused" });

        const after = await session();

        expect(after.control).toMatchObject({ ended: "handed_back", navigatingUntil: rendererCallHold(NOW), until: rendererCallHold(NOW) });
    });

    it("refuses a second page while one loads, and any page once handed back mid-load", async () => {
        await addSession();
        await take(OWNER);
        const during: unknown[] = [];

        renderer.mockImplementationOnce(async () => {
            during.push(await navigate(OWNER, "https://example.com/other"));
            await giveBack(OWNER, "handed_back");
            during.push(await navigate(OWNER, "https://example.com/other"));

            return { data: { sessionId: "s-1", success: true, url: "https://example.com/next" }, response: { ok: true } };
        });

        await navigate(OWNER);

        expect(during).toEqual([
            { error: "The page you opened is still loading.", status: "refused" },
            { error: "You do not have control of the browser.", status: "refused" },
        ]);
        expect(renderer).toHaveBeenCalledTimes(1);
    });

    it("keeps a lease taken again mid-load after a hand back, once the page loaded", async () => {
        fetchMock.mockImplementation(async () => answer(200, { devtoolsFrontendUrl: VIEW_URL, id: "v-1" }));
        await addSession();
        await take(OWNER);

        renderer.mockImplementationOnce(async () => {
            await giveBack(OWNER, "left");
            vi.setSystemTime(NOW + 1000);
            await expect(take(OWNER)).resolves.toMatchObject({ status: "ok" });

            return { data: { sessionId: "s-1", success: true, url: "https://example.com/next" }, response: { ok: true } };
        });

        await navigate(OWNER);

        const after = await session();

        expect(after.control).not.toHaveProperty("ended");
        expect(after.control.until).toBe(NOW + 1000 + CONTROL_IDLE_MS);
        await expect(keep(OWNER)).resolves.toEqual({ until: NOW + 1000 + CONTROL_IDLE_MS });
    });

    it("hands the lease back again when taking it back mid-load fails to mint", async () => {
        await addSession();
        await take(OWNER);

        renderer.mockImplementationOnce(async () => {
            await giveBack(OWNER, "handed_back");
            fetchMock.mockResolvedValueOnce(answer(500, {}));
            await expect(take(OWNER)).resolves.toEqual({ status: "unavailable" });
            await expect(session()).resolves.toMatchObject({ control: { ended: "handed_back", until: rendererCallHold(NOW) } });

            return { data: { sessionId: "s-1", success: true, url: "https://example.com/next" }, response: { ok: true } };
        });

        await navigate(OWNER);

        await expect(session()).resolves.toMatchObject({ control: { ended: "handed_back", until: NOW } });
    });

    it("refuses every page when the owner turned browsing off", async () => {
        await addSession();
        await take(WRITER);
        await harness.run(async (ctx: any) => await ctx.db.insert("aiUserPreferences", { browserSettings: { enabled: false }, userId: OWNER }));

        await expect(navigate(WRITER)).resolves.toEqual({ error: "Browser automation is disabled in your settings", status: "refused" });
        expect(renderer).not.toHaveBeenCalled();
    });

    it("tells the person the browser closed when the renderer opened the page in a new browser", async () => {
        await addSession();
        await take(OWNER);
        // The old browser expired: the renderer opened the page in a new one, and the lease ends with the old one.
        renderer.mockResolvedValueOnce({ data: { sessionId: "s-2", success: true, url: "https://example.com/next" }, response: { ok: true } });

        await expect(navigate(OWNER)).resolves.toEqual({ status: "closed" });
        await expect(session()).resolves.toMatchObject({ control: { ended: "browser_closed" }, providerSessionId: "s-2" });
    });

    it("tells the person the browser closed when the row moved on to another browser while the page loaded", async () => {
        const sessionId = await addSession();

        await take(OWNER);
        renderer.mockImplementationOnce(async () => {
            await harness.run(async (ctx: any) => await ctx.db.patch("browserSessions", sessionId, { providerSessionId: "s-3" }));

            return { data: { sessionId: "s-1", success: true, url: "https://example.com/next" }, response: { ok: true } };
        });

        await expect(navigate(OWNER)).resolves.toEqual({ status: "closed" });
    });

    it("forgets a browser the renderer closed after a blocked redirect, and ends the lease with it", async () => {
        await addSession();
        await take(OWNER);
        renderer.mockResolvedValueOnce({ data: { error: "Redirected to blocked URL", success: false }, response: { ok: true } });

        await expect(navigate(OWNER)).resolves.toEqual({ error: "Redirected to blocked URL", status: "refused" });

        const after = await session();

        expect(after.providerSessionId).toBe("cf-browser-rendering");
        // The agent's next action hears that the person's browser was closed, not that they went idle.
        expect(after.control).toMatchObject({ ended: "browser_closed", until: NOW });
        await expect(statusFor(OWNER)).resolves.toBeNull();
    });

    it("ends the page's hold when its audit row could not be written, so a hand back mid-load still ends", async () => {
        await addSession();
        await take(OWNER);

        renderer.mockImplementationOnce(async () => {
            await giveBack(OWNER, "handed_back");

            // An answer the audit row refuses: its write fails.
            return { data: { error: 42, success: false }, response: { ok: true } };
        });

        await expect(navigate(OWNER)).rejects.toThrow();

        const after = await session();

        expect(after.control).toMatchObject({ ended: "handed_back", until: NOW });
        expect(after.control).not.toHaveProperty("navigatingUntil");
    });

    it("audits a navigation on the session it began on, not on one opened while it ran", async () => {
        const first = await addSession();

        await take(OWNER);
        let second = "";

        renderer.mockImplementationOnce(async () => {
            await harness.run(async (ctx: any) => await ctx.db.patch("browserSessions", first, { status: "completed" }));
            second = await addSession({ providerSessionId: "s-2" });

            return { data: { sessionId: "s-1", success: true, url: "https://example.com/next" }, response: { ok: true } };
        });

        // The page loaded in a browser the thread no longer has: the person is told it closed, not that it opened.
        await expect(navigate(OWNER)).resolves.toEqual({ status: "closed" });

        const audits = (await harness.run(async (ctx: any) => await ctx.db.query("browserActions").collect())) as { sessionId: string }[];

        expect(audits.map((row) => row.sessionId)).toEqual([first]);
        expect(second).not.toBe(first);
    });

    it("shows the owner which page a person in control opened, and whether they or a collaborator opened it", async () => {
        const sessionId = await addSession();
        const loaded = { data: { sessionId: "s-1", success: true, url: "https://example.com/next" }, response: { ok: true } };

        // A fresh view answer per claim: a response body is read once.
        fetchMock.mockImplementation(async () => answer(200, { devtoolsFrontendUrl: VIEW_URL, id: "v-1" }));
        renderer.mockResolvedValue(loaded);
        await take(WRITER);
        await navigate(WRITER, "https://example.com/next?q=1");
        await giveBack(WRITER, "handed_back");
        // Later, so the history's order is not a tie.
        vi.setSystemTime(NOW + 1000);
        await take(OWNER);
        await navigate(OWNER, "https://example.com/mine");

        const history = await as(OWNER).query(getBrowserActions as never, { sessionId } as never);

        expect(history).toEqual([
            expect.objectContaining({ action: "navigate", actor: "collaborator", success: true, target: "https://example.com/next?q=1" }),
            expect.objectContaining({ action: "navigate", actor: "owner", success: true, target: "https://example.com/mine" }),
        ]);
    });

    it("ends the renderer call before the page's hold, also when the call starts late", async () => {
        await addSession();
        await take(OWNER);
        const timeout = vi.spyOn(AbortSignal, "timeout");
        let loading: any;

        renderer.mockImplementation(async () => {
            const current = await session();

            loading = current.control;

            return { data: { sessionId: "s-1", success: true, url: "https://example.com/next" }, response: { ok: true } };
        });

        // On time: the whole request, ending well inside the hold.
        await navigate(OWNER);
        expect(timeout).toHaveBeenLastCalledWith(60_000);
        expect(loading.navigatingUntil).toBe(rendererCallHold(NOW));

        // Twelve seconds late (a slow round trip after the hold was written): cut so it ends before the hold does.
        vi.setSystemTime(NOW + 1000);
        rendererStart.hook = () => vi.setSystemTime(NOW + 13_000);
        await navigate(OWNER);

        const [budget] = timeout.mock.lastCall ?? [];

        expect(NOW + 13_000 + Number(budget)).toBe(rendererCallHold(NOW + 1000) - RENDERER_CALL_SETTLE_MS);
        expect(renderer).toHaveBeenCalledTimes(2);
    });

    it("sends no renderer call that starts after its page's hold ran out, and ends the hold", async () => {
        await addSession();
        await take(OWNER);
        rendererStart.hook = () => vi.setSystemTime(rendererCallHold(NOW));

        await expect(navigate(OWNER)).resolves.toEqual({ error: "The page could not be opened.", status: "refused" });
        expect(renderer).not.toHaveBeenCalled();
        const after = await session();

        expect(after.control).not.toHaveProperty("navigatingUntil");
    });
});
