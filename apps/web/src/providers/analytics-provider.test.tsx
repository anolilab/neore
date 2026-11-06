/**
 * The analytics provider hands PostHog a `before_send` that keeps a prompt link's text out of every event it sends.
 */
import { render } from "@testing-library/react";
import { posthog } from "posthog-js";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import AnalyticsProvider from "./analytics-provider";

vi.mock("posthog-js", () => {
    return {
        posthog: {
            debug: vi.fn(),
            has_opted_out_capturing: vi.fn(() => false),
            init: vi.fn(),
            opt_in_capturing: vi.fn(),
            opt_out_capturing: vi.fn(),
        },
    };
});

vi.mock("posthog-js/react", () => {
    return {
        PostHogProvider: ({ children }: { children: ReactNode }) => children,
    };
});

vi.mock("@/lib/analytics/first-native-launch", () => {
    return {
        reportFirstNativeLaunch: vi.fn(),
    };
});

describe("AnalyticsProvider", () => {
    beforeEach(() => {
        vi.stubEnv("DEV", false);
        vi.stubEnv("VITE_POSTHOG_API_KEY", "phc_test");
        vi.stubEnv("VITE_POSTHOG_HOST", "https://eu.i.posthog.com");
    });

    afterEach(() => {
        vi.unstubAllEnvs();
        vi.clearAllMocks();
    });

    it("initialises PostHog with a before_send that removes a prompt link's text from the page URL", () => {
        render(
            <AnalyticsProvider>
                <span>app</span>
            </AnalyticsProvider>,
        );

        expect(posthog.init).toHaveBeenCalledTimes(1);

        const options = vi.mocked(posthog.init).mock.calls[0]?.[1] as { before_send?: (event: unknown) => unknown; session_recording?: unknown } | undefined;

        expect(typeof options?.before_send).toBe("function");

        // The composer's draft is masked in session replay: the selector names the attribute the editor sets.
        expect(options?.session_recording).toEqual({ maskTextSelector: "[data-ph-mask]" });

        const event = {
            event: "$pageview",
            properties: { $current_url: "https://app.example.com/chat?prompt=Summarise%20the%20merger%20plan&model=gpt-4o" },
        };
        const sent = options?.before_send?.(event) as typeof event;

        expect(JSON.stringify(sent)).not.toContain("merger");
        expect(sent.properties.$current_url).toBe("https://app.example.com/chat?model=gpt-4o");

        // A sign-in route records the link in its own URL, encoded as its return address.
        const signIn = new URL("https://app.example.com/auth/sign-in");

        signIn.searchParams.set("redirectTo", "/chat?prompt=Summarise%20the%20merger%20plan&model=gpt-4o");

        const onSignIn = options?.before_send?.({ event: "$pageview", properties: { $current_url: signIn.href } }) as typeof event;

        expect(JSON.stringify(onSignIn)).not.toContain("merger");

        // A recording snapshot of a prompt link's page is not sent at all: PostHog's hook returns null for it.
        const recording = options?.before_send?.({
            event: "$snapshot",
            properties: { $current_url: "https://app.example.com/chat?prompt=Summarise%20the%20merger%20plan", $snapshot_data: {} },
        });

        expect(recording).toBeNull();
    });
});
