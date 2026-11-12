import { renderHook } from "@testing-library/react";
import type { PostHog } from "posthog-js";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";

import { PostHogClientContext } from "@/lib/analytics/posthog-client";

const createPostHogPlugin = vi.hoisted(() =>
    vi.fn((config: { posthogInstance: unknown }) => {
        return { config };
    }),
);

vi.mock("@onboardjs/posthog-plugin", () => {
    return { createPostHogPlugin };
});

const { default: useOnboardingPlugins } = await import("./use-onboarding-plugins");

const withClient =
    (client: PostHog | undefined) =>
    ({ children }: { children: ReactNode }) => <PostHogClientContext value={client}>{children}</PostHogClientContext>;

describe(useOnboardingPlugins, () => {
    it("installs the plugin when PostHog loads after the dialog mounted, and keeps it across rerenders", () => {
        let client: PostHog | undefined;
        const { rerender, result } = renderHook(() => useOnboardingPlugins(), {
            wrapper: ({ children }: { children: ReactNode }) => withClient(client)({ children }),
        });

        expect(result.current).toStrictEqual([]);

        client = { __loaded: true } as unknown as PostHog;
        rerender();

        expect(result.current).toHaveLength(1);
        expect(createPostHogPlugin).toHaveBeenCalledWith(expect.objectContaining({ posthogInstance: client }));

        const [plugin] = result.current;

        rerender();

        expect(result.current[0]).toBe(plugin);
        expect(createPostHogPlugin).toHaveBeenCalledOnce();
    });
});
