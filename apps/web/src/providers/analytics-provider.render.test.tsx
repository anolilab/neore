import { act, render, screen } from "@testing-library/react";
import type { PostHogInterface } from "posthog-js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const permissions = vi.hoisted(() => {
    return { measurement: false };
});
const posthogMock = vi.hoisted(() => {
    return {
        __loaded: false,
        debug: vi.fn(),
        init: vi.fn(),
        opt_in_capturing: vi.fn(),
        opt_out_capturing: vi.fn(),
        reset: vi.fn(),
    };
});

vi.mock("@c15t/react", () => {
    return { useEffectivePermissions: () => permissions };
});
const loadPostHog = vi.hoisted(() => vi.fn());

vi.mock("@/lib/analytics/posthog-client", async (importOriginal) => {
    return { ...(await importOriginal<typeof import("@/lib/analytics/posthog-client")>()), getPostHog: () => posthogMock, loadPostHog };
});
vi.mock("@/lib/analytics/first-native-launch", () => {
    return { reportFirstNativeLaunch: vi.fn() };
});

const { default: AnalyticsProvider, onPostHogLoaded, PostHogConsentSync } = await import("./analytics-provider");
const { forgetPostHogIdentity, usePostHog } = await import("@/lib/analytics/posthog-client");

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

const ClientState = () => <p>{usePostHog() ? "analytics on" : "analytics off"}</p>;

describe("AnalyticsProvider", () => {
    beforeEach(() => {
        vi.stubEnv("DEV", false);
        vi.stubEnv("VITE_POSTHOG_API_KEY", "key");
        vi.stubEnv("VITE_POSTHOG_HOST", "https://posthog.test");
        loadPostHog.mockReset();
        posthogMock.init.mockClear();
        posthogMock.reset.mockClear();
    });

    afterEach(() => {
        vi.unstubAllEnvs();
    });

    it("loads PostHog again once the window is back online after its chunk failed to load", async () => {
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
        forgetPostHogIdentity("key");

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
});
