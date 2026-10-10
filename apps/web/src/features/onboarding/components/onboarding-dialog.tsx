"use client";

import { useLingui } from "@lingui/react/macro";
import { Button } from "@neore/ui/components/button";
import { Dialog, DialogPopup, DialogTitle } from "@neore/ui/components/dialog";
import cn from "@neore/ui/utils/cn";
import { createPostHogPlugin } from "@onboardjs/posthog-plugin";
import type { OnboardingError } from "@onboardjs/react";
import { OnboardingErrorBoundary, OnboardingProvider, useOnboarding } from "@onboardjs/react";
import { ArrowLeft, ArrowRight, BrainCircuit, Check, FileText, Image, Loader2, MessageSquare, Repeat, Search, Sparkles } from "lucide-react";
import { AnimatePresence, motion, MotionConfig } from "motion/react";
import { posthog } from "posthog-js";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import useIsAnonymous from "@/features/auth/hooks/use-is-anonymous";
import { useUserPreferences } from "@/features/layout/hooks/use-ui-state";
import { LANDING_MESSAGE_KEY } from "@/features/marketing/stores/landing-store";
import { trackEvent } from "@/lib/analytics";

import { shouldShowOnboarding } from "../should-show-onboarding";
import type { NeoreOnboardingPayload } from "../steps";
import { ONBOARDING_FLOW_ID, ONBOARDING_PERSISTENCE_KEY, onboardingSteps } from "../steps";

const STEP_ICONS: Record<NeoreOnboardingPayload["icon"], React.ReactNode> = {
    "brain-circuit": <BrainCircuit aria-hidden="true" className="size-8" />,
    "file-text": <FileText aria-hidden="true" className="size-8" />,
    "message-square": <MessageSquare aria-hidden="true" className="size-8" />,
    repeat: <Repeat aria-hidden="true" className="size-8" />,
    sparkles: <Sparkles aria-hidden="true" className="size-8" />,
};

const useStepTranslations = () => {
    const { t } = useLingui();

    return useMemo(() => {
        return {
            "canvas-editor-description": t`Write long-form content in a side-by-side canvas editor. Go from chat to finished document without switching tools.`,
            "canvas-title": t`Built-in Canvas Editor`,
            "media-generation-description": t`Generate images with FLUX and Stable Diffusion, create videos with Runway and Luma — all from the same chat.`,
            "media-title": t`Create Images and Videos`,
            "models-title": t`30+ Models, One Thread`,
            "multi-model-description": t`Access GPT-4, Claude, Gemini, and more from a single conversation. Switch models mid-thread to compare answers.`,
            "one-workspace-description": t`One workspace for chat, images, video, documents, and code. 30+ AI models, one subscription.`,
            "start-chatting-description": t`Pick a starting point or jump straight into chat.`,
            "start-title": t`Start Your First Chat`,
            "welcome-title": t`Welcome to Neore`,
        };
    }, [t]);
};

/** Template cards shown on the final step to drive activation */
interface PromptTemplate {
    icon: React.ReactNode;
    label: string;
    prompt: string;
}

const usePromptTemplates = (): PromptTemplate[] => {
    const { t } = useLingui();

    return [
        {
            icon: <MessageSquare aria-hidden="true" className="size-4" />,
            label: t`Write something`,
            prompt: t`Help me write a professional email to introduce myself to a new team.`,
        },
        {
            icon: <Image aria-hidden="true" className="size-4" />,
            label: t`Generate an image`,
            prompt: t`Generate an image of a cozy reading nook with warm lighting and plants.`,
        },
        {
            icon: <Repeat aria-hidden="true" className="size-4" />,
            label: t`Compare models`,
            prompt: t`Compare how different AI models explain quantum computing to a beginner.`,
        },
        {
            icon: <Search aria-hidden="true" className="size-4" />,
            label: t`Research a topic`,
            prompt: t`Research the latest developments in renewable energy storage technology.`,
        },
    ];
};

const TemplatePicker: React.FC<{
    onSelectTemplate: (prompt: string) => void;
}> = ({ onSelectTemplate }) => {
    const templates = usePromptTemplates();

    return (
        <div className="mt-2 grid w-full max-w-sm grid-cols-2 gap-2">
            {templates.map((template) => (
                <button
                    className="border-border hover:border-primary/50 hover:bg-primary/5 flex items-center gap-2 rounded-lg border p-3 text-left text-xs transition-colors"
                    key={template.label}
                    onClick={() => onSelectTemplate(template.prompt)}
                    type="button"
                >
                    <span className="text-primary shrink-0">{template.icon}</span>
                    <span className="font-medium">{template.label}</span>
                </button>
            ))}
        </div>
    );
};

/** Navigate to /chat with a pre-filled prompt using the existing sessionStorage pattern. */
const navigateToChatWithPrompt = (prompt: string): void => {
    try {
        sessionStorage.setItem(LANDING_MESSAGE_KEY, prompt);
    } catch {
        // sessionStorage unavailable — will navigate without pre-fill
    }

    globalThis.location.assign("/chat?initialMessage=true");
};

const OnboardingContent = ({ onComplete }: { onComplete: () => void }) => {
    const { t } = useLingui();
    const { currentStep, goToStep, loading, next, previous, skip, state } = useOnboarding();
    const translations = useStepTranslations();
    const contentRef = useRef<HTMLDivElement>(null);
    const [direction, setDirection] = useState(1); // 1 = forward, -1 = backward
    const [showSuccess, setShowSuccess] = useState(false);

    const currentIndex = (state?.currentStepNumber ?? 1) - 1;
    const isFirstStep = state?.isFirstStep ?? true;
    const isLastStep = state?.isLastStep ?? false;
    const totalSteps = state?.totalSteps ?? onboardingSteps.length;
    const progressPercentage = state?.progressPercentage ?? 0;

    const payload = currentStep?.payload as NeoreOnboardingPayload | undefined;

    // Track onboarding start on mount
    const hasTrackedStart = useRef(false);

    useEffect(() => {
        if (hasTrackedStart.current) {
            return;
        }

        hasTrackedStart.current = true;
        trackEvent("onboarding_started", {});
    }, []);

    // Focus management: move focus to content when step changes
    useEffect(() => {
        if (contentRef.current) {
            contentRef.current.focus({ preventScroll: true });
        }
    }, [currentIndex]);

    const finishOnboarding = useCallback(
        (prompt?: string) => {
            setShowSuccess(true);
            onComplete();
            void next();

            // Brief success state before navigating
            setTimeout(() => {
                if (prompt) {
                    navigateToChatWithPrompt(prompt);
                } else {
                    globalThis.location.assign("/chat");
                }
            }, 800);
        },
        [onComplete, next],
    );

    const handleNext = useCallback(async () => {
        setDirection(1);

        if (isLastStep) {
            trackEvent("onboarding_completed", {});
            finishOnboarding();

            return;
        }

        trackEvent("onboarding_step_completed", {
            step_id: String(currentStep?.id ?? "unknown"),
            step_index: currentIndex,
        });

        await next();
    }, [isLastStep, next, finishOnboarding, currentStep?.id, currentIndex]);

    const handlePrevious = useCallback(async () => {
        setDirection(-1);
        await previous();
    }, [previous]);

    const handleSkip = useCallback(() => {
        trackEvent("onboarding_skipped", { at_step: String(currentStep?.id ?? "unknown") });
        onComplete();
        void skip();
    }, [onComplete, skip, currentStep?.id]);

    const handleGoToStep = useCallback(
        async (stepId: string, index: number) => {
            setDirection(index > currentIndex ? 1 : -1);
            await goToStep(stepId);
        },
        [goToStep, currentIndex],
    );

    // Keyboard navigation
    const handleKeyDown = useCallback(
        (event: React.KeyboardEvent) => {
            switch (event.key) {
                case "ArrowLeft": {
                    if (!isFirstStep) {
                        event.preventDefault();
                        void handlePrevious();
                    }

                    break;
                }
                case "ArrowRight":
                case "Enter": {
                    if (!isLastStep || event.key === "Enter") {
                        event.preventDefault();
                        void handleNext();
                    }

                    break;
                }

                case "Escape": {
                    event.preventDefault();
                    handleSkip();
                    break;
                }

                default: {
                    break;
                }
            }
        },
        [isFirstStep, isLastStep, handleNext, handlePrevious, handleSkip],
    );

    // Success state after completing the flow
    if (showSuccess) {
        return (
            <Dialog open>
                <DialogPopup className="w-full max-w-md overflow-hidden" showCloseButton={false}>
                    <DialogTitle className="sr-only">{t`Onboarding complete`}</DialogTitle>
                    <div className="flex min-h-[280px] flex-col items-center justify-center gap-4 px-8 py-12">
                        <motion.div
                            animate={{ opacity: 1, scale: 1 }}
                            className="bg-primary/10 text-primary flex size-16 items-center justify-center rounded-full"
                            initial={{ opacity: 0, scale: 0.5 }}
                            transition={{ duration: 0.3, ease: "easeOut" }}
                        >
                            <Check aria-hidden="true" className="size-8" />
                        </motion.div>
                        <motion.p
                            animate={{ opacity: 1 }}
                            className="font-heading text-xl font-semibold"
                            initial={{ opacity: 0 }}
                            transition={{ delay: 0.15, duration: 0.2 }}
                        >
                            {t`You're all set!`}
                        </motion.p>
                        <span className="sr-only" role="status">
                            {t`Onboarding complete. Redirecting to chat.`}
                        </span>
                    </div>
                </DialogPopup>
            </Dialog>
        );
    }

    // Show loading spinner while engine is hydrating
    if (loading.isHydrating) {
        return (
            <Dialog open>
                <DialogPopup className="w-full max-w-md overflow-hidden" showCloseButton={false}>
                    <DialogTitle className="sr-only">{t`Loading onboarding`}</DialogTitle>
                    <div className="flex min-h-[300px] items-center justify-center">
                        <Loader2 aria-hidden="true" className="text-muted-foreground size-6 animate-spin" />
                        <span className="sr-only">{t`Loading onboarding`}</span>
                    </div>
                </DialogPopup>
            </Dialog>
        );
    }

    if (!payload) {
        return null;
    }

    const title = translations[payload.title as keyof typeof translations] ?? payload.title;
    const description = translations[payload.description as keyof typeof translations] ?? payload.description;

    const motionVariants = {
        animate: { opacity: 1, x: 0 },
        exit: { opacity: 0, x: direction > 0 ? -40 : 40 },
        initial: { opacity: 0, x: direction > 0 ? 40 : -40 },
    };

    return (
        <Dialog open>
            <DialogPopup className="w-full max-w-md overflow-hidden" showCloseButton={false}>
                <DialogTitle className="sr-only">{t`Welcome to Neore`}</DialogTitle>
                <div aria-label={t`Onboarding wizard`} className="flex flex-col" onKeyDown={handleKeyDown} ref={contentRef} role="region" tabIndex={-1}>
                    {/* Progress bar */}
                    <div className="bg-muted h-1 w-full">
                        <div
                            aria-label={t`Onboarding progress`}
                            aria-valuemax={100}
                            aria-valuemin={0}
                            aria-valuenow={Math.round(progressPercentage)}
                            className="bg-primary h-full transition-[width] duration-300 ease-out"
                            role="progressbar"
                            style={{ width: `${progressPercentage}%` }}
                        />
                    </div>

                    {/* Step content with animation */}
                    <div
                        className={cn(
                            "relative flex items-center justify-center overflow-hidden px-8 pt-8 pb-6",
                            isLastStep ? "min-h-[340px]" : "min-h-[280px]",
                        )}
                    >
                        <AnimatePresence initial={false} mode="wait">
                            <motion.div
                                animate={motionVariants.animate}
                                className="flex flex-col items-center gap-4 text-center"
                                exit={motionVariants.exit}
                                initial={motionVariants.initial}
                                key={currentStep?.id}
                                transition={{ duration: 0.2, ease: "easeOut" }}
                            >
                                <div className="bg-primary/10 text-primary flex size-16 items-center justify-center rounded-2xl">
                                    {STEP_ICONS[payload.icon]}
                                </div>
                                <h2 className="font-heading text-xl font-semibold">{title}</h2>
                                <p className="text-muted-foreground max-w-sm text-sm leading-relaxed">{description}</p>
                                {isLastStep && <TemplatePicker onSelectTemplate={(prompt: string) => finishOnboarding(prompt)} />}
                            </motion.div>
                        </AnimatePresence>
                    </div>

                    {/* Live region for screen readers */}
                    <div aria-live="polite" className="sr-only" role="status">
                        {t`Step ${currentIndex + 1} of ${totalSteps}: ${title}`}
                    </div>

                    {/* Progress dots — clickable, with adequate touch targets */}
                    <nav aria-label={t`Onboarding steps`} className="flex items-center justify-center gap-1 pb-6">
                        {onboardingSteps.map((step, index) => (
                            <button
                                aria-current={index === currentIndex ? "step" : undefined}
                                aria-label={t`Go to step ${index + 1}`}
                                className="flex items-center justify-center p-2"
                                key={step.id}
                                onClick={() => {
                                    void handleGoToStep(String(step.id), index);
                                }}
                                type="button"
                            >
                                <span
                                    className={cn(
                                        "block h-1.5 rounded-full transition-[width,background-color] duration-300",
                                        index === currentIndex ? "bg-primary w-6" : "bg-muted-foreground/30 group-hover:bg-muted-foreground/50 w-1.5",
                                    )}
                                />
                            </button>
                        ))}
                    </nav>

                    {/* Actions */}
                    <div className="border-t px-8 py-4">
                        <div className="flex items-center justify-between">
                            <div className="flex items-center gap-2">
                                {!isFirstStep && (
                                    <Button
                                        className="text-muted-foreground"
                                        onClick={() => {
                                            void handlePrevious();
                                        }}
                                        size="sm"
                                        variant="ghost"
                                    >
                                        <ArrowLeft aria-hidden="true" className="mr-1 size-4" />
                                        {t`Back`}
                                    </Button>
                                )}
                                {isFirstStep ? (
                                    <Button className="text-muted-foreground" onClick={handleSkip} size="sm" variant="ghost">
                                        {t`Skip tour`}
                                        <ArrowRight aria-hidden="true" className="ml-1 size-4" />
                                    </Button>
                                ) : (
                                    <Button className="text-muted-foreground" onClick={handleSkip} size="sm" variant="ghost">
                                        {t`Skip`}
                                    </Button>
                                )}
                            </div>
                            <Button
                                disabled={loading.isEngineProcessing}
                                onClick={() => {
                                    void handleNext();
                                }}
                                size="sm"
                            >
                                {loading.isEngineProcessing ? <Loader2 aria-hidden="true" className="mr-1 size-4 animate-spin" /> : null}
                                {isLastStep ? t`Just start chatting` : t`Next`}
                                {!isLastStep && <ArrowRight aria-hidden="true" className="ml-1 size-4" />}
                            </Button>
                        </div>
                    </div>
                </div>
            </DialogPopup>
        </Dialog>
    );
};

const OnboardingDialog = () => {
    const { onboardingCompleted, setOnboardingCompleted } = useUserPreferences();
    const { user } = useIsAnonymous();

    const handleFlowComplete = () => {
        setOnboardingCompleted(true);

        try {
            localStorage.removeItem(ONBOARDING_PERSISTENCE_KEY);
        } catch {
            // Ignore storage errors
        }
    };

    // A lazy `useState` initializer, not `useMemo`: React may discard a memo
    // cache at any time, and re-creating the plugin would re-register its
    // PostHog listeners.
    const [plugins] = useState(() => {
        if (typeof window === "undefined" || !posthog.__loaded) {
            return [];
        }

        return [
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
                posthogInstance: posthog,
            }),
        ];
    });

    if (!shouldShowOnboarding({ onboardingCompleted, user })) {
        return null;
    }

    return (
        <OnboardingErrorBoundary
            fallback={null}
            onError={(error: OnboardingError) => {
                console.warn("[Onboarding] Error boundary caught:", error.originalError);
                // Mark as completed so user isn't stuck
                setOnboardingCompleted(true);
            }}
        >
            <MotionConfig reducedMotion="user">
                <OnboardingProvider
                    flowId={ONBOARDING_FLOW_ID}
                    localStoragePersistence={{
                        key: ONBOARDING_PERSISTENCE_KEY,
                        ttl: 7 * 24 * 60 * 60 * 1000, // 7 days
                    }}
                    onFlowComplete={handleFlowComplete}
                    plugins={plugins}
                    steps={onboardingSteps}
                >
                    <OnboardingContent onComplete={handleFlowComplete} />
                </OnboardingProvider>
            </MotionConfig>
        </OnboardingErrorBoundary>
    );
};

export default OnboardingDialog;
