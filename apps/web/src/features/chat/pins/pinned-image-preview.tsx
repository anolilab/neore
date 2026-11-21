"use client";

/**
 * The picture of an image pin in the pins tab. A pin keeps no link to the file (nothing stores a URL to our storage),
 * so the image is looked up in the messages the chat has loaded; a pin whose message is not loaded yet shows a label.
 */

import { useLingui } from "@lingui/react/macro";
import { ImageIcon } from "lucide-react";
import type { FC } from "react";

import { useChatMessages } from "@/features/chat/core/context/chat-context";

interface PartLike {
    filename?: string;
    image?: unknown;
    mediaType?: string;
    nsfwStatus?: string;
    type: string;
    url?: string;
}

/** The shown image at `partIndex` of message `messageId`, or `null` when it is not loaded, not an image, or not shown. */
export const findPinnedImage = (
    messages: ReadonlyArray<{ id: string; parts: ReadonlyArray<unknown> }>,
    messageId: string,
    partIndex: number,
): { filename?: string; url: string } | null => {
    const part = messages.find((message) => message.id === messageId)?.parts[partIndex] as PartLike | undefined;

    if (!part || part.nsfwStatus === "blocked" || part.nsfwStatus === "checking") {
        return null;
    }

    if (part.type === "image" && typeof part.image === "string" && part.image.length > 0) {
        return { filename: part.filename, url: part.image };
    }

    if (part.type === "file" && part.mediaType?.startsWith("image/") === true && part.url) {
        return { filename: part.filename, url: part.url };
    }

    return null;
};

const PinnedImagePreview: FC<{ alt?: string; messageId: string; partIndex: number }> = ({ alt, messageId, partIndex }) => {
    const { t } = useLingui();
    const { messages } = useChatMessages();
    const image = findPinnedImage(messages, messageId, partIndex);

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
