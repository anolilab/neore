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
    const images = useThreadImages();

    if (!threadId || images.length === 0) {
        return null;
    }

    return (
        <Tooltip>
            <TooltipTrigger
                render={
                    <Button aria-label={t`Images in this chat (${images.length})`} onClick={() => openAt(threadId, null)} size="icon" variant="ghost">
                        <ImagesIcon aria-hidden="true" className="h-4 w-4" />
                    </Button>
                }
            />
            <TooltipContent>{t`Images in this chat`}</TooltipContent>
        </Tooltip>
    );
};

export default ThreadImagesButton;
