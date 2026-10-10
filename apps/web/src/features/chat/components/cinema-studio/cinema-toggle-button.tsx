"use client";

import type { MessageDescriptor } from "@lingui/core";
import { Trans, useLingui } from "@lingui/react/macro";
import { CAMERA_OPTIONS, LENS_OPTIONS } from "@neore/ai/constants/cinema";
import type { CinemaSettings } from "@neore/ai/types/cinema";
import { Tooltip, TooltipContent, TooltipTrigger } from "@neore/ui/components/tooltip";
import cn from "@neore/ui/utils/cn";
import { ChevronDown } from "lucide-react";
import { motion } from "motion/react";
import type { FC } from "react";

import { useModelStore } from "@/features/chat/core/stores/model-store";

import { localizeCinemaOptionLabel } from "./cinema-option-labels";

interface CinemaToggleButtonProps {
    /** Compact mode — matches the h-7 chip style of the mode settings strip */
    compact?: boolean;
    disabled?: boolean;
    value: CinemaSettings;
}

/** Aperture crosshair — clean, precise, cinematic. */
const ApertureIcon = ({ className }: { className?: string }) => (
    <svg aria-hidden="true" className={className} fill="none" viewBox="0 0 14 14">
        <circle cx="7" cy="7" r="5.5" stroke="currentColor" strokeWidth="1.25" />
        <circle cx="7" cy="7" fill="currentColor" r="1.75" />
        <line stroke="currentColor" strokeLinecap="round" strokeWidth="1.25" x1="7" x2="7" y1="1.5" y2="4.25" />
        <line stroke="currentColor" strokeLinecap="round" strokeWidth="1.25" x1="7" x2="7" y1="9.75" y2="12.5" />
        <line stroke="currentColor" strokeLinecap="round" strokeWidth="1.25" x1="1.5" x2="4.25" y1="7" y2="7" />
        <line stroke="currentColor" strokeLinecap="round" strokeWidth="1.25" x1="9.75" x2="12.5" y1="7" y2="7" />
    </svg>
);

const CinemaToggleButton: FC<CinemaToggleButtonProps> = ({ compact, disabled, value }) => {
    const cinemaPanelOpen = useModelStore((state) => state.cinemaPanelOpen);
    const toggleCinemaPanel = useModelStore((state) => state.toggleCinemaPanel);

    const { i18n } = useLingui();
    const translate = (descriptor: MessageDescriptor) => i18n._(descriptor);
    const cameraLabel = localizeCinemaOptionLabel("camera", CAMERA_OPTIONS, value.camera, translate);
    const lensLabel = localizeCinemaOptionLabel("lens", LENS_OPTIONS, value.lens, translate);
    const focalLabel = value.focalLength ? `${value.focalLength}mm` : null;
    const apertureLabel = value.aperture ? `f/${value.aperture}` : null;

    const hasSettings = cameraLabel || lensLabel || focalLabel || apertureLabel;

    return (
        <Tooltip>
            <TooltipTrigger
                render={
                    <motion.button
                        className={cn(
                            "group relative flex items-center gap-1.5 outline-none",
                            "text-xs font-medium transition-all duration-150",
                            "border",
                            !disabled && "hover:bg-muted hover:text-foreground",
                            cinemaPanelOpen && ["border-primary/40", "bg-primary/[0.06]", "text-foreground"],
                            hasSettings && !cinemaPanelOpen && "text-foreground",
                            "focus-visible:ring-ring/30 focus-visible:ring-2 focus-visible:ring-offset-1",
                            disabled && "cursor-not-allowed opacity-40",
                            compact
                                ? "border-border/50 text-muted-foreground h-7 rounded-md bg-transparent px-2"
                                : "border-border bg-card text-muted-foreground rounded-lg px-2.5 py-1.5",
                        )}
                        disabled={disabled}
                        onClick={toggleCinemaPanel}
                        transition={{ damping: 30, stiffness: 600, type: "spring" }}
                        type="button"
                        whileHover={disabled || compact ? undefined : { scale: 1.01 }}
                        whileTap={disabled || compact ? undefined : { scale: 0.99 }}
                    >
                        {/* Aperture icon — rotates open when panel visible */}
                        <motion.div animate={cinemaPanelOpen ? { rotate: 45 } : { rotate: 0 }} transition={{ duration: 0.28, ease: [0.4, 0, 0.2, 1] }}>
                            <ApertureIcon
                                className={cn(
                                    "h-3.5 w-3.5 transition-colors duration-150",
                                    cinemaPanelOpen ? "text-primary" : "text-muted-foreground group-hover:text-foreground",
                                )}
                            />
                        </motion.div>

                        {/* Label */}
                        <span
                            className={cn(
                                "text-[11px] font-semibold tracking-wider uppercase transition-colors duration-150",
                                cinemaPanelOpen && "text-foreground",
                            )}
                        >
                            <Trans>Cinema</Trans>
                        </span>

                        {/* Compact dot-separated settings readout */}
                        {hasSettings && (
                            <motion.div
                                animate={{ opacity: 1, width: "auto" }}
                                className="border-border ml-0.5 flex items-center gap-1 overflow-hidden border-l pl-1.5"
                                exit={{ opacity: 0, width: 0 }}
                                initial={{ opacity: 0, width: 0 }}
                                transition={{ duration: 0.18 }}
                            >
                                {[
                                    cameraLabel && (
                                        <span className="text-muted-foreground max-w-[56px] truncate text-[10px] font-medium whitespace-nowrap" key="camera">
                                            {cameraLabel}
                                        </span>
                                    ),
                                    lensLabel && (
                                        <span className="text-muted-foreground max-w-[56px] truncate text-[10px] font-medium whitespace-nowrap" key="lens">
                                            {lensLabel}
                                        </span>
                                    ),
                                    focalLabel && (
                                        <span className="text-muted-foreground font-mono text-[10px] font-semibold whitespace-nowrap tabular-nums" key="focal">
                                            {focalLabel}
                                        </span>
                                    ),
                                    apertureLabel && (
                                        <span
                                            className="text-muted-foreground font-mono text-[10px] font-semibold whitespace-nowrap tabular-nums"
                                            key="aperture"
                                        >
                                            {apertureLabel}
                                        </span>
                                    ),
                                ]
                                    .filter(Boolean)
                                    .flatMap((element, i, array) =>
                                        i < array.length - 1
                                            ? [
                                                  element,
                                                  <span className="text-muted-foreground/30 shrink-0 text-[9px] select-none" key={`dot-${i}`}>
                                                      ·
                                                  </span>,
                                              ]
                                            : [element],
                                    )}
                            </motion.div>
                        )}

                        {/* Lime indicator dot — "recording LED" */}
                        {hasSettings && <span className="bg-primary h-1.5 w-1.5 shrink-0 rounded-full" />}

                        {/* Chevron */}
                        <ChevronDown
                            className={cn(
                                "text-muted-foreground h-3 w-3 shrink-0 transition-all duration-300",
                                cinemaPanelOpen && "text-foreground rotate-180",
                            )}
                            strokeWidth={2}
                        />
                    </motion.button>
                }
            />

            {/* Tooltip — only shown when settings are selected */}
            {hasSettings && (
                <TooltipContent className="flex min-w-[140px] flex-col gap-1.5" side="top">
                    {cameraLabel && (
                        <div className="flex items-center justify-between gap-3">
                            <span className="text-background/50 text-[10px] tracking-wide uppercase">
                                <Trans>Camera</Trans>
                            </span>
                            <span className="font-medium">{cameraLabel}</span>
                        </div>
                    )}
                    {lensLabel && (
                        <div className="flex items-center justify-between gap-3">
                            <span className="text-background/50 text-[10px] tracking-wide uppercase">
                                <Trans>Lens</Trans>
                            </span>
                            <span className="font-medium">{lensLabel}</span>
                        </div>
                    )}
                    {focalLabel && (
                        <div className="flex items-center justify-between gap-3">
                            <span className="text-background/50 text-[10px] tracking-wide uppercase">
                                <Trans>Focal</Trans>
                            </span>
                            <span className="font-mono font-semibold tabular-nums">{focalLabel}</span>
                        </div>
                    )}
                    {apertureLabel && (
                        <div className="flex items-center justify-between gap-3">
                            <span className="text-background/50 text-[10px] tracking-wide uppercase">
                                <Trans>Aperture</Trans>
                            </span>
                            <span className="font-mono font-semibold tabular-nums">{apertureLabel}</span>
                        </div>
                    )}
                </TooltipContent>
            )}
        </Tooltip>
    );
};

export default CinemaToggleButton;
