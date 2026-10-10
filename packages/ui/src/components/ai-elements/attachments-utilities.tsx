"use client";

import type { I18n } from "@lingui/core";
import { msg } from "@lingui/core/macro";
import { use } from "react";

import type { AttachmentData, AttachmentMediaCategory } from "./attachments";
import { AttachmentContext, AttachmentsContext } from "./attachments-context";

// ============================================================================
// Utility Functions
// ============================================================================

const getMediaCategory = (data: AttachmentData): AttachmentMediaCategory => {
    if (data.type === "source-document") {
        return "source";
    }

    const mediaType = data.mediaType ?? "";

    if (mediaType.startsWith("image/")) {
        return "image";
    }

    if (mediaType.startsWith("video/")) {
        return "video";
    }

    if (mediaType.startsWith("audio/")) {
        return "audio";
    }

    if (mediaType.startsWith("application/") || mediaType.startsWith("text/")) {
        return "document";
    }

    return "unknown";
};

const getAttachmentLabel = (data: AttachmentData, i18n: I18n): string => {
    if (data.type === "source-document") {
        return data.title || data.filename || i18n._(msg`Source`);
    }

    const category = getMediaCategory(data);

    return data.filename || (category === "image" ? i18n._(msg`Image`) : i18n._(msg`Attachment`));
};

// ============================================================================
// Hooks
// ============================================================================

const useAttachmentsContext = () => use(AttachmentsContext) ?? { variant: "grid" as const };

const useAttachmentContext = () => {
    const ctx = use(AttachmentContext);

    if (!ctx) {
        throw new Error("Attachment components must be used within <Attachment>");
    }

    return ctx;
};

export { getAttachmentLabel, getMediaCategory, useAttachmentContext, useAttachmentsContext };
