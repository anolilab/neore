import { act, render, screen } from "@testing-library/react";
import type { PostHogInterface } from "posthog-js";
import type { FC } from "react";
import { useEffect } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const permissions = vi.hoisted(() => {
    return { measurement: false };
});
const posthogMock = vi.hoisted(() => {
    return {
        __loaded: false,
        capture: vi.fn(),
        captureException: vi.fn(),
        debug: vi.fn(),
        get_distinct_id: vi.fn(() => "anonymous-1"),
        get_property: vi.fn((_key: string): unknown => undefined),
        group: vi.fn(),
        has_opted_out_capturing: vi.fn(() => false),
        identify: vi.fn(),
        is_capturing: vi.fn(() => true),
        // Flags that never arrive: only a start that failed for good settles them here.
        onFeatureFlags: vi.fn(() => () => {}),
        init: vi.fn((_key: string, config: { loaded?: (posthog: unknown) => void }) => {
            // Like posthog-js: `init` marks the singleton loaded and calls `loaded`.
            posthogMock.__loaded = true;
            config.loaded?.(posthogMock);
        }),
        opt_in_capturing: vi.fn(),
        opt_out_capturing: vi.fn(),
        register: vi.fn(),
        reset: vi.fn(),
    };
});

vi.mock("@c15t/react", () => {
    return { useEffectivePermissions: () => permissions };
});
const loadPostHog = vi.hoisted(() => vi.fn());

const reportFirstNativeLaunch = vi.hoisted(() => vi.fn());

vi.mock("@/lib/analytics/first-native-launch", () => {
    return { reportFirstNativeLaunch };
});

/** Fresh modules, as on a new page: PostHog starts once per page. */
const loadModules = async () => {
    vi.resetModules();
    vi.doMock("@/lib/analytics/posthog-client", async (importOriginal) => {
        return { ...(await importOriginal<typeof import("@/lib/analytics/posthog-client")>()), getPostHog: () => posthogMock, loadPostHog };
    });

    return { ...(await import("./analytics-provider")), ...(await import("@/lib/analytics/posthog-client")) };
};

const { onPostHogLoaded, PostHogConsentSync, START_RETRY_DELAY_MS } = await loadModules();

describe("PostHog consent sync", () => {
    beforeEach(() => {
        vi.stubEnv("DEV", false);
        posthogMock.__loaded = false;
        posthogMock.opt_in_capturing.mockClear();
        posthogMock.opt_out_capturing.mockClear();
    });

    afterEach(() => {
        vi.unstubAllEnvs();
    });

    it("applies a consent state that arrived before PostHog loaded once it loads", () => {
        permissions.measurement = false;
        render(<PostHogConsentSync />);

        expect(posthogMock.opt_out_capturing).not.toHaveBeenCalled();

        posthogMock.__loaded = true;
        onPostHogLoaded(posthogMock as unknown as PostHogInterface);

        expect(posthogMock.opt_out_capturing).toHaveBeenCalledOnce();
        expect(posthogMock.opt_in_capturing).not.toHaveBeenCalled();
    });

    it("follows a later change once PostHog has loaded", () => {
        posthogMock.__loaded = true;
        permissions.measurement = false;
        const { rerender } = render(<PostHogConsentSync />);

        permissions.measurement = true;
        rerender(<PostHogConsentSync />);

        expect(posthogMock.opt_in_capturing).toHaveBeenCalledOnce();
    });
});

describe("AnalyticsProvider", () => {
    let modules: Awaited<ReturnType<typeof loadModules>>;
    let AnalyticsProvider: (typeof modules)["default"];
    let ClientState: FC;

    beforeEach(() => {
        vi.stubEnv("DEV", false);
        vi.stubEnv("VITE_POSTHOG_API_KEY", "key");
        vi.stubEnv("VITE_POSTHOG_HOST", "https://posthog.test");
        loadPostHog.mockReset();
        posthogMock.__loaded = false;
        posthogMock.init.mockClear();
        posthogMock.reset.mockClear();
        posthogMock.capture.mockClear();
        posthogMock.captureException.mockClear();
        reportFirstNativeLaunch.mockClear();
    });

    beforeEach(async () => {
        modules = await loadModules();
        modules.setMeasurementConsent(true);
        const { useFeatureFlagsKnown, usePostHog } = modules;

        AnalyticsProvider = modules.default;

        ClientState = () => (
            <>
                <p>{usePostHog() ? "analytics on" : "analytics off"}</p>
                <p>{useFeatureFlagsKnown() ? "flags known" : "flags pending"}</p>
            </>
        );
    });

    afterEach(() => {
        vi.useRealTimers();
        vi.unstubAllEnvs();
        vi.restoreAllMocks();
    });

    it("reports an error caught before its chunk loaded, even when the global boundary unmounted the provider meanwhile", async () => {
        let resolveChunk: (posthog: typeof posthogMock) => void = () => {};

        loadPostHog.mockReturnValue(
            // eslint-disable-next-line unicorn/prefer-promise-with-resolvers -- the web lib target has no Promise.withResolvers
            new Promise((resolve) => {
                resolveChunk = resolve;
            }),
        );

        const { unmount } = render(
            <AnalyticsProvider>
                <ClientState />
            </AnalyticsProvider>,
        );
        const crash = new Error("crashed on first render");

        // The global boundary reports the crash, then its fallback replaces the tree this provider is in.
        modules.captureException(crash, { errorBoundary: "global" });
        unmount();

        await act(async () => {
            resolveChunk(posthogMock);
            await Promise.resolve();
        });

        expect(posthogMock.init).toHaveBeenCalledOnce();
        expect(posthogMock.captureException).toHaveBeenCalledExactlyOnceWith(crash, { errorBoundary: "global" });
        const [initOrder = 0] = posthogMock.init.mock.invocationCallOrder;
        const [captureOrder = 0] = posthogMock.captureException.mock.invocationCallOrder;

        expect(captureOrder).toBeGreaterThan(initOrder);
    });

    it("sends the page it mounted on as the first page view, not the one the visitor reached while the chunk loaded", async () => {
        let resolveChunk: (posthog: typeof posthogMock) => void = () => {};

        loadPostHog.mockReturnValue(
            // eslint-disable-next-line unicorn/prefer-promise-with-resolvers -- the web lib target has no Promise.withResolvers
            new Promise((resolve) => {
                resolveChunk = resolve;
            }),
        );
        globalThis.history.replaceState(null, "", "/pricing?utm_source=newsletter");

        render(
            <AnalyticsProvider>
                <ClientState />
            </AnalyticsProvider>,
        );

        // An in-app link followed before posthog-js arrived.
        globalThis.history.replaceState(null, "", "/chat");

        await act(async () => {
            resolveChunk(posthogMock);
            await Promise.resolve();
        });
        // The signed-out session answers; PostHog starts.
        modules.setAnalyticsIdentity({});
        globalThis.history.replaceState(null, "", "/");

        expect(posthogMock.init).toHaveBeenCalledWith("key", expect.objectContaining({ capture_pageleave: true, capture_pageview: false }));
        expect(posthogMock.capture).toHaveBeenCalledExactlyOnceWith(
            "$pageview",
            expect.objectContaining({ $current_url: `${globalThis.location.origin}/pricing?utm_source=newsletter`, $pathname: "/pricing" }),
            { timestamp: expect.any(Date) },
        );
    });

    it("logs a failed start and, while online, tries once more after a short wait", async () => {
        vi.useFakeTimers();
        const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
        const failure = new Error("chunk failed");

        loadPostHog.mockRejectedValueOnce(failure).mockRejectedValueOnce(failure).mockResolvedValue(posthogMock);

        render(
            <AnalyticsProvider>
                <ClientState />
            </AnalyticsProvider>,
        );

        await act(async () => {
            await vi.advanceTimersByTimeAsync(0);
        });

        expect(warn).toHaveBeenCalledExactlyOnceWith("[PostHog] Analytics did not start:", failure);
        expect(loadPostHog).toHaveBeenCalledOnce();
        // The retry may still bring the flags.
        expect(screen.getByText("flags pending")).toBeTruthy();

        await act(async () => {
            await vi.advanceTimersByTimeAsync(START_RETRY_DELAY_MS);
        });

        // The one retry failed too: no more timers, only the `online` event tries again, and nothing waits for flags.
        expect(loadPostHog).toHaveBeenCalledTimes(2);
        expect(screen.getByText("flags known")).toBeTruthy();

        await act(async () => {
            await vi.advanceTimersByTimeAsync(START_RETRY_DELAY_MS * 10);
        });

        expect(loadPostHog).toHaveBeenCalledTimes(2);

        await act(async () => {
            globalThis.dispatchEvent(new Event("online"));
            await vi.advanceTimersByTimeAsync(0);
        });

        expect(posthogMock.init).toHaveBeenCalledOnce();
        expect(screen.getByText("analytics on")).toBeTruthy();
        // The client that started once back online has not had its flags yet: what reads them waits again.
        expect(screen.getByText("flags pending")).toBeTruthy();
    });

    it("records the landing page view before what a descendant queues on mount", async () => {
        // The chunk never arrives here: the queue is flushed by hand below.
        loadPostHog.mockReturnValue(new Promise(() => {}));

        const { queueEvent } = modules;
        const Onboarding = () => {
            useEffect(() => {
                queueEvent("onboarding_started", {});
            }, []);

            return null;
        };

        render(
            <AnalyticsProvider>
                <Onboarding />
            </AnalyticsProvider>,
        );

        posthogMock.capture.mockClear();
        modules.flushPendingCaptures(posthogMock as unknown as Parameters<typeof modules.flushPendingCaptures>[0]);

        expect(posthogMock.capture.mock.calls.map(([event]) => event)).toStrictEqual(["$pageview", "onboarding_started"]);
    });

    it("keeps its retry after it unmounts (the global boundary's fallback), so a queued crash is still sent", async () => {
        vi.useFakeTimers();
        vi.spyOn(console, "warn").mockImplementation(() => {});
        loadPostHog.mockRejectedValueOnce(new Error("chunk failed")).mockResolvedValue(posthogMock);

        const view = render(
            <AnalyticsProvider>
                <ClientState />
            </AnalyticsProvider>,
        );

        await act(async () => {
            await vi.advanceTimersByTimeAsync(0);
        });

        expect(loadPostHog).toHaveBeenCalledOnce();

        view.unmount();

        await act(async () => {
            await vi.advanceTimersByTimeAsync(START_RETRY_DELAY_MS);
        });

        expect(loadPostHog).toHaveBeenCalledTimes(2);
        expect(posthogMock.init).toHaveBeenCalledOnce();
    });

    it("loads PostHog again once the window is back online after its chunk failed to load", async () => {
        vi.spyOn(console, "warn").mockImplementation(() => {});
        vi.spyOn(globalThis.navigator, "onLine", "get").mockReturnValue(false);
        loadPostHog.mockRejectedValueOnce(new Error("offline")).mockResolvedValue(posthogMock);

        render(
            <AnalyticsProvider>
                <ClientState />
            </AnalyticsProvider>,
        );

        await act(async () => {
            await Promise.resolve();
        });

        expect(screen.getByText("analytics off")).toBeTruthy();
        expect(posthogMock.init).not.toHaveBeenCalled();

        await act(async () => {
            globalThis.dispatchEvent(new Event("online"));
            await Promise.resolve();
        });

        expect(loadPostHog).toHaveBeenCalledTimes(2);
        expect(posthogMock.init).toHaveBeenCalledOnce();
        expect(screen.getByText("analytics on")).toBeTruthy();
    });

    it("resets the identity it was bootstrapped with when a sign-out came before its chunk loaded", async () => {
        loadPostHog.mockResolvedValue(posthogMock);
        modules.forgetPostHogIdentity("key");
        modules.setAnalyticsIdentity({});

        render(
            <AnalyticsProvider>
                <ClientState />
            </AnalyticsProvider>,
        );

        await act(async () => {
            await Promise.resolve();
        });

        expect(posthogMock.init).toHaveBeenCalledOnce();
        expect(posthogMock.reset).toHaveBeenCalledOnce();
        const [initOrder = 0] = posthogMock.init.mock.invocationCallOrder;
        const [resetOrder = 0] = posthogMock.reset.mock.invocationCallOrder;

        expect(resetOrder).toBeGreaterThan(initOrder);
    });

    it("reports a first native launch only after the reset a sign-out during the load asked for", async () => {
        loadPostHog.mockResolvedValue(posthogMock);
        modules.forgetPostHogIdentity("key");
        modules.setAnalyticsIdentity({});

        render(
            <AnalyticsProvider>
                <ClientState />
            </AnalyticsProvider>,
        );

        await act(async () => {
            await Promise.resolve();
        });

        expect(posthogMock.reset).toHaveBeenCalledOnce();
        expect(reportFirstNativeLaunch).toHaveBeenCalledOnce();
        const [resetOrder = 0] = posthogMock.reset.mock.invocationCallOrder;
        const [reportOrder = 0] = reportFirstNativeLaunch.mock.invocationCallOrder;

        expect(reportOrder).toBeGreaterThan(resetOrder);
    });
});

describe("load timing start", () => {
    afterEach(() => {
        vi.unstubAllGlobals();
        Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
    });

    it("starts the reporter as soon as the page is hidden, before the browser is idle", async () => {
        const reportLoadTiming = vi.fn();

        vi.stubGlobal("requestIdleCallback", vi.fn());

        const modules = await loadModules();

        vi.doMock("@/lib/analytics/load-timing/report-load-timing", () => {
            return { reportLoadTiming };
        });

        modules.onPostHogLoaded(posthogMock as unknown as PostHogInterface);

        Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" });
        document.dispatchEvent(new Event("visibilitychange"));

        await vi.waitFor(() => {
            expect(reportLoadTiming).toHaveBeenCalled();
        });
    });
});
