"use client";

import { useLingui } from "@lingui/react/macro";
import { CheckIcon, XIcon } from "lucide-react";
import * as React from "react";

import { Button } from "../../components/button";
import cn from "../../utils/cn";
import LiveWaveform from "./live-waveform";

export type VoiceButtonState = "idle" | "recording" | "processing" | "success" | "error";

export interface VoiceButtonProps extends Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, "onError"> {
    /**
     * Custom className for the button
     */
    className?: string;

    /**
     * Disable the button
     */
    disabled?: boolean;

    /**
     * Duration in ms to show success/error states
     * @default 1500
     */
    feedbackDuration?: number;

    /**
     * Icon to display in the center when idle (for icon size buttons)
     */
    icon?: React.ReactNode;

    /**
     * Content to display on the left side (label)
     * Can be a string or ReactNode for custom components
     */
    label?: React.ReactNode;

    /**
     * Callback when button is clicked
     */
    onPress?: () => void;

    ref?: React.Ref<HTMLButtonElement>;

    /**
     * Size of the button
     * @default "default"
     */
    size?: "default" | "sm" | "lg" | "icon";

    /**
     * Current state of the voice button
     * @default "idle"
     */
    state?: VoiceButtonState;

    /**
     * Content to display on the right side (e.g., keyboard shortcut)
     * Can be a string or ReactNode for custom components
     * @example "⌥Space" or <kbd>⌘K</kbd>
     */
    trailing?: React.ReactNode;

    /**
     * Custom variant for the button
     * @default "outline"
     */
    variant?: "default" | "destructive" | "outline" | "secondary" | "ghost" | "link";

    /**
     * Custom className for the waveform container
     */
    waveformClassName?: string;
}

const getWaveformSurfaceClass = (isRecording: boolean, isIconSize: boolean): string => {
    if (isRecording) {
        return "bg-primary/10 dark:bg-primary/5";
    }

    return isIconSize ? "bg-muted/50 border-0" : "border-border bg-muted/50";
};

const VoiceButton = ({
    className,
    disabled,
    feedbackDuration = 1500,
    icon,
    label,
    onClick,
    onPress,
    ref,
    size = "default",
    state = "idle",
    trailing,
    variant = "outline",
    waveformClassName,
    ...props
}: VoiceButtonProps) => {
    const { t } = useLingui();
    const [showFeedback, setShowFeedback] = React.useState(false);
    const [previousState, setPreviousState] = React.useState(state);

    // Whether feedback is showing follows directly from `state`, so it is adjusted
    // during render; the effect below only owns the timer that hides it again.
    if (state !== previousState) {
        setPreviousState(state);
        setShowFeedback(state === "success" || state === "error");
    }

    React.useEffect(() => {
        if (!showFeedback) {
            return undefined;
        }

        const timeout = setTimeout(setShowFeedback, feedbackDuration, false);

        return () => clearTimeout(timeout);
    }, [showFeedback, feedbackDuration]);

    const handleClick = (e: React.MouseEvent<HTMLButtonElement>) => {
        onClick?.(e);
        onPress?.();
    };

    const isRecording = state === "recording";
    const isProcessing = state === "processing";
    const isSuccess = state === "success";
    const isError = state === "error";

    const buttonVariant = variant;
    const isDisabled = disabled || isProcessing;

    const displayLabel = label;

    const shouldShowWaveform = isRecording || isProcessing || showFeedback;
    const shouldShowTrailing = !shouldShowWaveform && trailing;

    return (
        <Button
            aria-label={t`Voice Button`}
            className={cn("gap-2 transition-all duration-200", size === "icon" && "relative", className)}
            disabled={isDisabled}
            onClick={handleClick}
            ref={ref}
            size={size}
            type="button"
            variant={buttonVariant}
            {...props}
        >
            {size !== "icon" && displayLabel && <span className="inline-flex shrink-0 items-center justify-start">{displayLabel}</span>}

            <div
                className={cn(
                    "relative box-content flex shrink-0 items-center justify-center overflow-hidden transition-all duration-300",
                    size === "icon" ? "absolute inset-0 rounded-sm border-0" : "h-5 w-24 rounded-sm border",
                    getWaveformSurfaceClass(isRecording, size === "icon"),
                    waveformClassName,
                )}
            >
                {shouldShowWaveform && (
                    <LiveWaveform
                        active={isRecording}
                        barGap={1}
                        barRadius={4}
                        barWidth={2}
                        className="animate-in fade-in absolute inset-0 h-full w-full duration-300"
                        fadeEdges={false}
                        height={20}
                        mode="static"
                        processing={isProcessing || isSuccess}
                        sensitivity={1.8}
                        smoothingTimeConstant={0.85}
                    />
                )}

                {shouldShowTrailing && (
                    <div className="animate-in fade-in absolute inset-0 flex items-center justify-center duration-300">
                        {typeof trailing === "string" ? (
                            <span className="text-muted-foreground px-1.5 font-mono text-[10px] font-medium select-none">{trailing}</span>
                        ) : (
                            trailing
                        )}
                    </div>
                )}

                {!shouldShowWaveform && !shouldShowTrailing && icon && size === "icon" && (
                    <div className="animate-in fade-in absolute inset-0 flex items-center justify-center duration-300">{icon}</div>
                )}

                {isSuccess && showFeedback && (
                    <div className="animate-in fade-in bg-background/80 absolute inset-0 flex items-center justify-center duration-300">
                        <span className="text-primary text-[10px] font-medium">
                            <CheckIcon className="size-3.5" />
                        </span>
                    </div>
                )}

                {/* Error Icon */}
                {isError && showFeedback && (
                    <div className="animate-in fade-in bg-background/80 absolute inset-0 flex items-center justify-center duration-300">
                        <span className="text-destructive text-[10px] font-medium">
                            <XIcon className="size-3.5" />
                        </span>
                    </div>
                )}
            </div>
        </Button>
    );
};

VoiceButton.displayName = "VoiceButton";

export default VoiceButton;
