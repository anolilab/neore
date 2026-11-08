import { render } from "@testing-library/react";
import type { PostHogInterface } from "posthog-js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const permissions = vi.hoisted(() => {
    return { measurement: false };
});
const posthogMock = vi.hoisted(() => {
    return {
        __loaded: false,
        debug: vi.fn(),
        opt_in_capturing: vi.fn(),
        opt_out_capturing: vi.fn(),
    };
});

vi.mock("@c15t/react", () => {
    return { useEffectivePermissions: () => permissions };
});
vi.mock("posthog-js", () => {
    return { posthog: posthogMock };
});
vi.mock("@/lib/analytics/first-native-launch", () => {
    return { reportFirstNativeLaunch: vi.fn() };
});

const { onPostHogLoaded, PostHogConsentSync } = await import("./analytics-provider");

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
