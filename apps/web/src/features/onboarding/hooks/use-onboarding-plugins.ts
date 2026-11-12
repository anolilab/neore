import { createPostHogPlugin } from "@onboardjs/posthog-plugin";
import type { PostHog } from "posthog-js";
import { useState } from "react";

import { usePostHog } from "@/lib/analytics/posthog-client";

type OnboardingPlugins = ReturnType<typeof createPostHogPlugin>[];

interface PluginState {
    client: PostHog | undefined;
    plugins: OnboardingPlugins;
}

const buildPlugins = (client: PostHog | undefined): PluginState => {
    if (typeof window === "undefined" || !client?.__loaded) {
        return { client, plugins: [] };
    }

    return {
        client,
        plugins: [
            createPostHogPlugin({
                churnTimeoutMs: 30_000,
                debug: import.meta.env.DEV,
                enableChurnDetection: true,
                enablePerformanceTracking: true,
                enableProgressMilestones: true,
                excludePersonalData: true,
                milestonePercentages: [25, 50, 75, 100],
                performanceThresholds: {
                    slowRenderMs: 500,
                    slowStepMs: 10_000,
                },
                posthogInstance: client,
            }),
        ],
    };
};

/**
 * The onboarding flow's PostHog plugin, once PostHog has loaded: PostHog loads after mount, so the dialog can open
 * first and gains the plugin when the client arrives. Kept in state, not a memo: React may drop a memo cache, and a
 * new plugin would register its PostHog listeners again. A new plugin is built only when the client changes.
 */
const useOnboardingPlugins = (): OnboardingPlugins => {
    const client = usePostHog();
    const [state, setState] = useState(() => buildPlugins(client));

    if (state.client !== client) {
        const next = buildPlugins(client);

        setState(next);

        return next.plugins;
    }

    return state.plugins;
};

export default useOnboardingPlugins;
