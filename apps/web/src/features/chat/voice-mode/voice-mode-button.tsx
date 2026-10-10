"use client";

/**
 * Composer toggle for hands-free voice mode: talk, the message sends itself
 * when you stop, the reply is read aloud, and it listens again. The toggle and
 * Esc both stop it.
 *
 * This file stays small — the loop itself (`voice-mode-controller.tsx`, with
 * the dictation engines and speech code) is lazy-loaded the first time the
 * mode starts.
 */

import { useLingui } from "@lingui/react/macro";
import { buttonVariants } from "@neore/ui/components/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@neore/ui/components/tooltip";
import cn from "@neore/ui/utils/cn";
import { AudioLinesIcon, Loader2Icon, MicIcon, Volume2Icon } from "lucide-react";
import type { FC } from "react";
import { lazy, Suspense, useEffect, useId, useSyncExternalStore } from "react";

import { canCaptureRealtime, getSpeechRecognition } from "@/features/chat/thread/dictation/web-speech";

import type { VoiceModeAnnouncement, VoiceModeIndicator } from "./voice-mode-machine";
import { indicatorOf } from "./voice-mode-machine";
import { sendVoiceModeEvent, useVoiceModeStore } from "./voice-mode-store";

const VoiceModeController = lazy(() => import("./voice-mode-controller"));

/** Either dictation engine will do (`listen.ts`). */
const isListeningSupported = (): boolean => !!getSpeechRecognition() || canCaptureRealtime();
const noopSubscribe = () => () => {};
const getServerSupport = () => false;

interface VoiceModeButtonProps {
    disabled?: boolean;
}

const VoiceModeButton: FC<VoiceModeButtonProps> = ({ disabled = false }) => {
    const { t } = useLingui();
    const phase = useVoiceModeStore((store) => store.state.phase);
    const announcement = useVoiceModeStore((store) => store.announcement);
    const id = useId();
    const isOwner = useVoiceModeStore((store) => store.controllerOwner === id);
    const hasOwner = useVoiceModeStore((store) => store.controllerOwner !== null);
    // Server snapshot `false`: the button appears on the client's follow-up render.
    const isSupported = useSyncExternalStore(noopSubscribe, isListeningSupported, getServerSupport);

    const isActive = phase !== "idle";

    // One controller per page: a running loop whose owner went away (a composer
    // remount on navigation) is taken over by whichever toggle is still here.
    useEffect(() => {
        if (isActive && !hasOwner) {
            useVoiceModeStore.getState().claimController(id);
        }
    }, [hasOwner, id, isActive]);

    useEffect(() => () => useVoiceModeStore.getState().releaseController(id), [id]);

    if (!isSupported) {
        return null;
    }

    const indicator = indicatorOf(phase);

    const stateLabels: Record<VoiceModeIndicator, string> = {
        idle: "",
        listening: t`Listening…`,
        speaking: t`Speaking…`,
        thinking: t`Thinking…`,
    };

    const announce = (value: VoiceModeAnnouncement): string => {
        switch (value.kind) {
            case "error": {
                return t`Hands-free mode stopped: ${value.message}`;
            }
            case "listening": {
                return t`Listening`;
            }
            case "speaking": {
                return t`Speaking the reply. Press Escape to stop.`;
            }
            case "stopped": {
                return t`Hands-free mode off`;
            }
            case "thinking": {
                return t`Sending your message and waiting for the reply`;
            }
            default: {
                return "";
            }
        }
    };

    const stateLabel = stateLabels[indicator];
    // The visible state text leads the accessible name (WCAG 2.5.3, label in name).
    const label = isActive ? t`${stateLabel} Stop hands-free voice mode` : t`Start hands-free voice mode`;
    const tooltip = isActive ? t`Stop hands-free mode (Esc)` : t`Hands-free voice mode — talk, and replies are read aloud`;

    return (
        <div className="flex items-center">
            {/* Keyed on the counter so a repeated state is announced again. */}
            <span aria-live="polite" className="sr-only" role="status">
                {announcement && isOwner ? <span key={announcement.id}>{announce(announcement.value)}</span> : null}
            </span>
            <Tooltip>
                <TooltipTrigger
                    render={
                        <button
                            aria-label={label}
                            aria-pressed={isActive}
                            className={cn(
                                buttonVariants({ size: isActive ? "sm" : "icon", variant: isActive ? "secondary" : "ghost" }),
                                "my-4 gap-1.5",
                                !isActive && "size-[34px]",
                                indicator === "listening" && "bg-red-500 text-white hover:bg-red-600 dark:bg-red-600 dark:hover:bg-red-700",
                            )}
                            data-state={indicator}
                            disabled={disabled && !isActive}
                            onClick={() => {
                                if (!isActive) {
                                    useVoiceModeStore.getState().claimController(id, true);
                                }

                                sendVoiceModeEvent({ type: isActive ? "STOP" : "START" });
                            }}
                            type="button"
                        >
                            {indicator === "idle" && <AudioLinesIcon aria-hidden="true" className="size-4" />}
                            {indicator === "listening" && <MicIcon aria-hidden="true" className="size-4 motion-safe:animate-pulse" />}
                            {indicator === "thinking" && <Loader2Icon aria-hidden="true" className="size-4 motion-safe:animate-spin" />}
                            {indicator === "speaking" && <Volume2Icon aria-hidden="true" className="size-4 motion-safe:animate-pulse" />}
                            {isActive && <span className="text-xs">{stateLabel}</span>}
                        </button>
                    }
                />
                <TooltipContent side="bottom">{tooltip}</TooltipContent>
            </Tooltip>
            {isActive && isOwner && (
                <Suspense fallback={null}>
                    <VoiceModeController />
                </Suspense>
            )}
        </div>
    );
};

export default VoiceModeButton;
