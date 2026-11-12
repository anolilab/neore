import { act, renderHook } from "@testing-library/react";
import type { PostHog } from "posthog-js";
import type { ReactNode } from "react";
import { createElement } from "react";
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

        for (let index = 0; index < before.MAX_PENDING_EVENTS + 1; index += 1) {
            before.queueEvent(`event ${index}`, {});
        }

        // The desktop sign-in tracks, then loads `/chat` before PostHog could load.
        const after = await loadClientModule();

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

        before.setAnalyticsIdentity({ user: { id: "user-1" } });
        before.queueEvent("tracked as user-1", {});
        before.setAnalyticsIdentity({});
        before.queueEvent("tracked signed out", {});

        // A failed sign-out navigated with the queue kept; the next page is another account's.
        const after = await loadClientModule();

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
