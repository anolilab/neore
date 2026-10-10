"use client";

/**
 * Where a message's link preview cards go. The only piece on the chat's
 * startup path: it finds the URLs (a substring check first, so a message
 * without links costs nothing) and code-splits the cards themselves.
 *
 * Nothing renders while the message streams — its links are still changing,
 * and a card per half-typed URL would fetch and flicker.
 */
import { getVisibleUserText } from "@neore/chat-ui/utils/page-context";
import type { FC } from "react";
import { lazy, Suspense } from "react";

import type { UIMessage } from "@/lib/agent";

import { extractPreviewUrls, hasHttpUrl } from "./extract-preview-urls";

const LazyLinkPreviews = lazy(() => import("./link-previews"));

/** One card (4.5rem) plus the gap between cards (0.5rem) and the list's top margin. */
const CARD_REM = 4.5;
const GAP_REM = 0.5;

const originOf = (url: string | undefined): string | undefined => {
    if (!url) {
        return undefined;
    }

    try {
        return new URL(url).origin;
    } catch {
        return undefined;
    }
};

/**
 * The app's own origins: its links are navigation (or signed storage URLs),
 * not something to preview. Read raw rather than through `@/lib/env`, whose
 * validation would make every importer of the chat row fail to load in tests.
 */
const ownOrigins = (): string[] =>
    [
        globalThis.location?.origin,
        originOf(import.meta.env.VITE_LUNORA_URL as string | undefined),
        originOf(import.meta.env.VITE_SITE_URL as string | undefined),
    ].filter((origin): origin is string => origin !== undefined);

const LinkPreviewSlot: FC<{ isStreaming?: boolean; message: UIMessage }> = ({ isStreaming, message }) => {
    if (isStreaming === true || message.status === "streaming" || (message.role !== "assistant" && message.role !== "user")) {
        return null;
    }

    const text = getVisibleUserText(message);

    if (!hasHttpUrl(text)) {
        return null;
    }

    const urls = extractPreviewUrls(text, { excludeOrigins: ownOrigins() });

    if (urls.length === 0) {
        return null;
    }

    const reserved = `${String(urls.length * CARD_REM + urls.length * GAP_REM)}rem`;

    return (
        <Suspense fallback={<div aria-hidden="true" style={{ height: reserved }} />}>
            <LazyLinkPreviews urls={urls} />
        </Suspense>
    );
};

export default LinkPreviewSlot;
