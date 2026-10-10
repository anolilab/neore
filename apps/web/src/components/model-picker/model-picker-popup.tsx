"use client";

import { useLingui } from "@lingui/react/macro";
import { Dialog, DialogPopup } from "@neore/ui/components/dialog";
import { Drawer, DrawerContent, DrawerHeader, DrawerTitle } from "@neore/ui/components/drawer";
import MOBILE_BREAKPOINT_QUERY from "@neore/ui/utils/breakpoints";
import type { FC } from "react";
import { useMediaMatch } from "rooks";

import useIsAnonymous from "@/features/auth/hooks/use-is-anonymous";
import useFavoriteModels from "@/features/chat/core/hooks/use-favorite-models";
import useFeatureFlaggedModels from "@/hooks/use-feature-flagged-models";

import ModelPicker from "./model-picker";
import { useModelPickerPopupActions, useModelPickerPopupState } from "./model-picker-popup-store";

const ModelPickerPopup: FC = () => {
    const { t } = useLingui();
    const isMobile = useMediaMatch(MOBILE_BREAKPOINT_QUERY);
    const { isOpen, options } = useModelPickerPopupState();
    const { close } = useModelPickerPopupActions();
    const { isAnonymous } = useIsAnonymous();
    const featureFlaggedModels = useFeatureFlaggedModels();
    const { favoriteModelIds, toggleFavorite } = useFavoriteModels();

    const handleSelect = (modelId: string) => {
        options?.onSelect?.(modelId);
        close();
    };

    const handleOpenChange = (open: boolean) => {
        if (!open) {
            close();
        }
    };

    if (isMobile) {
        return (
            <Drawer onOpenChange={handleOpenChange} open={isOpen}>
                <DrawerContent>
                    <DrawerHeader className="shrink-0">
                        <DrawerTitle>{t`Select Model`}</DrawerTitle>
                    </DrawerHeader>
                    <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-4">
                        <ModelPicker
                            favorites={favoriteModelIds}
                            footer={null}
                            initialModelId={options?.initialModelId}
                            isAnonymous={isAnonymous}
                            models={featureFlaggedModels}
                            onSelect={handleSelect}
                            onToggleFavorite={toggleFavorite}
                            panelClassName="h-[50vh]"
                        />
                    </div>
                </DrawerContent>
            </Drawer>
        );
    }

    return (
        <Dialog onOpenChange={handleOpenChange} open={isOpen}>
            <DialogPopup className="h-full w-full max-w-3xl overflow-hidden p-0" showCloseButton={false}>
                <ModelPicker
                    favorites={favoriteModelIds}
                    footer={null}
                    initialModelId={options?.initialModelId}
                    isAnonymous={isAnonymous}
                    models={featureFlaggedModels}
                    onSelect={handleSelect}
                    onToggleFavorite={toggleFavorite}
                />
            </DialogPopup>
        </Dialog>
    );
};

export default ModelPickerPopup;
