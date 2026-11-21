"use client";

/**
 * The chat header's way into the image gallery: shown once the chat holds an image, it opens the gallery at the
 * first one. It also mounts the gallery, which an image in a message opens too (`ImageOpenContext`).
 */

import { useLingui } from "@lingui/react/macro";
import { collectThreadImages } from "@neore/chat-ui/utils/thread-images";
import { Button } from "@neore/ui/components/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@neore/ui/components/tooltip";
import { ImagesIcon } from "lucide-react";
import type { FC } from "react";
import { useMemo } from "react";

import { useChatMessages } from "@/features/chat/core/context/chat-context-hooks";

import { useImageGalleryStore } from "./image-gallery-store";
import ThreadImageGallery from "./thread-image-gallery";

const ThreadImagesButton: FC<{ threadId: string | undefined }> = ({ threadId }) => {
    const { t } = useLingui();
    const { messages } = useChatMessages();
    const openAt = useImageGalleryStore((state) => state.openAt);
    const images = useMemo(() => collectThreadImages(messages), [messages]);

    if (!threadId || images.length === 0) {
        return null;
    }

    return (
        <>
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
            <ThreadImageGallery images={images} threadId={threadId} />
        </>
    );
};

export default ThreadImagesButton;
