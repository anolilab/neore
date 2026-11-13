"use client";

import { Trans, useLingui } from "@lingui/react/macro";
import { Button } from "@neore/ui/components/button";
import { Dialog, DialogPopup } from "@neore/ui/components/dialog";
import { Separator } from "@neore/ui/components/separator";
import { Tooltip, TooltipContent, TooltipTrigger } from "@neore/ui/components/tooltip";
import cn from "@neore/ui/utils/cn";
import { Loader2Icon, Wand2Icon } from "lucide-react";
import type { ReactNode } from "react";
import { memo, useCallback, useMemo, useState } from "react";

import { ModelPicker } from "@/components/model-picker";
import type { CinemaSettings } from "@/features/chat/components/cinema-studio";
import { CinemaPanel } from "@/features/chat/components/cinema-studio";
import { useChatActions } from "@/features/chat/core/context/chat-context";
import type { ComposerMode } from "@/features/chat/core/stores/model-store";
import { useModelStore } from "@/features/chat/core/stores/model-store";
import useFeatureFlaggedModels from "@/hooks/use-feature-flagged-models";

// Import settings components directly — they're small and user-triggered
import ComposerAudioSettings from "./composer-audio-settings";
import ComposerImageSettings from "./composer-image-settings";
import ComposerVideoSettings from "./composer-video-settings";

type GenerationMode = "image" | "video" | "speech-to-text";

const COMPOSER_MODE: Record<GenerationMode, ComposerMode> = {
    image: "image",
    "speech-to-text": "audio",
    video: "video",
};

interface GenerationModelMenuProps {
    disabled?: boolean;
    icon: ReactNode;
    messageText: string;
    mode: GenerationMode;
    threadId: string | null | undefined;
    tooltip: string;
}

const GenerationModelMenu = memo(({ disabled, icon, messageText, mode, threadId, tooltip }: GenerationModelMenuProps) => {
    const { t } = useLingui();
    const [open, setOpen] = useState(false);
    const [isGenerating, setIsGenerating] = useState(false);

    const flaggedModels = useFeatureFlaggedModels();
    const models = useMemo(() => flaggedModels.filter((m) => m.enabled && m.mode === mode), [flaggedModels, mode]);

    const [selectedModelId, setSelectedModelId] = useState<string>(() => models[0]?.id ?? "");

    const { sendMessage } = useChatActions();
    const setSelectedModel = useModelStore((s) => s.setSelectedModel);
    const setComposerMode = useModelStore((s) => s.setComposerMode);

    // Settings — shared with the composer via the same store
    const imageSettings = useModelStore((s) => s.imageSettings);
    const videoSettings = useModelStore((s) => s.videoSettings);
    const audioSettings = useModelStore((s) => s.audioSettings);
    const setImageSettings = useModelStore((s) => s.setImageSettings);
    const setVideoSettings = useModelStore((s) => s.setVideoSettings);
    const setAudioSettings = useModelStore((s) => s.setAudioSettings);

    const handleSelectModel = useCallback((modelId: string) => {
        setSelectedModelId(modelId);
    }, []);

    const handleGenerate = useCallback(async () => {
        if (!messageText || !selectedModelId) {
            return;
        }

        setIsGenerating(true);
        setSelectedModel(selectedModelId, threadId || undefined);
        setComposerMode(COMPOSER_MODE[mode], threadId || undefined);
        setOpen(false);

        // `.catch(rethrow)` rather than `try/finally` so the React Compiler can
        // still optimize this component (it bails on `finally` clauses).
        await sendMessage(messageText).catch((error: unknown) => {
            setIsGenerating(false);

            throw error;
        });

        setIsGenerating(false);
    }, [messageText, selectedModelId, mode, threadId, setSelectedModel, setComposerMode, sendMessage]);

    // Cinema value + handler for image/video modes
    let cinemaValue;

    if (mode === "image") {
        cinemaValue = imageSettings.cinema;
    } else if (mode === "video") {
        cinemaValue = videoSettings.cinema;
    }

    const handleCinemaChange = useCallback(
        (cinema: CinemaSettings) => {
            if (mode === "image") setImageSettings({ cinema });
            else if (mode === "video") setVideoSettings({ cinema });
        },
        [mode, setImageSettings, setVideoSettings],
    );

    if (models.length === 0) {
        return null;
    }

    return (
        <Dialog onOpenChange={setOpen} open={open}>
            <Tooltip>
                <TooltipTrigger
                    render={
                        <Button
                            aria-haspopup="dialog"
                            className={cn(open && "bg-accent")}
                            disabled={disabled || isGenerating}
                            onClick={() => setOpen(true)}
                            size="icon-sm"
                            type="button"
                            variant="ghost"
                        >
                            {isGenerating ? <Loader2Icon className="size-4 animate-spin" /> : icon}
                            <span className="sr-only">{tooltip}</span>
                        </Button>
                    }
                />
                <TooltipContent>
                    <p>{tooltip}</p>
                </TooltipContent>
            </Tooltip>

            <DialogPopup bottomStickOnMobile={false} className="w-full max-w-3xl overflow-hidden p-0" showCloseButton={false}>
                <div className="flex min-h-0">
                    {/* ── Left column: ModelPicker (filtered to mode) ── */}
                    <div className="w-72 shrink-0 border-r">
                        <ModelPicker defaultTab="all" footer={null} initialModelId={selectedModelId} models={models} onSelect={handleSelectModel} />
                    </div>

                    {/* ── Right column: Settings + Generate ── */}
                    <div className="flex min-w-0 flex-1 flex-col">
                        {/* Settings area — scrollable */}
                        <div className="flex-1 overflow-y-auto p-4">
                            {mode === "image" && <ComposerImageSettings onSettingsChange={setImageSettings} settings={imageSettings} />}
                            {mode === "video" && <ComposerVideoSettings onSettingsChange={setVideoSettings} settings={videoSettings} />}
                            {mode === "speech-to-text" && <ComposerAudioSettings onSettingsChange={setAudioSettings} settings={audioSettings} />}

                            {cinemaValue !== undefined && (
                                <div className="mt-3">
                                    <CinemaPanel onChange={handleCinemaChange} value={cinemaValue} />
                                </div>
                            )}
                        </div>

                        <Separator />

                        {/* Footer: Cancel + Generate */}
                        <div className="flex items-center justify-end gap-2 p-3">
                            <Button onClick={() => setOpen(false)} size="sm" variant="ghost">
                                <Trans>Cancel</Trans>
                            </Button>
                            <Button className="gap-1.5" disabled={isGenerating || !selectedModelId || !messageText} onClick={handleGenerate} size="sm">
                                {isGenerating ? <Loader2Icon className="size-3.5 animate-spin" /> : <Wand2Icon className="size-3.5" />}
                                {isGenerating ? t`Generating…` : t`Generate`}
                            </Button>
                        </div>
                    </div>
                </div>
            </DialogPopup>
        </Dialog>
    );
});

GenerationModelMenu.displayName = "GenerationModelMenu";
export default GenerationModelMenu;
