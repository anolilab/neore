/**
 * Watching the agent's cloud browser: who gets the running browser's status and a live view URL, and that a browser
 * that ended (closed, idle past the provider's reap, or gone at the provider) gives neither.
 */
import { lunoraTest } from "@lunora/testing";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { registeredApi, registerModule } from "../../test/registered-api";
import schema from "../schema";
import { logAction } from "./functions";
import { getThreadBrowser, openLiveView } from "./live-view";
import { BROWSER_IDLE_REAP_MS } from "./live-view-logic";

const OWNER = "user-owner";
const READER = "user-reader";
const STRANGER = "user-stranger";
/** The frozen clock every test reads, in the code and in the assertions alike. */
const NOW = Date.UTC(2026, 10, 20, 12);
/** The provider session ids the tests use: a browser name a client sees must hold neither. */
const PROVIDER_SESSION_ID = /s-[12]/u;
const VIEW_URL = "https://live.browser.run/ui/view?mode=tab&wss=live.browser.run/api/devtools/browser/s-1?jwt=signed";

const { config, registry, sessionFrom } = vi.hoisted(() => {
    return {
        config: { accountId: "account-1", token: "token-1" },
        registry: new Map<string, unknown>(),
        sessionFrom: async (context: { auth: { userId?: string | null } }) =>
            context.auth.userId ? { activeOrganization: null, id: context.auth.userId, isAdmin: false, userId: context.auth.userId } : null,
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

vi.mock("../lib/rate-limiter", async (importOriginal) => {
    return { ...(await importOriginal<typeof import("../lib/rate-limiter")>()), rateLimitGuard: async () => undefined };
});

let harness: ReturnType<typeof lunoraTest>;
let threadId: string;
const fetchMock = vi.fn();

const as = (userId: string) => harness.withIdentity({ userId } as never);
const statusFor = async (userId: string): Promise<unknown> => await as(userId).query(getThreadBrowser as never, { threadId } as never);
const open = async (userId: string): Promise<any> => await as(userId).action(openLiveView as never, { threadId } as never);

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

beforeAll(async () => {
    registerModule(registry, "agent_threads", await import("../agent/threads"));
    registerModule(registry, "browser_functions", await import("./functions"));
    registerModule(registry, "browser_live_view", await import("./live-view"));
}, 30_000);

beforeEach(async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW);
    harness = lunoraTest(schema as never);
    config.accountId = "account-1";
    config.token = "token-1";
    fetchMock.mockResolvedValue(answer(200, { devtoolsFrontendUrl: VIEW_URL, id: "v-1" }));
    vi.stubGlobal("fetch", fetchMock);
    threadId = (await harness.run(async (ctx: any) => {
        const id = await ctx.db.insert("threads", { status: "active", title: "T", userId: OWNER });

        await ctx.db.insert("threadAccess", { grantedAt: 0, grantedBy: OWNER, permission: "read", threadId: id, userId: READER });

        return id;
    })) as string;
});

afterEach(() => {
    harness.close();
    fetchMock.mockReset();
    vi.unstubAllGlobals();
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

        await expect(statusFor(OWNER)).resolves.toEqual({ browserId: expect.any(String), currentUrl: "https://example.com/login", idleUntil: heldUntil });
        await expect(open(OWNER)).resolves.toMatchObject({ status: "ok" });
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
        await harness.run(async (ctx: any) => await ctx.runMutation(logAction, { startedWithProviderSessionId: "s-1", success: true, ...args }));

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
