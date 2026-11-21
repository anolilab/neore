"use client";

/**
 * The picture of an image pin in the pins tab. A pin keeps no link to the file (nothing stores a URL to our storage),
 * so the image is looked up in the messages the chat has loaded; a pin whose message is not loaded yet shows a label.
 */

import { useLingui } from "@lingui/react/macro";
import { imageOrdinals } from "@neore/chat-ui/utils/image-ordinals";
import { ImageIcon } from "lucide-react";
import type { FC } from "react";

import { useChatMessages } from "@/features/chat/core/context/chat-context-hooks";

interface PartLike {
    data?: string;
    filename?: string;
    image?: unknown;
    mediaType?: string;
    nsfwStatus?: string;
    type: string;
    url?: string;
}

/**
 * The `imageIndex`-th image of message `messageId` (counted as chat-ui renders them, `imageOrdinals`), or `null` when it
 * is not loaded, there is no such image, or it is not shown.
 */
export const findPinnedImage = (
    messages: ReadonlyArray<{ id: string; parts: ReadonlyArray<unknown> }>,
    messageId: string,
    imageIndex: number,
): { filename?: string; url: string } | null => {
    const parts = messages.find((message) => message.id === messageId)?.parts ?? [];
    const partIndex = [...imageOrdinals(parts)].find(([, ordinal]) => ordinal === imageIndex)?.[0];
    const part = partIndex === undefined ? undefined : (parts[partIndex] as PartLike | undefined);

    if (!part || part.nsfwStatus === "blocked" || part.nsfwStatus === "checking") {
        return null;
    }

    if (part.type === "image" && typeof part.image === "string" && part.image.length > 0) {
        return { filename: part.filename, url: part.image };
    }

    // As chat-ui's `FilePartView` reads it: a stored file's signed link can be in `data` rather than `url`.
    const fileUrl = part.url || part.data;

    if (part.type === "file" && fileUrl) {
        return { filename: part.filename, url: fileUrl };
    }

    return null;
};

const PinnedImagePreview: FC<{ alt?: string; imageIndex: number; messageId: string }> = ({ alt, messageId, imageIndex }) => {
    const { t } = useLingui();
    const { messages } = useChatMessages();
    const image = findPinnedImage(messages, messageId, imageIndex);

    if (!image) {
        return (
            <div className="text-muted-foreground/60 mb-2 flex items-center gap-1.5 text-xs">
                <ImageIcon aria-hidden="true" className="size-3" />
                <span className="italic">{t`Image pinned`}</span>
            </div>
        );
    }

    return (
        <img
            alt={alt || image.filename || t`Pinned image`}
            className="mb-2 max-h-40 w-full rounded object-contain"
            decoding="async"
            loading="lazy"
            src={image.url}
        />
    );
};

export default PinnedImagePreview;
