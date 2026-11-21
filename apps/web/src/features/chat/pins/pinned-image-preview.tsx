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

/** The source an image part is shown from: `image` on an image part, `url` or `data` on a file part (as `FilePartView`). */
const sourceOf = (part: PartLike): string | undefined => {
    if (part.type === "image") {
        return typeof part.image === "string" && part.image.length > 0 ? part.image : undefined;
    }

    return part.url || part.data || undefined;
};

/**
 * An image's storage path: the path of its signed link, without host or signature, which stays the same when the link is
 * signed again. `undefined` for an image with no link to our storage (a `data:` URL).
 */
export const imageKeyOf = (source: string): string | undefined => {
    try {
        const url = new URL(source);

        return url.protocol === "http:" || url.protocol === "https:" ? url.pathname : undefined;
    } catch {
        return undefined;
    }
};

/**
 * The pinned image of message `messageId`, or `null` when it is not loaded, gone, or not shown. A pin with a storage
 * path (`imageKey`) finds its image by that path wherever it now sits, so an earlier image that became unavailable (and
 * a text part) cannot make it show the next one; a pin without one counts images as chat-ui renders them (`imageIndex`).
 */
export const findPinnedImage = (
    messages: ReadonlyArray<{ id: string; parts: ReadonlyArray<unknown> }>,
    messageId: string,
    imageIndex: number,
    imageKey?: string,
): { filename?: string; url: string } | null => {
    const parts = messages.find((message) => message.id === messageId)?.parts ?? [];
    const images = [...imageOrdinals(parts)].map(([partIndex, ordinal]) => {
        return { ordinal, part: parts[partIndex] as PartLike };
    });
    const found =
        imageKey === undefined
            ? images.find((image) => image.ordinal === imageIndex)
            : images.find((image) => {
                  const source = sourceOf(image.part);

                  return source !== undefined && imageKeyOf(source) === imageKey;
              });
    const source = found ? sourceOf(found.part) : undefined;

    if (!found || !source || found.part.nsfwStatus === "blocked" || found.part.nsfwStatus === "checking") {
        return null;
    }

    return { filename: found.part.filename, url: source };
};

const PinnedImagePreview: FC<{ alt?: string; imageIndex: number; imageKey?: string; messageId: string }> = ({ alt, imageIndex, imageKey, messageId }) => {
    const { t } = useLingui();
    const { messages } = useChatMessages();
    const image = findPinnedImage(messages, messageId, imageIndex, imageKey);

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
