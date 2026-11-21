"use client";

/**
 * The picture of an image pin in the pins tab. A pin keeps no link to the file (nothing stores a URL to our storage),
 * so the image is looked up in the messages the chat has loaded; a pin whose message is not loaded yet shows a label.
 */

import { useLingui } from "@lingui/react/macro";
import { imageOrdinals } from "@neore/chat-ui/utils/image-ordinals";
import { originsOf } from "@neore/ui/hooks/use-fetchable-origins";
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
 * A short, stable hash: two polynomial hashes over different primes, about 61 bits together. Enough to tell the images
 * of one message apart, and nothing can be read back from it.
 */
const hashOf = (text: string): string => {
    let first = 0;
    let second = 0;

    for (const character of text) {
        const code = character.codePointAt(0) ?? 0;

        first = (first * 31 + code) % 2_147_483_647;
        second = (second * 131 + code) % 1_000_000_007;
    }

    return `${first.toString(36)}${second.toString(36)}`;
};

/** The backend's origin, which serves our signed storage links. Read raw, like `thread/message-content.tsx`. */
const STORAGE_ORIGINS = originsOf(import.meta.env.VITE_LUNORA_URL as string | undefined);

/**
 * An image's key, kept with its pin to find it again: a hash, so no address of the file is stored. A signed link
 * (`sig`) served by our backend is keyed by its path alone, which stays the same when it is signed again or the app's
 * domain moves; any other image, a signed one from another host included, by its host and path, so two hosts serving
 * one path stay apart. `undefined` for an image with no web link (a `data:` URL).
 */
export const imageKeyOf = (source: string): string | undefined => {
    try {
        const url = new URL(source);

        if (url.protocol !== "http:" && url.protocol !== "https:") {
            return undefined;
        }

        const ours = url.searchParams.has("sig") && STORAGE_ORIGINS.includes(url.origin);

        return hashOf(ours ? `storage ${url.pathname}` : `${url.host} ${url.pathname}`);
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
    const matching =
        imageKey === undefined
            ? images.filter((image) => image.ordinal === imageIndex)
            : images.filter((image) => {
                  const source = sourceOf(image.part);

                  return source !== undefined && imageKeyOf(source) === imageKey;
              });
    // Several images with one key (the same file twice): the pin's place among them decides; when it does not, the label
    // shows rather than some other one of them.
    const found = matching.length > 1 ? matching.find((image) => image.ordinal === imageIndex) : matching[0];
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
