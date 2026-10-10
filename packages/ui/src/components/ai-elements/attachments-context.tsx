"use client";

import { createContext } from "react";

import type { AttachmentData, AttachmentMediaCategory, AttachmentVariant } from "./attachments";

// ============================================================================
// Contexts
// ============================================================================

interface AttachmentsContextValue {
    variant: AttachmentVariant;
}

const AttachmentsContext = createContext<AttachmentsContextValue | null>(null);

interface AttachmentContextValue {
    data: AttachmentData;
    mediaCategory: AttachmentMediaCategory;
    onRemove?: () => void;
    variant: AttachmentVariant;
}

const AttachmentContext = createContext<AttachmentContextValue | null>(null);

export { AttachmentContext, type AttachmentContextValue, AttachmentsContext, type AttachmentsContextValue };
