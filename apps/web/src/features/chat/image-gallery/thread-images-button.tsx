"use client";

/**
 * The chat header's way into the image gallery: shown once the chat holds an image, it opens the gallery at the
 * first one. The gallery itself is mounted with the thread (`ChatImageGallery`).
 */

import { useLingui } from "@lingui/react/macro";
import { Button } from "@neore/ui/components/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@neore/ui/components/tooltip";
import { ImagesIcon } from "lucide-react";
import type { FC } from "react";

import { useImageGalleryStore } from "./image-gallery-store";
import useThreadImages from "./use-thread-images";

const ThreadImagesButton: FC<{ threadId: string | undefined }> = ({ threadId }) => {
    const { t } = useLingui();
    const openAt = useImageGalleryStore((state) => state.openAt);
    // Image and video mode show their own grid of the chat's media, with its own preview, and no message to go to.
    const listShown = useImageGalleryStore((state) => (threadId ? (state.listShown[threadId] ?? true) : true));
    const images = useThreadImages();

    if (!threadId || images.length === 0 || !listShown) {
        return null;
    }

    return (
        <Tooltip>
            <TooltipTrigger
                render={
                    <Button
                        aria-label={t`Images in this chat (${images.length})`}
                        onClick={(event) => openAt(threadId, null, event.currentTarget)}
                        size="icon"
                        variant="ghost"
                    >
                        <ImagesIcon aria-hidden="true" className="h-4 w-4" />
                    </Button>
                }
            />
            <TooltipContent>{t`Images in this chat`}</TooltipContent>
        </Tooltip>
    );
};

export default ThreadImagesButton;
