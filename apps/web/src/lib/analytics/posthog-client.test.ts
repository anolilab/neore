import { act, renderHook } from "@testing-library/react";
import type { PostHog } from "posthog-js";
import type { ReactNode } from "react";
import { createElement, useMemo } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const posthog = vi.hoisted(() => {
    return {
        __loaded: false,
        capture: vi.fn(),
        captureException: vi.fn(),
        group: vi.fn(),
        has_opted_out_capturing: vi.fn(() => false),
        identify: vi.fn(),
        is_capturing: vi.fn(() => true),
        register: vi.fn(),
        reset: vi.fn(),
    };
});

vi.mock("./posthog-js", () => {
    return { posthog };
});

/** A fresh module, as on a new page: an open queue, with only what sessionStorage kept. */
const loadClientModule = async () => {
    vi.resetModules();

    return await import("./posthog-client");
};

describe("captureException before PostHog initialises", () => {
    beforeEach(() => {
        posthog.__loaded = false;
        posthog.captureException.mockClear();
        posthog.has_opted_out_capturing.mockReturnValue(false);
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    it("queues what is caught while the chunk loads and sends it, in order, once PostHog has started", async () => {
        const client = await loadClientModule();
        const early = new Error("hydration failed");

        client.captureException(early, { errorBoundary: "global" });
        client.captureException("rejected");

        expect(posthog.captureException).not.toHaveBeenCalled();

        const loaded = await client.loadPostHog();

        loaded.__loaded = true;
        client.setAnalyticsIdentity({});
        client.startPostHog(loaded, () => {});

        expect(posthog.captureException.mock.calls).toStrictEqual([
            [early, { errorBoundary: "global" }],
            ["rejected", undefined],
        ]);

        // Started: later exceptions go straight to PostHog, nothing is queued.
        client.captureException("later");

        expect(posthog.captureException).toHaveBeenLastCalledWith("later", undefined);
        expect(posthog.captureException).toHaveBeenCalledTimes(3);
    });

    it("keeps only the latest MAX_PENDING_EXCEPTIONS", async () => {
        const client = await loadClientModule();

        for (let index = 0; index < client.MAX_PENDING_EXCEPTIONS + 5; index += 1) {
            client.captureException(`error ${index}`);
        }

        client.flushPendingCaptures(await client.loadPostHog());

        const sent = posthog.captureException.mock.calls.map(([error]) => error);

        expect(sent).toHaveLength(client.MAX_PENDING_EXCEPTIONS);
        expect(sent[0]).toBe("error 5");
        expect(sent.at(-1)).toBe(`error ${client.MAX_PENDING_EXCEPTIONS + 4}`);
    });

    it("drops the queue when the user opted out", async () => {
        const client = await loadClientModule();

        client.captureException(new Error("early"));
        posthog.has_opted_out_capturing.mockReturnValue(true);
        client.flushPendingCaptures(await client.loadPostHog());

        expect(posthog.captureException).not.toHaveBeenCalled();
    });

    it("drops the queue, and queues nothing more, when analytics will not load", async () => {
        const client = await loadClientModule();

        client.captureException(new Error("early"));
        client.discardPendingCaptures();
        client.captureException(new Error("after"));
        client.flushPendingCaptures(await client.loadPostHog());

        expect(posthog.captureException).not.toHaveBeenCalled();
    });

    it("sends the rest of the queue when one report throws", async () => {
        const client = await loadClientModule();
        const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

        client.captureException("first");
        client.captureException("second");
        posthog.captureException.mockImplementationOnce(() => {
            throw new Error("report failed");
        });

        expect(() => client.flushPendingCaptures(posthog as never)).not.toThrow();
        expect(posthog.captureException.mock.calls.map(([error]) => error)).toStrictEqual(["first", "second"]);
        expect(warn).toHaveBeenCalledOnce();
    });

    it("queues nothing while measurement consent is refused, and a refusal drops what was queued", async () => {
        const client = await loadClientModule();

        client.captureException("before the refusal");
        client.setMeasurementConsent(false);
        client.captureException("while refused");
        client.setMeasurementConsent(true);
        client.captureException("after the grant");
        client.flushPendingCaptures(await client.loadPostHog());

        expect(posthog.captureException.mock.calls.map(([error]) => error)).toStrictEqual(["after the grant"]);
    });
});

describe("events tracked before PostHog initialises", () => {
    beforeEach(() => {
        vi.useFakeTimers({ now: new Date("2026-11-12T10:00:00.000Z"), toFake: ["Date"] });
        posthog.__loaded = false;
        posthog.capture.mockReset();
        posthog.captureException.mockClear();
        posthog.has_opted_out_capturing.mockReturnValue(false);
    });

    afterEach(() => {
        vi.useRealTimers();
        vi.restoreAllMocks();
        sessionStorage.clear();
    });

    it("sends them in order with the time they were tracked, before the queued errors, and isolates a capture that throws", async () => {
        const client = await loadClientModule();
        const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

        client.queueEvent("anonymous_session_started", { provider: "anonymous" });
        vi.setSystemTime(new Date("2026-11-12T10:00:02.000Z"));
        client.queueEvent("onboarding_started", {});
        client.captureException("early");
        posthog.capture.mockImplementationOnce(() => {
            throw new Error("capture failed");
        });

        client.flushPendingCaptures(await client.loadPostHog());

        expect(posthog.capture.mock.calls).toStrictEqual([
            [
                "anonymous_session_started",
                expect.objectContaining({ $pathname: "/", provider: "anonymous" }),
                { timestamp: new Date("2026-11-12T10:00:00.000Z") },
            ],
            ["onboarding_started", expect.any(Object), { timestamp: new Date("2026-11-12T10:00:02.000Z") }],
        ]);
        expect(posthog.captureException).toHaveBeenCalledExactlyOnceWith("early", undefined);
        expect(posthog.capture.mock.invocationCallOrder.at(-1)).toBeLessThan(posthog.captureException.mock.invocationCallOrder[0] ?? 0);
        expect(warn).toHaveBeenCalledOnce();
        expect(sessionStorage.getItem(client.PENDING_EVENTS_KEY)).toBeNull();
    });

    it("keeps them across a full page load in the tab, up to MAX_PENDING_EVENTS", async () => {
        const before = await loadClientModule();

        before.setMeasurementConsent(true);

        for (let index = 0; index < before.MAX_PENDING_EVENTS + 1; index += 1) {
            before.queueEvent(`event ${index}`, {});
        }

        // The desktop sign-in tracks, then loads `/chat` before PostHog could load.
        const after = await loadClientModule();

        after.setMeasurementConsent(true);

        after.flushPendingCaptures(await after.loadPostHog());

        const sent = posthog.capture.mock.calls.map(([event]) => event);

        expect(sent).toHaveLength(after.MAX_PENDING_EVENTS);
        expect(sent[0]).toBe("event 1");
    });

    it("queues none while measurement is refused, and a refusal or an opt-out drops them", async () => {
        const client = await loadClientModule();

        client.queueEvent("before the refusal", {});
        client.setMeasurementConsent(false);
        client.queueEvent("while refused", {});
        client.setMeasurementConsent(true);
        client.queueEvent("after the grant", {});
        client.flushPendingCaptures(await client.loadPostHog());

        expect(posthog.capture.mock.calls.map(([event]) => event)).toStrictEqual(["after the grant"]);

        const next = await loadClientModule();

        next.queueEvent("opted out", {});
        posthog.has_opted_out_capturing.mockReturnValue(true);
        next.flushPendingCaptures(await next.loadPostHog());

        expect(posthog.capture).toHaveBeenCalledOnce();
        expect(sessionStorage.getItem(next.PENDING_EVENTS_KEY)).toBeNull();
    });

    it("skips stored entries without the shape it wrote and still sends the rest", async () => {
        sessionStorage.setItem(
            "neore:posthog-pending-events",
            JSON.stringify([
                null,
                { event: 1, timestamp: "2026-11-12T10:00:00.000Z" },
                { event: "no time" },
                { event: "valid", timestamp: "2026-11-12T09:59:00.000Z" },
            ]),
        );

        const client = await loadClientModule();
        const onStarted = vi.fn();

        client.setAnalyticsIdentity({});
        expect(() => client.startPostHog(posthog as never, onStarted)).not.toThrow();

        expect(posthog.capture).toHaveBeenCalledExactlyOnceWith("valid", undefined, { timestamp: new Date("2026-11-12T09:59:00.000Z") });
        expect(onStarted).toHaveBeenCalledOnce();
    });

    it("names the page it was tracked on, not the one the flush runs on", async () => {
        const client = await loadClientModule();

        globalThis.history.replaceState(null, "", "/auth/sign-in?redirectTo=%2Fchat#token");
        client.queueEvent("desktop_signed_in", { method: "email" });
        globalThis.history.replaceState(null, "", "/chat");
        client.flushPendingCaptures(await client.loadPostHog());

        expect(posthog.capture.mock.calls[0]?.[1]).toStrictEqual({
            $current_url: `${globalThis.location.origin}/auth/sign-in?redirectTo=%2Fchat`,
            $host: globalThis.location.host,
            $pathname: "/auth/sign-in",
            $referrer: "$direct",
            method: "email",
        });
    });

    it("stores no prompt link's text or fragment, from the address, the referrer or a property", async () => {
        const client = await loadClientModule();

        client.setMeasurementConsent(true);
        const referrer = vi.spyOn(document, "referrer", "get").mockReturnValue("https://neore.test/chat?prompt=secret%20referrer#token");

        globalThis.history.replaceState(null, "", "/chat?prompt=secret%20address&model=a#token");
        client.queueEvent("chat_opened", { link: "/chat?prompt=secret%20property", redirectTo: "%2Fchat%3Fprompt%3Dsecret%2520nested" });
        globalThis.history.replaceState(null, "", "/");
        referrer.mockRestore();

        const stored = sessionStorage.getItem(client.PENDING_EVENTS_KEY) ?? "";

        expect(stored).not.toContain("secret");
        expect(stored).not.toContain("token");
        expect(JSON.parse(stored)).toStrictEqual([
            expect.objectContaining({
                properties: expect.objectContaining({
                    $current_url: `${globalThis.location.origin}/chat?prompt=redacted&model=a`,
                    $referrer: "https://neore.test/chat?prompt=redacted",
                    link: "/chat?prompt=redacted",
                }),
            }),
        ]);
    });
});

describe("the landing page view", () => {
    beforeEach(() => {
        vi.useFakeTimers({ now: new Date("2026-11-12T10:00:00.000Z"), toFake: ["Date"] });
        posthog.capture.mockReset();
        posthog.has_opted_out_capturing.mockReturnValue(false);
        posthog.is_capturing.mockReturnValue(true);
    });

    afterEach(() => {
        vi.useRealTimers();
        globalThis.history.replaceState(null, "", "/");
        sessionStorage.clear();
    });

    it("is not sent when the account the session first named switched before PostHog started", async () => {
        const client = await loadClientModule();

        client.recordLandingPageview();
        client.setAnalyticsIdentity({ isOrganizationPending: true, user: { id: "user-a" } });
        client.setAnalyticsIdentity({ user: { id: "user-b" } });
        client.startPostHog(await client.loadPostHog(), () => {});

        expect(posthog.capture.mock.calls.map(([event]) => event)).not.toContain("$pageview");
    });

    it("is sent as the account the session first named", async () => {
        const client = await loadClientModule();

        client.recordLandingPageview();
        client.setAnalyticsIdentity({ user: { id: "user-a" } });
        client.startPostHog(await client.loadPostHog(), () => {});

        expect(posthog.capture.mock.calls.map(([event]) => event)).toContain("$pageview");
    });

    it("tells a started-client hook once PostHog has started, not when it initialised", async () => {
        const client = await loadClientModule();
        const { result } = renderHook(() => client.useStartedPostHog());

        client.startPostHog(await client.loadPostHog(), () => {});

        expect(result.current).toBeUndefined();

        act(() => {
            client.setAnalyticsIdentity({});
        });

        expect(result.current).toBe(posthog);
    });

    it("goes before an event its page queued in the same millisecond", async () => {
        const client = await loadClientModule();

        client.recordLandingPageview();
        client.queueEvent("onboarding_started", {});
        client.flushPendingCaptures(await client.loadPostHog());

        expect(posthog.capture.mock.calls.map(([event]) => event)).toStrictEqual(["$pageview", "onboarding_started"]);
    });

    it("names the page recorded at mount and goes in order with the queued events, once", async () => {
        const client = await loadClientModule();

        client.queueEvent("before", {});
        vi.setSystemTime(new Date("2026-11-12T10:00:01.000Z"));
        globalThis.history.replaceState(null, "", "/pricing?utm_source=newsletter&prompt=secret");
        client.recordLandingPageview();
        vi.setSystemTime(new Date("2026-11-12T10:00:02.000Z"));
        globalThis.history.replaceState(null, "", "/chat");
        // React's second effect run, or a remount, records nothing more.
        client.recordLandingPageview();
        client.queueEvent("after", {});
        client.flushPendingCaptures(await client.loadPostHog());

        expect(posthog.capture.mock.calls.map(([event]) => event)).toStrictEqual(["before", "$pageview", "after"]);
        expect(posthog.capture.mock.calls[1]).toStrictEqual([
            "$pageview",
            {
                $current_url: `${globalThis.location.origin}/pricing?utm_source=newsletter&prompt=redacted`,
                $host: globalThis.location.host,
                $pathname: "/pricing",
                $referrer: "$direct",
            },
            { timestamp: new Date("2026-11-12T10:00:01.000Z") },
        ]);
    });

    it("is sent cookieless after a refusal, as PostHog's own was, and not when PostHog captures nothing", async () => {
        const refused = await loadClientModule();

        refused.recordLandingPageview();
        refused.setMeasurementConsent(false);
        refused.queueEvent("while refused", {});
        posthog.has_opted_out_capturing.mockReturnValue(true);
        refused.flushPendingCaptures(await refused.loadPostHog());

        expect(posthog.capture.mock.calls.map(([event]) => event)).toStrictEqual(["$pageview"]);

        const pending = await loadClientModule();

        pending.recordLandingPageview();
        posthog.is_capturing.mockReturnValue(false);
        pending.flushPendingCaptures(await pending.loadPostHog());

        expect(posthog.capture).toHaveBeenCalledOnce();
    });

    it("is dropped with what a signed-out account queued", async () => {
        const client = await loadClientModule();

        client.recordLandingPageview();
        client.forgetPostHogIdentity("token");
        client.flushPendingCaptures(await client.loadPostHog());

        expect(posthog.capture).not.toHaveBeenCalled();
    });
});

describe("startPostHog", () => {
    beforeEach(() => {
        posthog.__loaded = true;
        posthog.has_opted_out_capturing.mockReturnValue(false);

        for (const method of [posthog.capture, posthog.captureException, posthog.group, posthog.identify, posthog.register, posthog.reset]) {
            method.mockReset();
        }
    });

    afterEach(() => {
        sessionStorage.clear();
    });

    const order = (method: { mock: { invocationCallOrder: number[] } }): number => method.mock.invocationCallOrder[0] ?? 0;

    it("after a sign-out while the chunk loaded, resets first and sends nothing the account that left queued", async () => {
        const client = await loadClientModule();

        client.queueEvent("before the sign-out", {});
        client.captureException("caught before the sign-out");
        client.forgetPostHogIdentity("key");
        client.queueEvent("after the sign-out", {});
        client.captureException("caught after the sign-out");
        client.setAnalyticsIdentity({});
        client.startPostHog(await client.loadPostHog(), () => {});

        expect(posthog.capture.mock.calls.map(([event]) => event)).toStrictEqual(["after the sign-out"]);
        expect(posthog.captureException.mock.calls.map(([error]) => error)).toStrictEqual(["caught after the sign-out"]);
        expect(posthog.reset).toHaveBeenCalledOnce();
        expect(order(posthog.reset)).toBeLessThan(order(posthog.capture));
        expect(order(posthog.reset)).toBeLessThan(order(posthog.captureException));
    });

    it("sends a signed-in user's queued event only once the session's identity and organization are applied", async () => {
        const client = await loadClientModule();
        const onStarted = vi.fn();

        client.queueEvent("onboarding_started", {});
        client.startPostHog(await client.loadPostHog(), onStarted);

        // The session has not answered yet: nothing is sent, and events still queue.
        expect(client.getStartedPostHog()).toBeUndefined();
        expect(posthog.capture).not.toHaveBeenCalled();

        client.setAnalyticsIdentity({ organization: { id: "org-1", name: "Acme" }, user: { email: "a@example.com", id: "user-1", name: "A" } });

        expect(posthog.identify).toHaveBeenCalledExactlyOnceWith("user-1", { email: "a@example.com", name: "A" });
        expect(posthog.group).toHaveBeenCalledExactlyOnceWith("organization", "org-1", { name: "Acme" });
        expect(posthog.capture).toHaveBeenCalledOnce();
        expect(order(posthog.identify)).toBeLessThan(order(posthog.capture));
        expect(order(posthog.group)).toBeLessThan(order(posthog.capture));
        expect(onStarted).toHaveBeenCalledOnce();
    });

    it("starts with the user alone once the organization stalls past the wait, and adds the group when it answers", async () => {
        vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });

        try {
            const client = await loadClientModule();

            client.queueEvent("onboarding_started", {});
            client.startPostHog(await client.loadPostHog(), () => {});
            client.setAnalyticsIdentity({ isOrganizationPending: true, user: { id: "user-1" } });

            expect(client.getStartedPostHog()).toBeUndefined();

            vi.advanceTimersByTime(client.ORGANIZATION_WAIT_MS);

            expect(client.getStartedPostHog()).toBe(posthog);
            expect(posthog.identify).toHaveBeenCalledWith("user-1", expect.anything());
            expect(posthog.capture.mock.calls.map(([event]) => event)).toContain("onboarding_started");
            expect(posthog.group).not.toHaveBeenCalled();

            client.setAnalyticsIdentity({ organization: { id: "org-1", name: "Acme" }, user: { id: "user-1" } });

            expect(posthog.group).toHaveBeenCalledExactlyOnceWith("organization", "org-1", { name: "Acme" });
        } finally {
            vi.useRealTimers();
        }
    });

    it("gives a user who switched in while the first one's organization was pending a full wait of their own", async () => {
        vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });

        try {
            const client = await loadClientModule();

            client.startPostHog(await client.loadPostHog(), () => {});
            client.setAnalyticsIdentity({ isOrganizationPending: true, user: { id: "user-a" } });
            vi.advanceTimersByTime(client.ORGANIZATION_WAIT_MS - 1);

            client.setAnalyticsIdentity({ isOrganizationPending: true, user: { id: "user-b" } });
            vi.advanceTimersByTime(1);

            // A's deadline passed, not B's.
            expect(client.getStartedPostHog()).toBeUndefined();

            vi.advanceTimersByTime(client.ORGANIZATION_WAIT_MS);

            expect(client.getStartedPostHog()).toBe(posthog);
        } finally {
            vi.useRealTimers();
        }
    });

    it("waits for a signed-in user's pending organization before it starts, then applies both", async () => {
        const client = await loadClientModule();

        client.queueEvent("onboarding_started", {});
        client.startPostHog(await client.loadPostHog(), () => {});
        client.setAnalyticsIdentity({ isOrganizationPending: true, user: { id: "user-1" } });

        expect(client.getStartedPostHog()).toBeUndefined();
        expect(posthog.capture).not.toHaveBeenCalled();

        client.setAnalyticsIdentity({ organization: { id: "org-1", name: "Acme" }, user: { id: "user-1" } });

        expect(client.getStartedPostHog()).toBe(posthog);
        expect(order(posthog.group)).toBeLessThan(order(posthog.capture));
    });

    it("identifies a switched account at once, without the old group, and adds the new group when it answers", async () => {
        const client = await loadClientModule();

        client.startPostHog(await client.loadPostHog(), () => {});
        client.setAnalyticsIdentity({ organization: { id: "org-1", name: "Acme" }, user: { id: "user-1" } });
        posthog.group.mockClear();
        posthog.identify.mockClear();
        posthog.reset.mockClear();

        // The new account's session answered; its organization has not.
        client.setAnalyticsIdentity({ isOrganizationPending: true, user: { id: "user-2" } });

        expect(posthog.reset).toHaveBeenCalledOnce();
        expect(posthog.identify).toHaveBeenCalledExactlyOnceWith("user-2", { email: undefined, name: undefined });
        expect(posthog.group).not.toHaveBeenCalled();

        client.setAnalyticsIdentity({ organization: { id: "org-1", name: "Acme" }, user: { id: "user-2" } });

        // The reset dropped the group, so even the same organization is applied again.
        expect(posthog.group).toHaveBeenCalledExactlyOnceWith("organization", "org-1", { name: "Acme" });
    });

    it("keeps what is tracked before measurement consent is known in memory only, and stores it once consent is granted", async () => {
        const client = await loadClientModule();

        client.queueEvent("onboarding_started", {});

        expect(sessionStorage.getItem(client.PENDING_EVENTS_KEY)).toBeNull();

        client.setMeasurementConsent(true);

        expect(JSON.parse(sessionStorage.getItem(client.PENDING_EVENTS_KEY) ?? "[]")).toMatchObject([{ event: "onboarding_started" }]);
    });

    it("drops a queued event past the age limit from storage, and never sends it", async () => {
        vi.useFakeTimers({ now: new Date("2026-11-12T10:00:00Z"), toFake: ["Date"] });

        try {
            const client = await loadClientModule();

            client.setMeasurementConsent(true);

            client.queueEvent("too_old", {});
            vi.setSystemTime(Date.now() + client.PENDING_EVENT_MAX_AGE_MS + 1);
            client.queueEvent("fresh", {});

            expect(globalThis.sessionStorage.getItem(client.PENDING_EVENTS_KEY)).not.toContain("too_old");

            client.startPostHog(await client.loadPostHog(), () => {});
            client.setAnalyticsIdentity({});

            expect(posthog.capture.mock.calls.map(([event]) => event)).toStrictEqual(["fresh"]);
        } finally {
            vi.useRealTimers();
        }
    });

    it.each([
        ["a sign-out that succeeded", (client: Awaited<ReturnType<typeof loadClientModule>>) => client.forgetPostHogIdentity("key")],
        ["a sign-out that failed", (client: Awaited<ReturnType<typeof loadClientModule>>) => client.dropPendingCaptures()],
    ])("keeps the sign-out event through the drop of %s, and sends it signed out on the next page", async (_name, drop) => {
        const client = await loadClientModule();

        client.setMeasurementConsent(true);

        client.setAnalyticsIdentity({ user: { id: "user-1" } });
        client.queueEvent("thread_opened", {});
        client.queueEvent("signed_out", {});
        drop(client);

        // The next page of this tab, which starts PostHog signed out.
        const next = await loadClientModule();

        next.setMeasurementConsent(true);

        next.startPostHog(await next.loadPostHog(), () => {});
        next.setAnalyticsIdentity({});

        expect(posthog.capture.mock.calls.map(([event]) => event)).toStrictEqual(["signed_out"]);
    });

    it("keeps an error caught before any account was known through a switch, and sends it", async () => {
        const client = await loadClientModule();
        const early = new Error("caught while the session loaded");

        client.captureException(early);
        client.setAnalyticsIdentity({ isOrganizationPending: true, user: { id: "user-a" } });
        client.captureException(new Error("caught for A"));
        client.setAnalyticsIdentity({ user: { id: "user-b" } });
        client.startPostHog(await client.loadPostHog(), () => {});

        expect(posthog.captureException).toHaveBeenCalledExactlyOnceWith(early, undefined);
    });

    it("drops an error caught under the account that left when another signs in before PostHog starts", async () => {
        const client = await loadClientModule();

        client.setAnalyticsIdentity({ isOrganizationPending: true, user: { id: "user-a" } });
        client.captureException(new Error("caught for A"));
        // Account B before PostHog has started.
        client.setAnalyticsIdentity({ user: { id: "user-b" } });
        client.startPostHog(await client.loadPostHog(), () => {});

        expect(posthog.captureException).not.toHaveBeenCalled();
    });

    it("resets the stored identity before the flush when the session ended while startup waited for it", async () => {
        const client = await loadClientModule();

        client.queueEvent("after_expiry", {});
        client.startPostHog(await client.loadPostHog(), () => {});
        // Signed in, waiting for the organization; then the session expires before it answers.
        client.setAnalyticsIdentity({ isOrganizationPending: true, user: { id: "user-1" } });
        client.setAnalyticsIdentity({});

        expect(client.getStartedPostHog()).toBe(posthog);
        expect(posthog.reset).toHaveBeenCalled();
        expect(order(posthog.reset)).toBeLessThan(order(posthog.capture));
    });

    it("runs onStarted (the first launch report) after the reset and the identity", async () => {
        const client = await loadClientModule();
        const onStarted = vi.fn();

        client.forgetPostHogIdentity("key");
        client.startPostHog(await client.loadPostHog(), onStarted);

        expect(onStarted).not.toHaveBeenCalled();

        client.setAnalyticsIdentity({ user: { id: "user-2" } });

        expect(order(posthog.reset)).toBeLessThan(order(posthog.identify));
        expect(order(posthog.identify)).toBeLessThan(order(onStarted));
    });

    it("does not identify the account that left again when the session still publishes it before the page leaves", async () => {
        const client = await loadClientModule();

        client.setAnalyticsIdentity({ user: { id: "user-1" } });
        client.forgetPostHogIdentity("key");
        // The session's last answer, published again before the sign-out navigation.
        client.setAnalyticsIdentity({ user: { id: "user-1" } });
        client.startPostHog(await client.loadPostHog(), () => {});

        // It waits for the session's next answer instead.
        expect(posthog.identify).not.toHaveBeenCalled();
        expect(client.getStartedPostHog()).toBeUndefined();

        client.setAnalyticsIdentity({});

        expect(client.getStartedPostHog()).toBe(posthog);
        expect(posthog.reset).toHaveBeenCalledOnce();
        expect(posthog.identify).not.toHaveBeenCalled();

        // Once started, a sign-out through `resetStartedPostHog` holds the same way; a new account is identified.
        client.setAnalyticsIdentity({ user: { id: "user-2" } });
        client.resetStartedPostHog(posthog as never);
        client.setAnalyticsIdentity({ user: { id: "user-2" } });

        expect(posthog.identify.mock.calls.map(([id]) => id)).toStrictEqual(["user-2"]);

        client.setAnalyticsIdentity({ user: { id: "user-3" } });

        expect(posthog.identify.mock.calls.map(([id]) => id)).toStrictEqual(["user-2", "user-3"]);
    });

    it("applies the organization group again after a switch to another user of the same organization", async () => {
        const client = await loadClientModule();
        const organization = { id: "org-1", name: "Acme" };

        client.setAnalyticsIdentity({ organization, user: { id: "user-1" } });
        client.startPostHog(await client.loadPostHog(), () => {});
        client.setAnalyticsIdentity({ organization, user: { id: "user-2" } });

        expect(posthog.group).toHaveBeenCalledTimes(2);
        expect(order(posthog.reset)).toBeLessThan(posthog.group.mock.invocationCallOrder[1] ?? 0);
    });

    it("sends an event queued under one account only to that account, and a signed-out one to whoever signs in", async () => {
        const before = await loadClientModule();

        before.setMeasurementConsent(true);

        before.setAnalyticsIdentity({ user: { id: "user-1" } });
        before.queueEvent("tracked as user-1", {});
        before.setAnalyticsIdentity({});
        before.queueEvent("tracked signed out", {});

        // A failed sign-out navigated with the queue kept; the next page is another account's.
        const after = await loadClientModule();

        after.setMeasurementConsent(true);

        after.setAnalyticsIdentity({ user: { id: "user-2" } });
        after.startPostHog(await after.loadPostHog(), () => {});

        expect(posthog.capture.mock.calls.map(([event]) => event)).toStrictEqual(["tracked signed out"]);
    });

    it("follows later sign-ins and sign-outs once started", async () => {
        const client = await loadClientModule();

        client.setAnalyticsIdentity({ user: { id: "user-1" } });
        client.startPostHog(await client.loadPostHog(), () => {});
        client.setAnalyticsIdentity({});

        expect(posthog.identify).toHaveBeenCalledOnce();
        expect(posthog.reset).toHaveBeenCalledOnce();
        expect(posthog.register).toHaveBeenLastCalledWith({ is_anonymous: true });
    });
});

describe("useFeatureFlagsKnown", () => {
    afterEach(() => {
        vi.unstubAllEnvs();
    });

    it("waits for the client's flags, or for PostHog to be known not to start", async () => {
        const client = await loadClientModule();
        const flagListeners: (() => void)[] = [];
        const fake = {
            onFeatureFlags: (callback: () => void) => {
                flagListeners.push(callback);

                return () => {};
            },
        } as unknown as PostHog;
        const state: { client?: PostHog } = {};
        const wrapper = ({ children }: { children: ReactNode }) => createElement(client.PostHogClientContext, { value: state.client }, children);
        const { rerender, result } = renderHook(() => client.useFeatureFlagsKnown(), { wrapper });

        // The chunk is still loading.
        expect(result.current).toBe(false);

        state.client = fake;
        rerender();

        expect(result.current).toBe(false);

        act(() => {
            for (const listener of flagListeners) {
                listener();
            }
        });

        expect(result.current).toBe(true);

        // Another page whose chunk failed for good: nothing waits for flags.
        const failed = await loadClientModule();
        const failedWrapper = ({ children }: { children: ReactNode }) => createElement(failed.PostHogClientContext, { value: undefined }, children);
        const { result: failedResult } = renderHook(() => failed.useFeatureFlagsKnown(), { wrapper: failedWrapper });

        expect(failedResult.current).toBe(false);

        act(() => {
            failed.markPostHogUnavailable();
        });

        expect(failedResult.current).toBe(true);
    });
});

describe("useFeatureFlagReader", () => {
    it("follows a flag reload on the same client, so a memo over it recomputes without a parent render", async () => {
        const client = await loadClientModule();
        const flags = new Set<string>();
        const listeners: (() => void)[] = [];
        const fake = {
            isFeatureEnabled: (flag: string) => flags.has(flag),
            onFeatureFlags: (callback: () => void) => {
                listeners.push(callback);

                return () => {};
            },
        } as unknown as PostHog;
        const wrapper = ({ children }: { children: ReactNode }) => createElement(client.PostHogClientContext, { value: fake }, children);
        const { result } = renderHook(
            () => {
                const read = client.useFeatureFlagReader();

                return useMemo(() => read("code-mode"), [read]);
            },
            { wrapper },
        );

        expect(result.current).toBe(false);

        act(() => {
            flags.add("code-mode");

            for (const listener of listeners) {
                listener();
            }
        });

        expect(result.current).toBe(true);
    });

    it("mounting another reader re-renders none of those already mounted", async () => {
        const client = await loadClientModule();
        const fake = {
            isFeatureEnabled: () => true,
            // As PostHog: a listener added while it holds flags is called at once.
            onFeatureFlags: (callback: () => void) => {
                callback();

                return () => {};
            },
        } as unknown as PostHog;
        const wrapper = ({ children }: { children: ReactNode }) => createElement(client.PostHogClientContext, { value: fake }, children);
        const renders = { count: 0 };

        renderHook(
            () => {
                renders.count += 1;

                return client.useFeatureFlagReader();
            },
            { wrapper },
        );

        const before = renders.count;

        renderHook(() => client.useFeatureFlagReader(), { wrapper });
        renderHook(() => client.useFeatureFlagReader(), { wrapper });

        expect(renders.count).toBe(before);
    });

    it("registers one PostHog listener per client, however many flag hooks read it", async () => {
        const client = await loadClientModule();
        const listeners: (() => void)[] = [];
        const fake = {
            isFeatureEnabled: () => true,
            onFeatureFlags: (callback: () => void) => {
                listeners.push(callback);

                return () => {};
            },
        } as unknown as PostHog;
        const wrapper = ({ children }: { children: ReactNode }) => createElement(client.PostHogClientContext, { value: fake }, children);

        renderHook(() => [client.useFeatureFlagEnabled("a"), client.useFeatureFlagEnabled("b"), client.useFeatureFlagsKnown(), client.useFeatureFlagReader()], {
            wrapper,
        });

        expect(listeners).toHaveLength(1);
    });

    it("keeps answering from the server-rendered flags while a retry runs after coming back online", async () => {
        const client = await loadClientModule();
        const wrapper = ({ children }: { children: ReactNode }) => createElement(client.PostHogClientContext, { value: undefined }, children);

        client.setBootstrapFlags({ "code-mode": true });

        const { result } = renderHook(
            () => [client.useFeatureFlagReader()("code-mode"), client.useFeatureFlagEnabled("code-mode"), client.useFeatureFlagsKnown()],
            {
                wrapper,
            },
        );

        act(() => {
            client.markPostHogUnavailable();
        });

        expect(result.current).toStrictEqual([true, true, true]);

        act(() => {
            client.markPostHogRetrying();
        });

        // The flags stay as the server rendered them; only what waits for final flags waits again.
        expect(result.current).toStrictEqual([true, true, false]);
    });

    it("reads pending while PostHog loads, the server-rendered flags once it will not start, and the client once there is one", async () => {
        const client = await loadClientModule();
        const state: { client?: PostHog } = {};
        const wrapper = ({ children }: { children: ReactNode }) => createElement(client.PostHogClientContext, { value: state.client }, children);

        client.setBootstrapFlags({ "code-mode": true });

        const { rerender, result } = renderHook(() => client.useFeatureFlagReader(), { wrapper });

        expect(result.current("code-mode")).toBeUndefined();

        act(() => {
            client.markPostHogUnavailable();
        });

        // A model or a nav link behind `code-mode` stays, as the server rendered it; one behind another flag goes.
        expect(result.current("code-mode")).toBe(true);
        expect(result.current("other")).toBe(false);

        state.client = { isFeatureEnabled: (flag: string) => flag === "other", onFeatureFlags: () => () => {} } as unknown as PostHog;
        rerender();

        expect(result.current("code-mode")).toBe(false);
        expect(result.current("other")).toBe(true);
    });
});

describe("useFeatureFlagEnabled", () => {
    it("is pending while PostHog loads, and answers from the server-rendered flags once it will not start", async () => {
        const client = await loadClientModule();
        const wrapper = ({ children }: { children: ReactNode }) => createElement(client.PostHogClientContext, { value: undefined }, children);

        client.setBootstrapFlags({ "code-mode": true, experiment: "variant-a", "off-flag": false });

        const { result } = renderHook(
            () => [
                client.useFeatureFlagEnabled("code-mode"),
                client.useFeatureFlagEnabled("experiment"),
                client.useFeatureFlagEnabled("off-flag"),
                client.useFeatureFlagEnabled("absent"),
            ],
            { wrapper },
        );

        // The chunk may still come: nothing is decided yet.
        expect(result.current).toStrictEqual([undefined, undefined, undefined, undefined]);

        act(() => {
            client.markPostHogUnavailable();
        });

        expect(result.current).toStrictEqual([true, true, false, false]);
    });

    it("stays pending on a provided client until its flags arrive, then follows them", async () => {
        const client = await loadClientModule();
        const flags = new Set<string>();
        const listeners: (() => void)[] = [];
        const fake = {
            isFeatureEnabled: (flag: string) => flags.has(flag),
            onFeatureFlags: (callback: () => void) => {
                listeners.push(callback);

                return () => {};
            },
        } as unknown as PostHog;
        const wrapper = ({ children }: { children: ReactNode }) => createElement(client.PostHogClientContext, { value: fake }, children);
        const { result } = renderHook(() => client.useFeatureFlagEnabled("code-mode"), { wrapper });

        // Initialised, flags not loaded: an "off" now would show the workspace as denied.
        expect(result.current).toBeUndefined();

        act(() => {
            flags.add("code-mode");

            for (const listener of listeners) {
                listener();
            }
        });

        expect(result.current).toBe(true);
    });

    it("reads as off, not pending, on a page whose PostHog never loads and that had no server-rendered flags", async () => {
        const client = await loadClientModule();
        const wrapper = ({ children }: { children: ReactNode }) => createElement(client.PostHogClientContext, { value: undefined }, children);
        const { result } = renderHook(() => client.useFeatureFlagEnabled("code-mode"), { wrapper });

        act(() => {
            client.markPostHogUnavailable();
        });

        expect(result.current).toBe(false);
    });
});
