import { createPostHogPlugin } from "@onboardjs/posthog-plugin";
import type { PostHog } from "posthog-js";
import { useState } from "react";

import { useStartedPostHog } from "@/lib/analytics/posthog-client";

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
 * The onboarding flow's PostHog plugin, once PostHog has started (its reset after a sign-out and the session's identity
 * applied, so the plugin's events go out as the right person): PostHog loads after mount, so the dialog can open
 * first and gains the plugin when the client arrives. Building one in render is safe: `createPostHogPlugin` only
 * stores its config, and the plugin registers its listeners in `install`, which `OnboardingProvider` calls after
 * commit, so a render React abandons leaves nothing behind. Kept in state, not a memo, so the plugin installed is
 * the one rendered: React may drop a memo cache. A new plugin is built only when the client changes.
 */
const useOnboardingPlugins = (): OnboardingPlugins => {
    const client = useStartedPostHog();
    const [state, setState] = useState(() => buildPlugins(client));

    if (state.client !== client) {
        const next = buildPlugins(client);

        setState(next);

        return next.plugins;
    }

    return state.plugins;
};

export default useOnboardingPlugins;
