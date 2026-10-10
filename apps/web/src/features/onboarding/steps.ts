import type { OnboardingStep } from "@onboardjs/react";

export interface NeoreOnboardingPayload {
    description: string;
    /** lucide-react icon name used by the step component */
    icon: "brain-circuit" | "file-text" | "message-square" | "repeat" | "sparkles";
    title: string;
}

export const ONBOARDING_FLOW_ID = "neore-welcome";

export const ONBOARDING_PERSISTENCE_KEY = "neore-onboarding-progress";

export const onboardingSteps: OnboardingStep[] = [
    {
        id: "welcome",
        payload: {
            description: "one-workspace-description",
            icon: "sparkles",
            title: "welcome-title",
        } satisfies NeoreOnboardingPayload,
    },
    {
        id: "models",
        payload: {
            description: "multi-model-description",
            icon: "repeat",
            title: "models-title",
        } satisfies NeoreOnboardingPayload,
    },
    {
        id: "media",
        payload: {
            description: "media-generation-description",
            icon: "brain-circuit",
            title: "media-title",
        } satisfies NeoreOnboardingPayload,
    },
    {
        id: "canvas",
        payload: {
            description: "canvas-editor-description",
            icon: "file-text",
            title: "canvas-title",
        } satisfies NeoreOnboardingPayload,
    },
    {
        id: "start",
        payload: {
            description: "start-chatting-description",
            icon: "message-square",
            title: "start-title",
        } satisfies NeoreOnboardingPayload,
    },
];
