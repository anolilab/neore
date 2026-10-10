"use client";

/**
 * ComposerInput - Chat-specific input component
 *
 * Wraps ComposerInputArea with chat context integration:
 * - Attachment upload via Lunora
 * - Chat actions (sendMessage, cancelStream)
 * - Drag and drop support
 * - Prompt history (ArrowUp/ArrowDown recall of this thread's prompts)
 * - Queueing while a turn streams (`composer-prompt-queue.tsx`)
 * - "Restore to input" requests from the message list (`core/utils/composer-restore.ts`)
 */

import { useLingui } from "@lingui/react/macro";
import { Tooltip, TooltipContent, TooltipTrigger } from "@neore/ui/components/tooltip";
import cn from "@neore/ui/utils/cn";
import { formatNumber } from "@neore/ui/utils/locale-format";
import { AlertTriangleIcon, EditIcon, InfoIcon, XIcon } from "lucide-react";
import type { ChangeEvent, DragEvent, FC } from "react";
import { memo, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState, useSyncExternalStore } from "react";

import ReferenceStrip from "@/features/chat/components/reference-picker/reference-strip";
import type { AttachmentAdapter } from "@/features/chat/core/adapters/lunora-attachment-adapter";
import {
    AttachmentTooLargeError,
    AttachmentUploadError,
    createLunoraAttachmentAdapter,
    getAttachmentFileId,
} from "@/features/chat/core/adapters/lunora-attachment-adapter";
import { useChatActions, useChatIsStreaming, useChatLunora, useChatThread } from "@/features/chat/core/context/chat-context";
import useComparisonChat from "@/features/chat/core/hooks/use-comparison-chat";
import type { PendingAttachment } from "@/features/chat/core/stores/chat-ui-store";
import { selectAttachedReferences, selectRemoveAttachedReference, useChatUIStore, useComposerState } from "@/features/chat/core/stores/chat-ui-store";
import { MIN_COMPARISON_MODELS, useModelStore } from "@/features/chat/core/stores/model-store";
import { usePromptQueueStore } from "@/features/chat/core/stores/prompt-queue-store";
import { captureScreenFrame, isScreenCaptureSupported } from "@/features/chat/core/utils/capture-screen";
import type { ComposerRestoreFile } from "@/features/chat/core/utils/composer-restore";
import { loadRestoreFile, onComposerRestore } from "@/features/chat/core/utils/composer-restore";
import { onComposerSubmitRequest } from "@/features/chat/core/utils/composer-submit";
import ComposerPromptImprovementButton from "@/features/chat/prompt-improvement/components/composer-prompt-improvement-button";
import AutoReadReplies from "@/features/chat/voice-mode/auto-read-replies";
import VoiceModeButton from "@/features/chat/voice-mode/voice-mode-button";
import { trackEvent } from "@/lib/analytics";
import { showError } from "@/lib/toast";

import type { ComposerInputAreaRef } from "./composer-input-area";
import ComposerInputArea from "./composer-input-area";
import ComposerLongTextPrompt from "./composer-long-text-prompt";
import ComposerPromptQueue from "./composer-prompt-queue";
import { isEditable, TextAttachmentEditorDialog } from "./composer-text-attachment-editor";
import useComposerAutocomplete from "./composer-tiptap/use-composer-autocomplete";
import { useAttachmentExtraction } from "./use-attachment-extraction";
import { PromptHistorySource, usePromptHistory } from "./use-prompt-history";

// Context window limits (in characters, roughly 4 chars per token)
const CONTEXT_WARNING_THRESHOLD = 100_000; // ~25k tokens - show warning
const CONTEXT_ERROR_THRESHOLD = 400_000; // ~100k tokens - strong warning

/**
 * Downloads a vault file into a `File`; throws when the download fails. Outside
 * the component because the React Compiler skips any component that throws
 * inside a `try`.
 */
const fetchVaultFile = async (url: string, fileName: string, fileType: string): Promise<File> => {
    const response = await fetch(url);

    if (!response.ok) {
        throw new Error("Failed to fetch vault file");
    }

    return new File([await response.blob()], fileName, { type: fileType });
};

/**
 * Also outside the component: a conditional inside a `catch` makes the React Compiler skip it.
 * An upload failure the adapter recognised (too large, unsupported, expired,
 * failed transfer) is worded by `describe` (translated) and also toasted — the
 * attachment chip only turns red, it has no room for the reason.
 */
const errorMessage = (error: unknown, fallback: string, describe?: (error: AttachmentTooLargeError | AttachmentUploadError) => string): string => {
    if ((error instanceof AttachmentTooLargeError || error instanceof AttachmentUploadError) && describe) {
        const message = describe(error);

        showError(message);

        return message;
    }

    return error instanceof Error ? error.message : fallback;
};

const TEXT_ATTACHMENT_TYPE = /^(?:text\/|application\/(?:json|xml)$)/u;
const TEXT_ATTACHMENT_NAME = /\.(?:md|txt|csv)$/iu;

/** The characters an attachment adds to the prompt as typed text: its size for a text file, nothing for binary. */
const textAttachmentChars = (file: File | undefined): number =>
    file && (TEXT_ATTACHMENT_TYPE.test(file.type) || TEXT_ATTACHMENT_NAME.test(file.name)) ? file.size : 0;

/** The translated sentence for one upload failure; outside the component for the React Compiler. */
const uploadErrorText = (
    error: AttachmentTooLargeError | AttachmentUploadError,
    texts: {
        contentMismatch: (fileName: string) => string;
        expired: (fileName: string) => string;
        failed: (fileName: string) => string;
        tooLarge: (error: AttachmentTooLargeError) => string;
        unsupported: (fileName: string) => string;
    },
): string => {
    if (error instanceof AttachmentTooLargeError) {
        return texts.tooLarge(error);
    }

    switch (error.reason) {
        case "content-mismatch": {
            return texts.contentMismatch(error.fileName);
        }
        case "expired": {
            return texts.expired(error.fileName);
        }
        case "unsupported": {
            return texts.unsupported(error.fileName);
        }
        default: {
            return texts.failed(error.fileName);
        }
    }
};

/**
 * One screen frame as a PNG, or `null` when cancelled; a failure is reported
 * here, outside the component, for the same reason. The browser's own error
 * text is English whatever the locale, so the user sees `failedText` and the
 * detail goes to the console.
 */
const captureScreenOrReport = async (failedText: string): Promise<File | null> => {
    try {
        return await captureScreenFrame();
    } catch (error) {
        console.error("Screen capture failed:", error);
        showError(failedText);

        return null;
    }
};

const noopSubscribe = () => () => {};
const getServerScreenCaptureSupport = () => false;

interface ComposerInputProps {
    autoFocus?: boolean;
    className?: string;
    /** Compact mode - hides attachment button */
    compact?: boolean;
    disabled?: boolean;
    maxRows?: number;
    /** Called when the draw button is clicked — caller controls the draw panel visibility */
    onOpenDraw?: () => void;
    onSubmit?: () => void;

    /**
     * Override the default send logic entirely.
     * Used by comparison parent threads to fan-out the message to all child threads.
     * When set, neither sendMessage nor sendComparisonMessage is called.
     */
    onSubmitOverride?: (text: string, attachments: PendingAttachment[]) => Promise<void>;
    placeholder?: string;
}

export interface ComposerInputRef {
    addFile: (file: File) => void;
    clear: () => void;
    focus: () => void;
    setText: (text: string) => void;
}

/**
 * Attachment preview component - inner component with translations.
 */
const AttachmentPreviewInner: FC<{
    attachment: PendingAttachment;
    onEdit?: () => void;
    onRemove: () => void;
}> = ({ attachment, onEdit, onRemove }) => {
    const { t } = useLingui();
    const isImage = attachment.type === "image";
    const canEdit = attachment.file && isEditable(attachment.file);
    const isText = canEdit;
    const isUploading = attachment.status === "uploading";
    const isError = attachment.status === "error";
    // Documents only: an image goes to the model as itself.
    const extraction = useAttachmentExtraction(attachment.fileId, !isImage && attachment.status === "complete");
    const isReading = extraction === "pending" || extraction === "processing";
    // Named, so the translators see `{attachmentName}` rather than `{0}`.
    const attachmentName = attachment.name;

    // Only create a blob URL when file reference changes, not on every render.
    const imageUrl = useMemo(() => (isImage && attachment.file ? URL.createObjectURL(attachment.file) : undefined), [isImage, attachment.file]);

    useEffect(
        () => () => {
            if (imageUrl) {
                URL.revokeObjectURL(imageUrl);
            }
        },
        [imageUrl],
    );

    return (
        <div className="relative" data-attachment-name={attachment.name} data-attachment-status={attachment.status} data-extraction-status={extraction}>
            {isReading && <span className="sr-only" role="status">{t`Reading "${attachmentName}"…`}</span>}
            {isText ? (
                // Text file preview - expanded card with edit capability
                <div
                    className={cn(
                        "relative w-full max-w-md rounded-lg border p-3 transition-colors",
                        isError
                            ? "border-red-300 bg-red-50 dark:border-red-900 dark:bg-red-950/20"
                            : "border-blue-200 bg-blue-50 dark:border-blue-900/30 dark:bg-blue-950/20",
                        isUploading && "animate-pulse",
                        canEdit &&
                            !isUploading &&
                            "cursor-pointer hover:border-blue-300 hover:bg-blue-100 dark:hover:border-blue-800 dark:hover:bg-blue-950/30",
                    )}
                    onClick={() => {
                        if (canEdit && !isUploading && onEdit) {
                            onEdit();
                        }
                    }}
                    onKeyDown={(e) => {
                        if (!((e.key === "Enter" || e.key === " ") && canEdit && !isUploading && onEdit)) {
                            return;
                        }

                        e.preventDefault();
                        onEdit();
                    }}
                    role="button"
                    tabIndex={canEdit && !isUploading ? 0 : -1}
                >
                    <div className="flex items-start gap-2">
                        <div className="flex size-10 shrink-0 items-center justify-center rounded-md bg-blue-100 dark:bg-blue-900/30">
                            <span className="text-xl">📝</span>
                        </div>
                        <div className="min-w-0 flex-1">
                            <div className="truncate text-sm font-medium text-blue-900 dark:text-blue-100">{attachment.name}</div>
                            <div className="mt-0.5 text-xs text-blue-700 dark:text-blue-300">{canEdit ? t`Click to edit` : t`Text document`}</div>
                        </div>
                        {canEdit && !isUploading && (
                            <Tooltip>
                                <TooltipTrigger
                                    render={
                                        <button
                                            className="shrink-0 rounded-md p-1.5 text-blue-600 hover:bg-blue-200 dark:text-blue-400 dark:hover:bg-blue-900/50"
                                            onClick={(e) => {
                                                e.stopPropagation();
                                                onEdit?.();
                                            }}
                                            type="button"
                                        >
                                            <EditIcon className="size-3.5" />
                                        </button>
                                    }
                                />
                                <TooltipContent>{t`Edit content`}</TooltipContent>
                            </Tooltip>
                        )}
                        <Tooltip>
                            <TooltipTrigger
                                render={
                                    <button
                                        className="shrink-0 rounded-full p-1 text-blue-600 hover:bg-blue-100 dark:text-blue-400 dark:hover:bg-blue-900/30"
                                        onClick={(e) => {
                                            e.stopPropagation();
                                            onRemove();
                                        }}
                                        type="button"
                                    >
                                        <XIcon className="size-3.5" />
                                    </button>
                                }
                            />
                            <TooltipContent>{t`Remove`}</TooltipContent>
                        </Tooltip>
                    </div>
                    {isUploading && (
                        <div className="mt-2 flex items-center gap-2">
                            <div
                                aria-label={t`Uploading ${attachmentName}`}
                                aria-valuemax={100}
                                aria-valuemin={0}
                                aria-valuenow={attachment.progress || 0}
                                className="h-1 w-full overflow-hidden rounded-full bg-blue-200 dark:bg-blue-900/50"
                                role="progressbar"
                            >
                                <div
                                    className="h-full bg-blue-600 transition-[width] duration-300 dark:bg-blue-400"
                                    style={{ width: `${attachment.progress || 0}%` }}
                                />
                            </div>
                            <span aria-hidden="true" className="shrink-0 text-xs text-blue-700 tabular-nums dark:text-blue-300">
                                {`${attachment.progress || 0}%`}
                            </span>
                        </div>
                    )}
                </div>
            ) : (
                // Image/other file preview - compact thumbnail
                <div
                    className={cn(
                        "relative size-14 overflow-hidden rounded-lg border",
                        isError ? "border-red-300 bg-red-50" : "border-gray-200 bg-gray-100 dark:border-gray-700 dark:bg-gray-800",
                        isUploading && "animate-pulse",
                    )}
                >
                    {isImage && imageUrl ? (
                        <img alt={attachment.name} className="h-full w-full object-cover" src={imageUrl} />
                    ) : (
                        <div className="flex h-full w-full items-center justify-center">
                            <span className="text-2xl">📄</span>
                        </div>
                    )}
                    {isUploading && (
                        <div className="absolute inset-0 flex items-center justify-center bg-black/30">
                            <span className="text-xs text-white">{attachment.progress ? `${attachment.progress}%` : "..."}</span>
                        </div>
                    )}
                    {isReading && (
                        <div aria-hidden="true" className="absolute inset-0 flex items-center justify-center bg-black/30">
                            <span className="animate-pulse text-xs text-white">…</span>
                        </div>
                    )}
                    <Tooltip>
                        <TooltipTrigger
                            render={
                                <button
                                    className="absolute -top-1 -right-1 rounded-full bg-white p-0.5 shadow-sm hover:bg-gray-100 dark:bg-gray-800 dark:hover:bg-gray-700"
                                    onClick={onRemove}
                                    type="button"
                                >
                                    <XIcon className="size-3" />
                                </button>
                            }
                        />
                        <TooltipContent>{t`Remove`}</TooltipContent>
                    </Tooltip>
                </div>
            )}
        </div>
    );
};

// Memoized wrapper
const AttachmentPreview = memo(AttachmentPreviewInner);

AttachmentPreview.displayName = "AttachmentPreview";

/**
 * Memoized per-attachment item that creates stable onRemove/onEdit callbacks.
 * Avoids passing inline arrow functions to the memo-wrapped AttachmentPreview.
 */
const AttachmentItem = memo<{
    attachment: PendingAttachment;
    removeAttachment: (id: string) => void;
    setEditingAttachmentId: (id: string) => void;
}>(({ attachment, removeAttachment, setEditingAttachmentId }) => {
    const handleRemove = useCallback(() => removeAttachment(attachment.id), [removeAttachment, attachment.id]);
    const handleEdit = useCallback(() => setEditingAttachmentId(attachment.id), [setEditingAttachmentId, attachment.id]);
    const canEdit = attachment.file && isEditable(attachment.file);

    return <AttachmentPreview attachment={attachment} onEdit={canEdit ? handleEdit : undefined} onRemove={handleRemove} />;
});

AttachmentItem.displayName = "AttachmentItem";

/**
 * Main ComposerInput component.
 */
const ComposerInput = ({
    autoFocus = true,
    className,
    compact = false,
    disabled = false,
    maxRows = 5,
    onOpenDraw,
    onSubmit: onSubmitProp,
    onSubmitOverride,
    placeholder,
    ref,
}: ComposerInputProps & { ref?: React.RefObject<ComposerInputRef | null> }) => {
    const { i18n, t } = useLingui();
    const inputAreaRef = useRef<ComposerInputAreaRef>(null);
    const fileInputRef = useRef<HTMLInputElement>(null);
    const mentionFileInputRef = useRef<HTMLInputElement>(null);
    const [isDragging, setIsDragging] = useState(false);
    const [editingAttachmentId, setEditingAttachmentId] = useState<string | null>(null);

    // Context
    const { cancelStream, jwtToken, sendMessage } = useChatActions();
    const { isStreaming, sseStreamState } = useChatIsStreaming();
    const lunora = useChatLunora();
    const { isNewThread, threadId } = useChatThread();
    // Opt-in ghost text; `undefined` (off) unless the user enabled it in settings.
    const requestCompletion = useComposerAutocomplete();

    // Comparison mode
    const comparisonMode = useModelStore((state) => state.comparisonMode);
    const selectedModelsForComparison = useModelStore((state) => state.selectedModelsForComparison);
    const { isLoading: isComparisonLoading, sendComparisonMessage } = useComparisonChat({ jwtToken });
    const isComparisonValid = comparisonMode && selectedModelsForComparison.length >= MIN_COMPARISON_MODELS;

    // SSE streaming in progress
    const isSSEStreaming = !!sseStreamState;

    // Composer state from store
    const { addAttachment, attachments, clear, removeAttachment, setText, text, updateAttachment } = useComposerState();

    // Prompt history and queue-while-streaming: only for a plain thread composer.
    // The comparison parent fans out through `onSubmitOverride`, and the compact
    // landing bar has no thread to recall from or queue against.
    const isThreadComposer = !onSubmitOverride && !compact && Boolean(threadId);

    const getComposerText = useCallback(() => useChatUIStore.getState().composerText, []);
    const promptHistory = usePromptHistory(getComposerText);

    // Reference images attached for the next outgoing message — rendered as a numbered strip
    // above the attachments row so the user can see (and the model will receive) them in order.
    const attachedReferences = useChatUIStore(selectAttachedReferences);
    const removeAttachedReference = useChatUIStore(selectRemoveAttachedReference);

    // True while any attachment is still uploading — blocks send and shows spinner on button
    const hasUploadingAttachments = attachments.some((a) => a.status === "pending" || a.status === "uploading");
    // bannedContent is subscribed because it drives render output (word highlights + error message).
    // isSubmitting / setIsSubmitting / setComposerBannedContent are only read inside callbacks
    // so we access them via getState() to avoid unnecessary re-renders (rerender-defer-reads).
    const bannedContent = useChatUIStore((state) => state.composerBannedContent);

    // Compute word-highlight positions from server-returned banned words using cheap indexOf.
    // This avoids running the expensive 16k-pattern regex on the client.
    const bannedWordMatches = useMemo(() => {
        if (!bannedContent || bannedContent.words.length === 0) {
            return [];
        }

        const lower = text.toLowerCase();
        const matches: { endIndex: number; language: string; startIndex: number; word: string }[] = [];

        for (const word of bannedContent.words) {
            const lowerWord = word.toLowerCase();
            let index = lower.indexOf(lowerWord);

            while (index !== -1) {
                matches.push({ endIndex: index + word.length, language: "unknown", startIndex: index, word });
                index = lower.indexOf(lowerWord, index + 1);
            }
        }

        return matches;
    }, [bannedContent, text]);

    // Attachment adapter — built once, lazily, so it is not rebuilt on every render.
    const attachmentAdapterRef = useRef<AttachmentAdapter | null>(null);

    if (attachmentAdapterRef.current === null) {
        attachmentAdapterRef.current = createLunoraAttachmentAdapter(lunora);
    }

    const attachmentAdapter = attachmentAdapterRef.current;

    const describeUploadError = useCallback(
        (error: AttachmentTooLargeError | AttachmentUploadError): string =>
            uploadErrorText(error, {
                contentMismatch: (fileName) => t`"${fileName}" could not be attached: its contents do not match its file type.`,
                expired: (fileName) => t`The upload of "${fileName}" expired. Please attach it again.`,
                failed: (fileName) => t`"${fileName}" could not be uploaded. Check your connection and try again.`,
                tooLarge: ({ fileName, isDocument, maxMegabytes }) =>
                    isDocument
                        ? t`"${fileName}" is too large. Documents can be at most ${maxMegabytes} MB.`
                        : t`"${fileName}" is too large. Files of this type can be at most ${maxMegabytes} MB.`,
                unsupported: (fileName) => t`"${fileName}" cannot be attached: this file type is not supported.`,
            }),
        [t],
    );

    // Handle file selection
    const handleFileSelect = useCallback(
        async (files: FileList | File[]) => {
            const fileArray = [...files];

            // The uploads are independent, so run them together instead of one after another.
            // `addAttachment` still runs in file order because each callback's body is
            // synchronous up to the first await.
            await Promise.all(
                fileArray.map(async (file) => {
                    const attachmentId = addAttachment(file);
                    // Outside the `try`, where a logical expression makes the React Compiler skip the component.
                    const fileType = file.type || "unknown";

                    try {
                        updateAttachment(attachmentId, { status: "uploading" });

                        const result = await attachmentAdapter.upload({
                            file,
                            onProgress: (progress) => {
                                updateAttachment(attachmentId, { progress });
                            },
                        });

                        const fileId = getAttachmentFileId(result);

                        updateAttachment(attachmentId, {
                            fileId,
                            progress: 100,
                            status: "complete",
                        });

                        trackEvent("file_uploaded", { file_type: fileType });
                    } catch (error) {
                        console.error("Failed to upload attachment:", error);
                        updateAttachment(attachmentId, {
                            error: errorMessage(error, t`Upload failed`, describeUploadError),
                            status: "error",
                        });
                    }
                }),
            );
        },
        [addAttachment, attachmentAdapter, updateAttachment, t, describeUploadError],
    );

    // Expose ref methods
    useImperativeHandle(ref, () => {
        return {
            addFile: (file: File) => {
                void handleFileSelect([file]);
            },
            clear: () => clear(),
            focus: () => inputAreaRef.current?.focus(),
            setText: (newText: string) => setText(newText),
        };
    }, [setText, clear, handleFileSelect]);

    // Calculate total input size and check context limits
    const contextStats = useMemo(() => {
        const textChars = text.length;
        // A text attachment's bytes roughly are its characters. A binary one's
        // are not: a 3 MB PDF read as ~786k tokens and blocked sending, while
        // the model receives only its extracted text (or the media itself).
        const attachmentChars = attachments.reduce((total, att) => total + textAttachmentChars(att.file), 0);
        const totalChars = textChars + attachmentChars;
        const estimatedTokens = Math.ceil(totalChars / 4);

        return { estimatedTokens, totalChars };
    }, [text, attachments]);

    const contextWarning = useMemo(() => {
        if (contextStats.totalChars >= CONTEXT_ERROR_THRESHOLD) {
            return {
                level: "error" as const,
                message: t`Your input is too large (~${formatNumber(contextStats.estimatedTokens, i18n.locale)} tokens) and exceeds the model's context window. Please reduce the message length or remove attachments to submit.`,
            };
        }

        if (contextStats.totalChars >= CONTEXT_WARNING_THRESHOLD) {
            return {
                level: "warning" as const,
                message: t`Your input is large (~${formatNumber(contextStats.estimatedTokens, i18n.locale)} tokens) and will consume a significant portion of the model's context window.`,
            };
        }

        return null;
    }, [contextStats, i18n.locale, t]);

    // Handle file input change
    const handleFileInputChange = useCallback(
        (e: ChangeEvent<HTMLInputElement>) => {
            const { files } = e.target;

            if (files && files.length > 0) {
                handleFileSelect(files);
            }

            e.target.value = "";
        },
        [handleFileSelect],
    );

    // Handle drag events
    const handleDragEnter = useCallback((e: DragEvent) => {
        e.preventDefault();
        e.stopPropagation();
        setIsDragging(true);
    }, []);

    const handleDragLeave = useCallback((e: DragEvent) => {
        e.preventDefault();
        e.stopPropagation();
        setIsDragging(false);
    }, []);

    const handleDragOver = useCallback((e: DragEvent) => {
        e.preventDefault();
        e.stopPropagation();
    }, []);

    const handleDrop = useCallback(
        (e: DragEvent) => {
            e.preventDefault();
            e.stopPropagation();
            setIsDragging(false);

            const { files } = e.dataTransfer;

            if (files && files.length > 0) {
                handleFileSelect(files);
            }
        },
        [handleFileSelect],
    );

    // Handle paste - auto-convert long text to attachment
    const handlePaste = useCallback(
        async (e: React.ClipboardEvent) => {
            const { items } = e.clipboardData;
            const files: File[] = [];

            // Check for files first
            for (const item of items) {
                if (item.kind !== "file") {
                    continue;
                }

                const file = item.getAsFile();

                if (file) {
                    files.push(file);
                }
            }

            if (files.length > 0) {
                e.preventDefault();
                handleFileSelect(files);

                return;
            }

            // Check for long text content
            const pastedText = e.clipboardData.getData("text/plain");

            if (pastedText) {
                const lines = pastedText.split("\n").length;
                const chars = pastedText.length;

                // Auto-convert if text is long (>500 chars or >10 lines)
                if (chars > 500 || lines > 10) {
                    e.preventDefault();

                    // Create text file attachment
                    const blob = new Blob([pastedText], { type: "text/plain" });
                    const timestamp = new Date().toISOString().split("T", 1)[0];
                    const file = new File([blob], `pasted-text-${timestamp}.txt`, { type: "text/plain" });

                    // Add as attachment
                    const attachmentId = addAttachment(file);

                    try {
                        updateAttachment(attachmentId, { status: "uploading" });

                        const result = await attachmentAdapter.upload({
                            file,
                            onProgress: (progress) => {
                                updateAttachment(attachmentId, { progress });
                            },
                        });

                        const fileId = getAttachmentFileId(result);

                        updateAttachment(attachmentId, {
                            fileId,
                            progress: 100,
                            status: "complete",
                        });
                    } catch (error) {
                        console.error("Failed to convert pasted text:", error);
                        updateAttachment(attachmentId, {
                            error: errorMessage(error, t`Conversion failed`, describeUploadError),
                            status: "error",
                        });
                    }
                }
            }
        },
        [handleFileSelect, addAttachment, attachmentAdapter, updateAttachment, t, describeUploadError],
    );

    // Handle text change — clear banned content error when user edits.
    // Read bannedContent and setter via getState() so this callback doesn't subscribe
    // to store changes and doesn't need to be recreated when bannedContent changes.
    const handleTextChange = useCallback(
        (value: string) => {
            setText(value);
            promptHistory.onTextChange(value);

            if (useChatUIStore.getState().composerBannedContent) {
                useChatUIStore.getState().setComposerBannedContent(null);
            }
        },
        [setText, promptHistory],
    );

    // Handle submit — fully synchronous, fire-and-forget network call.
    // Optimistic state (user message + Thinking...) is shown immediately inside
    // sendMessage before the first await. The network request runs in the background.
    // Content safety (banned words) is validated server-side in the /chat/stream endpoint.
    const handleSubmit = useCallback(() => {
        if (!text.trim() && attachments.length === 0) {
            return;
        }

        // Read isSubmitting via getState() — it's only needed as a guard here, not in render output.
        // This avoids subscribing to isSubmitting and re-rendering ComposerInput on every submission.
        if (disabled || useChatUIStore.getState().isSubmitting) {
            return;
        }

        const pendingAttachments = attachments.filter((a) => a.status !== "complete");

        if (pendingAttachments.length > 0) {
            return;
        }

        // Block submission if context is too large
        if (contextStats.totalChars >= CONTEXT_ERROR_THRESHOLD) {
            return;
        }

        promptHistory.reset();

        // A turn is still running: queue instead of sending. The queue sends it
        // when the stream finishes (see ComposerPromptQueue).
        if (isStreaming) {
            if (!isThreadComposer || isComparisonValid || !threadId) {
                return;
            }

            usePromptQueueStore.getState().enqueue(threadId, { attachments, text });
            clear();

            return;
        }

        // Set submitting flag briefly (guards against double-send, cleared inside sendMessage)
        useChatUIStore.getState().setIsSubmitting(true);

        if (onSubmitOverride) {
            // Comparison parent: fan-out to all child threads
            void onSubmitOverride(text, attachments).then(() => {
                clear();
                useChatUIStore.getState().setIsSubmitting(false);

                return undefined;
            });
        } else if (isComparisonValid) {
            void sendComparisonMessage(text, selectedModelsForComparison, attachments).then(() => {
                useChatUIStore.getState().setIsSubmitting(false);

                return undefined;
            });
        } else {
            // Fire-and-forget: sendMessage updates optimistic state synchronously
            // (clears composer, shows Thinking...) then runs the fetch in the background
            void sendMessage(text, attachments);
        }

        onSubmitProp?.();
    }, [
        text,
        attachments,
        disabled,
        sendMessage,
        onSubmitProp,
        contextStats,
        isComparisonValid,
        sendComparisonMessage,
        selectedModelsForComparison,
        onSubmitOverride,
        clear,
        promptHistory,
        isStreaming,
        isThreadComposer,
        threadId,
    ]);

    // "Send as a new chat" from outside the chat UI (the native shell's Quick
    // Composer — see `core/utils/composer-submit.ts`). Only the full new-thread
    // composer takes it; it fills the text, and the effect below submits once
    // that text has rendered and the composer can send.
    const autoSubmitTextRef = useRef<string | null>(null);
    const isAutoSubmitTarget = !onSubmitOverride && !compact && isNewThread;

    useEffect(() => {
        if (!isAutoSubmitTarget) {
            return undefined;
        }

        return onComposerSubmitRequest(({ text: requested }) => {
            autoSubmitTextRef.current = requested;
            setText(requested);
        });
    }, [isAutoSubmitTarget, setText]);

    useEffect(() => {
        if (autoSubmitTextRef.current === null || autoSubmitTextRef.current !== text || disabled || isStreaming) {
            return;
        }

        // One attempt: if a guard in `handleSubmit` refuses, the text stays in
        // the composer for the user to send.
        autoSubmitTextRef.current = null;
        handleSubmit();
    }, [disabled, handleSubmit, isStreaming, text]);

    // Handle cancel/stop
    // A manual stop pauses the queue: the chips stay, nothing auto-sends.
    const handleCancel = useCallback(() => {
        if (threadId) {
            usePromptQueueStore.getState().setPaused(threadId, true);
        }

        cancelStream();
    }, [cancelStream, threadId]);

    // Handle add attachment button
    const handleAddAttachment = useCallback(() => {
        fileInputRef.current?.click();
    }, []);

    // Screen capture: offered only where `getDisplayMedia` exists. The server
    // snapshot is `false`, so hydration matches and the item appears client-side.
    const canCaptureScreen = useSyncExternalStore(noopSubscribe, isScreenCaptureSupported, getServerScreenCaptureSupport);
    const handleCaptureScreen = useCallback(() => {
        void captureScreenOrReport(t`Screen capture failed. Please try again.`).then(async (file) => {
            if (file) {
                await handleFileSelect([file]);
            }

            return undefined;
        });
    }, [handleFileSelect, t]);

    // Handle vault file selection from @ popup — fetch the file and process it
    const handleSelectVaultFile = useCallback(
        async (vaultFile: { _id: string; fileName: string; fileSize: number; fileType: string; url?: string }) => {
            if (!vaultFile.url) {
                return;
            }

            const attachmentId = addAttachment(new File([], vaultFile.fileName, { type: vaultFile.fileType }));

            updateAttachment(attachmentId, { status: "uploading" });

            try {
                const file = await fetchVaultFile(vaultFile.url, vaultFile.fileName, vaultFile.fileType);

                // Replace the placeholder File with the real one
                updateAttachment(attachmentId, { file });

                const result = await attachmentAdapter.upload({
                    file,
                    onProgress: (progress) => {
                        updateAttachment(attachmentId, { progress });
                    },
                });

                const fileId = getAttachmentFileId(result);

                updateAttachment(attachmentId, {
                    fileId,
                    progress: 100,
                    status: "complete",
                });
            } catch (error) {
                console.error("Failed to attach vault file:", error);
                updateAttachment(attachmentId, {
                    error: errorMessage(error, t`Failed to attach file`, describeUploadError),
                    status: "error",
                });
            }
        },
        [addAttachment, attachmentAdapter, updateAttachment, t, describeUploadError],
    );

    // "Restore to input" from a sent user message: text replaces the draft, the
    // message's files are re-fetched and re-uploaded as fresh attachments.
    const restoreFile = useCallback(
        async (restoreFileRef: ComposerRestoreFile, index: number) => {
            const attachmentId = addAttachment(new File([], restoreFileRef.filename ?? `attachment-${index + 1}`, { type: restoreFileRef.mediaType }));

            updateAttachment(attachmentId, { status: "uploading" });

            try {
                const file = await loadRestoreFile(restoreFileRef, index);

                updateAttachment(attachmentId, { file, name: file.name });

                const result = await attachmentAdapter.upload({
                    file,
                    onProgress: (progress) => {
                        updateAttachment(attachmentId, { progress });
                    },
                });

                updateAttachment(attachmentId, { fileId: getAttachmentFileId(result), progress: 100, status: "complete" });
            } catch (error) {
                console.error("Failed to restore attachment:", error);
                updateAttachment(attachmentId, {
                    error: errorMessage(error, t`Failed to restore attachment`, describeUploadError),
                    status: "error",
                });
            }
        },
        [addAttachment, attachmentAdapter, updateAttachment, t, describeUploadError],
    );

    useEffect(
        () =>
            onComposerRestore(({ files, text: restoredText }) => {
                promptHistory.reset();
                setText(restoredText);
                void Promise.all(files.map((file, index) => restoreFile(file, index)));
                inputAreaRef.current?.focus();
            }),
        [promptHistory, restoreFile, setText],
    );

    // Handle "Upload new file" from @ popup — open file dialog
    const handleSelectFileUpload = useCallback(() => {
        mentionFileInputRef.current?.click();
    }, []);

    // Convert long text to attachment
    const handleConvertToAttachment = useCallback(async () => {
        if (!text.trim()) {
            return;
        }

        // Create a text file from the content
        const blob = new Blob([text], { type: "text/plain" });
        const timestamp = new Date().toISOString().split("T", 1)[0];
        const file = new File([blob], `text-input-${timestamp}.txt`, { type: "text/plain" });

        // Add as attachment
        const attachmentId = addAttachment(file);

        try {
            updateAttachment(attachmentId, { status: "uploading" });

            const result = await attachmentAdapter.upload({
                file,
                onProgress: (progress) => {
                    updateAttachment(attachmentId, { progress });
                },
            });

            const fileId = getAttachmentFileId(result);

            updateAttachment(attachmentId, {
                fileId,
                progress: 100,
                status: "complete",
            });

            // Clear the text after successful conversion
            setText("");
        } catch (error) {
            console.error("Failed to convert text to attachment:", error);
            updateAttachment(attachmentId, {
                error: errorMessage(error, t`Conversion failed`, describeUploadError),
                status: "error",
            });
        }
    }, [text, addAttachment, attachmentAdapter, updateAttachment, setText, t, describeUploadError]);

    // Handle attachment file update (for editing)
    const handleAttachmentUpdate = useCallback(
        async (attachmentId: string, newFile: File) => {
            try {
                updateAttachment(attachmentId, {
                    file: newFile,
                    name: newFile.name,
                    status: "uploading",
                });

                const result = await attachmentAdapter.upload({
                    file: newFile,
                    onProgress: (progress) => {
                        updateAttachment(attachmentId, { progress });
                    },
                });

                const fileId = getAttachmentFileId(result);

                updateAttachment(attachmentId, {
                    fileId,
                    progress: 100,
                    status: "complete",
                });
            } catch (error) {
                console.error("Failed to update attachment:", error);
                updateAttachment(attachmentId, {
                    error: errorMessage(error, t`Update failed`, describeUploadError),
                    status: "error",
                });
            }
        },
        [attachmentAdapter, updateAttachment, t, describeUploadError],
    );

    const hasAttachments = attachments.length > 0;
    const hasAttachedReferences = attachedReferences.length > 0;
    const editingAttachment = editingAttachmentId ? attachments.find((a) => a.id === editingAttachmentId) : null;

    return (
        <div
            className={cn("w-full", className)}
            data-dragging={isDragging}
            onDragEnter={handleDragEnter}
            onDragLeave={handleDragLeave}
            onDragOver={handleDragOver}
            onDrop={handleDrop}
        >
            {/* Hidden file input (attachment button) */}
            <input accept="image/*,.pdf,.doc,.docx,.txt,.md" className="hidden" multiple onChange={handleFileInputChange} ref={fileInputRef} type="file" />
            {/* Hidden file input (@ mention trigger - dynamic accept) */}
            <input className="hidden" multiple onChange={handleFileInputChange} ref={mentionFileInputRef} type="file" />

            {/* Long text conversion prompt */}
            {!compact && <ComposerLongTextPrompt minLines={10} onConvert={handleConvertToAttachment} text={text} threshold={500} />}

            {/* Text attachment editor dialog */}
            {!compact && editingAttachment && editingAttachment.file && (
                <TextAttachmentEditorDialog
                    file={editingAttachment.file}
                    onOpenChange={(open) => {
                        if (!open) {
                            setEditingAttachmentId(null);
                        }
                    }}
                    onUpdate={(newFile) => {
                        handleAttachmentUpdate(editingAttachment.id, newFile);
                    }}
                    open={!!editingAttachmentId}
                />
            )}

            {isThreadComposer && <PromptHistorySource onEntries={promptHistory.setEntries} />}
            {isThreadComposer && <ComposerPromptQueue />}
            {isThreadComposer && <AutoReadReplies />}

            <ComposerInputArea
                afterTextarea={
                    compact ? undefined : (
                        <>
                            {!onSubmitOverride && <VoiceModeButton disabled={disabled} />}
                            <ComposerPromptImprovementButton threadId={threadId} />
                        </>
                    )
                }
                autoFocus={compact ? false : autoFocus}
                bannedWordError={bannedContent?.message ?? null}
                bannedWordMatches={bannedWordMatches}
                beforeInput={
                    !compact &&
                    (contextWarning || hasAttachments || hasAttachedReferences) && (
                        <div className="space-y-2">
                            {/* Context Warning Banner */}
                            {contextWarning && (
                                <div
                                    className={cn(
                                        "mx-2 mt-2 flex items-start gap-2 rounded-lg border px-3 py-2",
                                        contextWarning.level === "error"
                                            ? "border-red-200 bg-red-50 dark:border-red-900/50 dark:bg-red-950/30"
                                            : "border-amber-200 bg-amber-50 dark:border-amber-900/50 dark:bg-amber-950/30",
                                    )}
                                >
                                    {contextWarning.level === "error" ? (
                                        <AlertTriangleIcon className="mt-0.5 size-4 shrink-0 text-red-600 dark:text-red-400" />
                                    ) : (
                                        <InfoIcon className="mt-0.5 size-4 shrink-0 text-amber-600 dark:text-amber-400" />
                                    )}
                                    <p
                                        className={cn(
                                            "text-xs leading-relaxed",
                                            contextWarning.level === "error" ? "text-red-800 dark:text-red-200" : "text-amber-800 dark:text-amber-200",
                                        )}
                                    >
                                        {contextWarning.message}
                                    </p>
                                </div>
                            )}

                            {/* Reference images strip — numbered "1, 2, 3..." badges so the order
                                is visible to the user and matches what downstream tools forward. */}
                            {hasAttachedReferences && (
                                <ReferenceStrip className="mx-2 mt-2" onRemove={removeAttachedReference} references={attachedReferences} />
                            )}

                            {/* Attachments */}
                            {hasAttachments && (
                                <div className="mb-2 flex flex-wrap gap-2 px-2 pt-2">
                                    {attachments.map((attachment) => (
                                        <AttachmentItem
                                            attachment={attachment}
                                            key={attachment.id}
                                            removeAttachment={removeAttachment}
                                            setEditingAttachmentId={setEditingAttachmentId}
                                        />
                                    ))}
                                </div>
                            )}
                        </div>
                    )
                }
                canQueueWhileStreaming={isThreadComposer && !isComparisonValid}
                disabled={disabled || isComparisonLoading}
                isStreaming={isSSEStreaming || isComparisonLoading}
                isUploading={hasUploadingAttachments}
                maxRows={maxRows}
                onAddAttachment={compact ? undefined : handleAddAttachment}
                onCancel={handleCancel}
                onCaptureScreen={compact || !canCaptureScreen ? undefined : handleCaptureScreen}
                onChange={handleTextChange}
                onDraw={compact ? undefined : onOpenDraw}
                onHistoryNavigate={isThreadComposer ? promptHistory.navigate : undefined}
                onPaste={compact ? undefined : handlePaste}
                onSelectFileUpload={compact ? undefined : handleSelectFileUpload}
                onSelectVaultFile={compact ? undefined : handleSelectVaultFile}
                onSubmit={handleSubmit}
                placeholder={placeholder ?? t`Type your message...`}
                ref={inputAreaRef}
                requestCompletion={compact ? undefined : requestCompletion}
                value={text}
            />

            {/* Drag overlay */}
            {isDragging && (
                <div className="absolute inset-0 flex items-center justify-center rounded-lg border-2 border-dashed border-blue-400 bg-blue-50/80 dark:bg-blue-900/30">
                    <span className="text-blue-600 dark:text-blue-400">{t`Drop files here`}</span>
                </div>
            )}
        </div>
    );
};

ComposerInput.displayName = "ComposerInput";

export default ComposerInput;
