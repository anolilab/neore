"use client";

import { ImageOpenContext } from "@neore/chat-ui/chat/image-open-context";
import type { FC, ReactNode } from "react";
import { useMemo } from "react";

import { useChatThreadIdentity } from "@/features/chat/core/context/chat-context-hooks";

import { useImageGalleryStore } from "./image-gallery-store";
import ThreadImageGallery from "./thread-image-gallery";
import useThreadImages from "./use-thread-images";

/**
 * Mounts the chat's image gallery and lets the tool images below it open it (`ImageOpenContext`). It sits under each
 * chat's provider, not in the header, so a split pane's images open their own chat's gallery whether or not the pane
 * has focus. A chat without an id yet has no gallery, and its images stay plain.
 */
const ChatImageGallery: FC<{ children: ReactNode }> = ({ children }) => {
    const { threadId } = useChatThreadIdentity();
    const images = useThreadImages();
    const openAt = useImageGalleryStore((state) => state.openAt);
    const openImage = useMemo(() => (threadId ? (key: string) => openAt(threadId, key) : null), [openAt, threadId]);

    return (
        <ImageOpenContext value={openImage}>
            {children}
            {threadId && <ThreadImageGallery images={images} threadId={threadId} />}
        </ImageOpenContext>
    );
};

export default ChatImageGallery;
