"use client";

import type { MessageDescriptor } from "@lingui/core";
import { Trans, useLingui } from "@lingui/react/macro";
import { APERTURE_OPTIONS, CAMERA_OPTIONS, FOCAL_LENGTH_OPTIONS, LENS_OPTIONS } from "@neore/ai/constants/cinema";
import type { Aperture, CameraType, CinemaSettings, FocalLength, LensType } from "@neore/ai/types/cinema";
import cn from "@neore/ui/utils/cn";
import { RotateCcw } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import type { FC } from "react";

import { useModelStore } from "@/features/chat/core/stores/model-store";

import { localizeCinemaOptions } from "./cinema-option-labels";
import CinemaVerticalPicker from "./cinema-vertical-picker";

interface CinemaPanelProps {
    onChange: (value: CinemaSettings) => void;
    value: CinemaSettings;
}

const CinemaPanel: FC<CinemaPanelProps> = ({ onChange, value }) => {
    const { i18n, t } = useLingui();
    const translate = (descriptor: MessageDescriptor) => i18n._(descriptor);
    const cinemaPanelOpen = useModelStore((state) => state.cinemaPanelOpen);

    const hasSettings = value.camera || value.lens || value.focalLength || value.aperture;

    const handleReset = () => {
        onChange({
            aperture: undefined,
            camera: undefined,
            enabled: value.enabled,
            focalLength: undefined,
            lens: undefined,
        });
    };

    return (
        <AnimatePresence>
            {cinemaPanelOpen && (
                <motion.div
                    animate={{ height: "auto", opacity: 1 }}
                    className="mb-3 overflow-hidden"
                    exit={{ height: 0, opacity: 0 }}
                    initial={{ height: 0, opacity: 0 }}
                    transition={{ duration: 0.22, ease: [0.4, 0, 0.2, 1] }}
                >
                    {/*
                        Uses the same card pattern as the design system:
                        bg-card + ring-foreground/10 ring-1 + rounded-lg
                    */}
                    <div className={cn("overflow-hidden rounded-lg", "bg-card text-card-foreground", "ring-foreground/10 ring-1")}>
                        {/* Header */}
                        <div className="border-border flex items-center justify-between border-b px-4 py-2.5">
                            <div className="flex items-center gap-2">
                                {/* Aperture mark — a concentric circle glyph */}
                                <div className="relative flex h-3.5 w-3.5 shrink-0 items-center justify-center">
                                    <div className="border-muted-foreground/40 absolute inset-0 rounded-full border" />
                                    <div className="bg-muted-foreground/40 h-1.5 w-1.5 rounded-full" />
                                </div>
                                <span className="text-muted-foreground text-[10px] font-bold tracking-[0.22em] uppercase select-none">
                                    <Trans>Cinema Studio</Trans>
                                </span>
                            </div>

                            <AnimatePresence>
                                {hasSettings && (
                                    <motion.button
                                        animate={{ opacity: 1, scale: 1 }}
                                        className={cn(
                                            "flex items-center gap-1.5 rounded-md px-2 py-1",
                                            "text-[10px] font-medium tracking-wide uppercase",
                                            "border-border border",
                                            "text-muted-foreground hover:text-foreground hover:bg-muted",
                                            "transition-all duration-150",
                                            "focus-visible:ring-ring/30 focus-visible:ring-1 focus-visible:outline-none",
                                        )}
                                        exit={{ opacity: 0, scale: 0.85 }}
                                        initial={{ opacity: 0, scale: 0.85 }}
                                        onClick={handleReset}
                                        transition={{ damping: 25, stiffness: 500, type: "spring" }}
                                        type="button"
                                        whileHover={{ scale: 1.03 }}
                                        whileTap={{ scale: 0.97 }}
                                    >
                                        <RotateCcw className="h-2.5 w-2.5" strokeWidth={2.5} />
                                        <Trans>Reset</Trans>
                                    </motion.button>
                                )}
                            </AnimatePresence>
                        </div>

                        {/* Pickers — 4-column grid with hairline dividers */}
                        <div className="divide-border grid grid-cols-4 divide-x py-4">
                            <div className="px-3">
                                <CinemaVerticalPicker<CameraType>
                                    isOpen={cinemaPanelOpen}
                                    onChange={(camera) => onChange({ ...value, camera })}
                                    options={localizeCinemaOptions("camera", CAMERA_OPTIONS, translate)}
                                    title={t`Camera`}
                                    value={value.camera}
                                />
                            </div>

                            <div className="px-3">
                                <CinemaVerticalPicker<LensType>
                                    isOpen={cinemaPanelOpen}
                                    onChange={(lens) => onChange({ ...value, lens })}
                                    options={localizeCinemaOptions("lens", LENS_OPTIONS, translate)}
                                    title={t`Lens`}
                                    value={value.lens}
                                />
                            </div>

                            <div className="px-3">
                                <CinemaVerticalPicker<FocalLength>
                                    isOpen={cinemaPanelOpen}
                                    onChange={(focalLength) => onChange({ ...value, focalLength })}
                                    options={localizeCinemaOptions("focalLength", FOCAL_LENGTH_OPTIONS, translate)}
                                    title={t`Focal`}
                                    value={value.focalLength}
                                />
                            </div>

                            <div className="px-3">
                                <CinemaVerticalPicker<Aperture>
                                    isOpen={cinemaPanelOpen}
                                    onChange={(aperture) => onChange({ ...value, aperture })}
                                    options={localizeCinemaOptions("aperture", APERTURE_OPTIONS, translate)}
                                    title={t`Aperture`}
                                    value={value.aperture}
                                />
                            </div>
                        </div>

                        {/* Footer */}
                        <div className="border-border flex items-center gap-1.5 border-t px-4 py-2">
                            <kbd className="bg-muted border-border text-muted-foreground inline-flex items-center rounded-sm border px-1.5 py-0.5 font-mono text-[9px] leading-none">
                                ↑↓
                            </kbd>
                            <span className="text-muted-foreground/60 text-[9px] tracking-wide">
                                <Trans>navigate within each column</Trans>
                            </span>
                        </div>
                    </div>
                </motion.div>
            )}
        </AnimatePresence>
    );
};

export default CinemaPanel;
