import { renderHook } from "@testing-library/react";
import type { PostHog } from "posthog-js";
import { describe, expect, it, vi } from "vitest";

const started = vi.hoisted(() => {
    return { client: undefined as unknown };
});

vi.mock("@/lib/analytics/posthog-client", () => {
    return { useStartedPostHog: () => started.client };
});

const createPostHogPlugin = vi.hoisted(() =>
    vi.fn((config: { posthogInstance: unknown }) => {
        return { config };
    }),
);

vi.mock("@onboardjs/posthog-plugin", () => {
    return { createPostHogPlugin };
});

const { default: useOnboardingPlugins } = await import("./use-onboarding-plugins");

describe(useOnboardingPlugins, () => {
    it("installs the plugin once PostHog has started after the dialog mounted, and keeps it across rerenders", () => {
        started.client = undefined;

        const { rerender, result } = renderHook(() => useOnboardingPlugins());

        // Initialised maybe, not started: the identity is not applied yet, so nothing captures.
        expect(result.current).toStrictEqual([]);

        const client = { __loaded: true } as unknown as PostHog;

        started.client = client;
        rerender();

        expect(result.current).toHaveLength(1);
        expect(createPostHogPlugin).toHaveBeenCalledWith(expect.objectContaining({ posthogInstance: client }));

        const [plugin] = result.current;

        rerender();

        expect(result.current[0]).toBe(plugin);
        expect(createPostHogPlugin).toHaveBeenCalledOnce();
    });

    it("builds a plugin that touches nothing on the client until it is installed, so an abandoned render leaves no listeners", async () => {
        const actual = await vi.importActual<typeof import("@onboardjs/posthog-plugin")>("@onboardjs/posthog-plugin");
        const touched: PropertyKey[] = [];
        const client = new Proxy(
            {},
            {
                get: (_target, key) => {
                    touched.push(key);

                    return undefined;
                },
            },
        ) as PostHog;

        actual.createPostHogPlugin({ posthogInstance: client });

        expect(touched).toStrictEqual([]);
    });
});
