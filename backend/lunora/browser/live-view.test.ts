/**
 * Watching the agent's cloud browser: who gets the running browser's status and a live view URL, and that a browser
 * that ended (closed, idle past the provider's reap, or gone at the provider) gives neither.
 */
import { lunoraTest } from "@lunora/testing";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { registeredApi, registerModule } from "../../test/registered-api";
import schema from "../schema";
import { getBrowserActions } from "../chat/functions";
import { logAction } from "./functions";
import { getThreadBrowser, handBack, keepControl, navigateInControl, openLiveView, takeControl } from "./live-view";
import { BROWSER_IDLE_REAP_MS, BROWSER_REAP_MARGIN_MS, CONTROL_IDLE_MS, CONTROL_NAVIGATION_SETTLE_MS, controlNavigationHold } from "./live-view-logic";

const OWNER = "user-owner";
const READER = "user-reader";
const STRANGER = "user-stranger";
const WRITER = "user-writer";
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

const { renderer, rendererStart } = vi.hoisted(() => {
    // `rendererStart` runs when a renderer call is about to start: a test makes the call start late with it.
    return { renderer: vi.fn(), rendererStart: { hook: undefined as (() => void) | undefined } };
});

vi.mock("../lib/services", async (importOriginal) => {
    return { ...(await importOriginal<typeof import("../lib/services")>()), isServiceBound: () => true, serviceFetch: () => fetch };
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

vi.mock("../lib/rate-limiter", async (importOriginal) => {
    return { ...(await importOriginal<typeof import("../lib/rate-limiter")>()), rateLimitGuard: async () => undefined };
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
        await ctx.db.insert("threadAccess", { grantedAt: 0, grantedBy: OWNER, permission: "write", threadId: id, userId: WRITER });

        return id;
    })) as string;
});

afterEach(() => {
    delete replica.grant;
    rendererStart.hook = undefined;
    vi.restoreAllMocks();
    harness.close();
    fetchMock.mockReset();
    renderer.mockReset();
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

describe("taking control of the browser", () => {
    const take = async (userId: string): Promise<any> => await as(userId).action(takeControl as never, { threadId } as never);
    const control = async (): Promise<any> => ((await harness.run(async (ctx: any) => await ctx.db.query("browserSessions").first())) as any).control;

    it("gives the owner an interactive view and refuses the agent's turn to anyone else meanwhile", async () => {
        await addSession();

        await expect(take(OWNER)).resolves.toMatchObject({ status: "ok", url: VIEW_URL });

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
        await giveBack(WRITER, "handed_back");
        await expect(control()).resolves.toMatchObject({ by: OWNER, until: NOW + 60_000 + CONTROL_IDLE_MS });

        await giveBack(OWNER, "left");

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
        await expect(keep(OWNER, older)).resolves.toBeNull();
        await expect(as(OWNER).action(navigateInControl as never, { claim: older, threadId, url: "https://example.com/next" } as never)).resolves.toEqual({
            error: "You do not have control of the browser.",
            status: "refused",
        });
        expect(renderer).not.toHaveBeenCalled();
        // The older tab closes: the newer tab's lease goes on, and the agent is still refused.
        await giveBack(OWNER, "left", older);
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

    it("keeps the lease for the view that holds it when a renewal by its holder fails to mint", async () => {
        await addSession();
        const { claim } = await take(OWNER);

        fetchMock.mockResolvedValue(answer(500, {}));

        await expect(take(OWNER)).resolves.toEqual({ status: "unavailable" });
        await expect(control()).resolves.toMatchObject({ by: OWNER, claim, until: NOW + CONTROL_IDLE_MS });
        // The view that got no URL never held a claim: the one still open renews and hands back as before.
        await expect(keep(OWNER, claim)).resolves.toEqual({ until: NOW + CONTROL_IDLE_MS });
        await giveBack(OWNER, "handed_back", claim);
        await expect(control()).resolves.toMatchObject({ claim, ended: "handed_back" });
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

    it("keeps the agent's note of an earlier hand back when a new claim's mint fails", async () => {
        await addSession({ control: { by: WRITER, claim: "c-0", ended: "handed_back", since: NOW - 5000, until: NOW - 1 } });
        fetchMock.mockResolvedValue(answer(500, {}));

        await expect(take(OWNER)).resolves.toEqual({ status: "unavailable" });

        const after = await control();

        expect(after).toMatchObject({ ended: "handed_back" });
        expect(after.until).toBeLessThanOrEqual(NOW);
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
        expect(duringLoad).toMatchObject({ ended: "handed_back", navigatingUntil: controlNavigationHold(NOW), until: controlNavigationHold(NOW) });
        // Loaded: the lease ends now, and the agent's next action hears of the hand back.
        const loaded = await session();

        expect(loaded.control).toMatchObject({ by: OWNER, ended: "handed_back", since: NOW, until: NOW });
        expect(loaded.control).not.toHaveProperty("navigatingUntil");
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
            await expect(session()).resolves.toMatchObject({ control: { ended: "handed_back", until: controlNavigationHold(NOW) } });

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

        await navigate(OWNER);

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
        expect(loading.navigatingUntil).toBe(controlNavigationHold(NOW));

        // Twelve seconds late (a slow round trip after the hold was written): cut so it ends before the hold does.
        vi.setSystemTime(NOW + 1000);
        rendererStart.hook = () => vi.setSystemTime(NOW + 13_000);
        await navigate(OWNER);

        const [budget] = timeout.mock.lastCall ?? [];

        expect(NOW + 13_000 + Number(budget)).toBe(controlNavigationHold(NOW + 1000) - CONTROL_NAVIGATION_SETTLE_MS);
        expect(renderer).toHaveBeenCalledTimes(2);
    });

    it("sends no renderer call that starts after its page's hold ran out, and ends the hold", async () => {
        await addSession();
        await take(OWNER);
        rendererStart.hook = () => vi.setSystemTime(controlNavigationHold(NOW));

        await expect(navigate(OWNER)).resolves.toEqual({ error: "The page could not be opened.", status: "refused" });
        expect(renderer).not.toHaveBeenCalled();
        const after = await session();

        expect(after.control).not.toHaveProperty("navigatingUntil");
    });
});
