import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const posthog = vi.hoisted(() => {
    return {
        __loaded: false,
        capture: vi.fn(),
        captureException: vi.fn(),
        group: vi.fn(),
        has_opted_out_capturing: vi.fn(() => false),
        identify: vi.fn(),
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
            ["anonymous_session_started", { provider: "anonymous" }, { timestamp: new Date("2026-11-12T10:00:00.000Z") }],
            ["onboarding_started", {}, { timestamp: new Date("2026-11-12T10:00:02.000Z") }],
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
