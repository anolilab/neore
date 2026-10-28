"use client";

/**
 * ComposerInputArea - Shared input row component
 *
 * The visual input row with attachment button, separator, tiptap editor, and action buttons.
 * Uses tiptap for the input area, providing:
 * - Slash commands (/model, /prompt, /skill)
 * - File @ mentions for attachments
 * - Variable autocomplete ({{variable}})
 * - Banned word highlighting via ProseMirror decorations
 * - Enter to submit, Shift+Enter for newline
 *
 * Used by both chat ComposerInput and landing composer.
 */

import { useLingui } from "@lingui/react/macro";
import type { FollowUpControl } from "@neore/ai/capabilities";
import { buttonVariants } from "@neore/ui/components/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@neore/ui/components/responsive-dropdown-menu";
import { Separator } from "@neore/ui/components/separator";
import { Tooltip, TooltipContent, TooltipTrigger } from "@neore/ui/components/tooltip";
import clsx from "clsx";
import { CornerDownRightIcon, ListPlusIcon, Loader2Icon, MonitorIcon, PencilIcon, PlusIcon, SendIcon, Square, UploadIcon } from "lucide-react";
import type { ReactNode } from "react";
import { lazy, Suspense, useImperativeHandle, useRef } from "react";

import type { PromptHistoryDirection } from "@/features/chat/core/utils/prompt-history";
import type { PromptVariable } from "@/features/prompts/lib/prompt-variables";

import type { ChatReference } from "./chat-reference";
import ComposerTextCounter from "./composer-text-counter";
import type { ComposerTiptapEditorRef } from "./composer-tiptap/composer-tiptap-editor";
import { ComposerTiptapEditor } from "./composer-tiptap/composer-tiptap-editor";
import type { BannedWordMatch } from "./composer-tiptap/extensions/banned-word-decoration";
import type { VaultFileRef } from "./composer-tiptap/file-mention-popup";
import type { GhostRequest } from "./composer-tiptap/ghost-completion-controller";

const ComposerVoiceInput = lazy(() => import("./composer-voice-input"));

interface ComposerInputAreaProps {
    /** Content to render between editor and submit button (e.g., prompt improvement button) */
    afterTextarea?: ReactNode;
    /** Auto focus on mount */
    autoFocus?: boolean;
    /** Banned word error message */
    bannedWordError?: string | null;
    /** Banned word matches for highlighting */
    bannedWordMatches?: BannedWordMatch[];
    /** Content to render before the input row (e.g., attachment previews) */
    beforeInput?: ReactNode;

    /**
     * While streaming, also show a "queue message" button next to Stop. The
     * submit handler decides what queuing means; Enter already reaches it.
     */
    canQueueWhileStreaming?: boolean;
    /** Show compact version */
    compact?: boolean;
    /** The chat being typed into; the @ popup does not offer it as a reference */
    currentThreadId?: string;
    /** Custom variables for {{variable}} autocomplete */
    customVariables?: PromptVariable[];
    /** Whether input is disabled */
    disabled?: boolean;

    /**
     * How the runner takes a message sent while it works (`followUpControl`). Only a steer
     * shows the button; omitted, it reads as "none", so a runner that did not say hides it.
     */
    followUp?: FollowUpControl;
    /** Whether a recalled prompt is showing, see `ComposerTiptapEditor` */
    isHistoryRecalled?: () => boolean;
    /** Whether streaming is active (shows stop button) */
    isStreaming?: boolean;
    /** Whether file uploads are in progress (disables send with upload tooltip) */
    isUploading?: boolean;
    /** Max rows for editor */
    maxRows?: number;
    /** Called when attachment button is clicked */
    onAddAttachment?: () => void;
    /** Called when cancel/stop is clicked */
    onCancel?: () => void;
    /** Called when "Capture screen" is chosen; omit where screen capture is unsupported */
    onCaptureScreen?: () => void;
    /** Called when text changes */
    onChange: (value: string) => void;
    /** Called when the draw button is clicked */
    onDraw?: () => void;
    /** Prompt-history navigation, see `ComposerTiptapEditor` */
    onHistoryNavigate?: (direction: PromptHistoryDirection) => string | null;
    /** Called on paste */
    onPaste?: (event: React.ClipboardEvent) => void;
    /** Called when a chat is selected from the @ popup, to attach its text */
    onSelectChat?: (chat: ChatReference) => void;
    /** Called when "Upload new file" is selected from the @ popup */
    onSelectFileUpload?: () => void;
    /** Called when a vault file is selected from the @ popup */
    onSelectVaultFile?: (file: VaultFileRef) => void;

    /**
     * While streaming, a "Steer" button sends the text INTO the running reply,
     * which takes it at its next step. Omit where steering is not offered.
     */
    onSteer?: () => void;
    /** Called on submit (Enter without Shift) */
    onSubmit: () => void;
    /** Placeholder text */
    placeholder?: string;
    /** Ghost-text autocomplete source; omit to turn it off. See `ComposerTiptapEditor`. */
    requestCompletion?: GhostRequest;
    /** Text value */
    value: string;
}

export interface ComposerInputAreaRef {
    blur: () => void;
    focus: () => void;
    getEditor: () => ComposerTiptapEditorRef | null;
}

const ComposerInputArea = ({
    afterTextarea,
    autoFocus = true,
    bannedWordError,
    bannedWordMatches,
    beforeInput,
    canQueueWhileStreaming = false,
    compact = false,
    customVariables,
    disabled = false,
    followUp = "none",
    isStreaming = false,
    isUploading = false,
    maxRows = 5,
    onAddAttachment,
    onCancel,
    onCaptureScreen,
    currentThreadId,
    onChange,
    onDraw,
    onHistoryNavigate,
    isHistoryRecalled,
    onPaste,
    onSelectChat,
    onSelectFileUpload,
    onSelectVaultFile,
    onSteer,
    onSubmit,
    placeholder,
    ref,
    requestCompletion,
    value,
}: ComposerInputAreaProps & { ref?: React.RefObject<ComposerInputAreaRef | null> }) => {
    const { t } = useLingui();
    const tiptapRef = useRef<ComposerTiptapEditorRef>(null);

    useImperativeHandle(ref, () => {
        return {
            blur: () => tiptapRef.current?.blur(),
            focus: () => tiptapRef.current?.focus(),
            getEditor: () => tiptapRef.current,
        };
    }, []);

    const isEmpty = !value.trim();

    return (
        <>
            {/* Before input content (attachments, etc.) */}
            {beforeInput}

            <div className="flex w-full flex-row items-center justify-between gap-2">
                {/* Add attachment button */}
                {onAddAttachment && (
                    <>
                        {/* When draw or screen capture is available, fold the actions into a dropdown */}
                        {onDraw || onCaptureScreen ? (
                            <Tooltip>
                                <DropdownMenu>
                                    {/* TooltipTrigger wraps DropdownMenuTrigger — Base UI merges
                                            hover handlers from both onto the final <button> element */}
                                    <TooltipTrigger
                                        render={
                                            <DropdownMenuTrigger
                                                render={
                                                    <button
                                                        aria-label={t`Add attachment`}
                                                        className={clsx(
                                                            buttonVariants({ size: "icon", variant: "ghost" }),
                                                            "my-2 size-[34px]",
                                                            compact && "my-1.5 size-[30px]",
                                                        )}
                                                        disabled={disabled}
                                                        type="button"
                                                    >
                                                        <PlusIcon className="text-foreground size-4 dark:text-white" />
                                                    </button>
                                                }
                                            />
                                        }
                                    />
                                    <DropdownMenuContent side="top">
                                        <DropdownMenuItem onClick={onAddAttachment}>
                                            <UploadIcon />
                                            {t`Upload file`}
                                        </DropdownMenuItem>
                                        {onDraw && (
                                            <DropdownMenuItem onClick={onDraw}>
                                                <PencilIcon />
                                                {t`Draw image`}
                                            </DropdownMenuItem>
                                        )}
                                        {onCaptureScreen && (
                                            <DropdownMenuItem onClick={onCaptureScreen}>
                                                <MonitorIcon aria-hidden="true" />
                                                {t`Capture screen`}
                                            </DropdownMenuItem>
                                        )}
                                    </DropdownMenuContent>
                                </DropdownMenu>
                                <TooltipContent side="bottom">{t`Add attachment`}</TooltipContent>
                            </Tooltip>
                        ) : (
                            <Tooltip>
                                <TooltipTrigger
                                    render={
                                        <button
                                            className={clsx(
                                                buttonVariants({ size: "icon", variant: "ghost" }),
                                                "my-2 size-[34px]",
                                                compact && "my-1.5 size-[30px]",
                                            )}
                                            disabled={disabled}
                                            onClick={onAddAttachment}
                                            type="button"
                                        >
                                            <PlusIcon className="text-foreground size-4 dark:text-white" />
                                        </button>
                                    }
                                />
                                <TooltipContent side="bottom">{t`Add attachment`}</TooltipContent>
                            </Tooltip>
                        )}

                        <div className={clsx("flex self-stretch", compact ? "py-1.5" : "py-4")}>
                            <Separator className="h-full" orientation="vertical" />
                        </div>
                    </>
                )}

                {/* Tiptap editor with slash commands, @ mentions, variables, and banned word highlighting */}
                <div className={clsx("relative w-120 grow", onAddAttachment && "ml-1.5")}>
                    <ComposerTextCounter text={value} threshold={300} />
                    <ComposerTiptapEditor
                        autoFocus={autoFocus}
                        bannedWordMatches={bannedWordMatches}
                        currentThreadId={currentThreadId}
                        customVariables={customVariables}
                        disabled={disabled}
                        isHistoryRecalled={isHistoryRecalled}
                        isStreaming={isStreaming}
                        maxRows={maxRows}
                        onCancel={onCancel}
                        onChange={onChange}
                        onHistoryNavigate={onHistoryNavigate}
                        onPaste={onPaste}
                        onSelectChat={onSelectChat}
                        onSelectFileUpload={onSelectFileUpload}
                        onSelectVaultFile={onSelectVaultFile}
                        onSubmit={onSubmit}
                        placeholder={placeholder}
                        ref={tiptapRef}
                        requestCompletion={requestCompletion}
                        value={value}
                    />
                </div>

                {/* After editor content (prompt improvement button, etc.) */}
                {afterTextarea}

                {/* Right separator — only when no afterTextarea (which renders its own) */}
                {!afterTextarea && (
                    <div className={clsx("flex self-stretch", compact ? "py-1.5" : "py-2")}>
                        <Separator className="h-full" orientation="vertical" />
                    </div>
                )}

                {/* Voice input (empty) / Submit-Cancel (has text or streaming) — share one slot.
                    Voice input stays mounted with hidden prop so active recognition sessions
                    survive when transcribed text makes the input non-empty. */}
                {isStreaming ? (
                    <>
                        {onSteer && (followUp === "steer" || followUp === "steer-restart") && !isEmpty && !isUploading && (
                            <Tooltip>
                                <TooltipTrigger
                                    render={
                                        <button
                                            aria-label={followUp === "steer-restart" ? t`Interrupt and restart` : t`Steer the reply`}
                                            className={clsx(
                                                buttonVariants({ size: "icon", variant: "outline" }),
                                                "my-2 size-[34px]",
                                                compact && "my-1.5 size-[30px]",
                                            )}
                                            disabled={disabled}
                                            onClick={onSteer}
                                            type="button"
                                        >
                                            <CornerDownRightIcon aria-hidden="true" className="size-4" />
                                        </button>
                                    }
                                />
                                <TooltipContent side="bottom">
                                    {followUp === "steer-restart"
                                        ? t`Interrupt and restart — stops the current reply and sends this`
                                        : t`Steer — the current reply reads this at its next step`}
                                </TooltipContent>
                            </Tooltip>
                        )}
                        {canQueueWhileStreaming && (!isEmpty || isUploading) && (
                            <Tooltip>
                                <TooltipTrigger
                                    render={
                                        <button
                                            aria-label={isUploading ? t`Waiting for uploads to complete…` : t`Queue message`}
                                            className={clsx(
                                                buttonVariants({ size: "icon", variant: "outline" }),
                                                "my-2 size-[34px]",
                                                compact && "my-1.5 size-[30px]",
                                            )}
                                            disabled={disabled || isUploading}
                                            onClick={onSubmit}
                                            type="button"
                                        >
                                            {isUploading ? (
                                                <Loader2Icon aria-hidden="true" className="size-4 animate-spin" />
                                            ) : (
                                                <ListPlusIcon aria-hidden="true" className="size-4" />
                                            )}
                                        </button>
                                    }
                                />
                                <TooltipContent side="bottom">
                                    {isUploading ? t`Waiting for uploads to complete…` : t`Queue message — sends when the current reply finishes`}
                                </TooltipContent>
                            </Tooltip>
                        )}
                        <Tooltip>
                            <TooltipTrigger
                                render={
                                    <button
                                        aria-label={t`Stop generating`}
                                        className={clsx(
                                            buttonVariants({ size: "icon", variant: "default" }),
                                            "my-2 size-[34px]",
                                            compact && "my-1.5 size-[30px]",
                                        )}
                                        onClick={onCancel}
                                        type="button"
                                    >
                                        <Square className="size-4 animate-pulse text-white" />
                                    </button>
                                }
                            />
                            <TooltipContent side="bottom">{t`Stop generating`}</TooltipContent>
                        </Tooltip>
                    </>
                ) : (
                    <>
                        <Suspense fallback={null}>
                            <ComposerVoiceInput compact={compact} disabled={disabled} hidden={!isEmpty || isUploading} />
                        </Suspense>
                        {(!isEmpty || isUploading) && (
                            <Tooltip>
                                <TooltipTrigger
                                    render={
                                        <button
                                            aria-label={isUploading ? t`Waiting for uploads to complete…` : t`Send message`}
                                            className={clsx(
                                                buttonVariants({ size: "icon", variant: "default" }),
                                                "my-2 size-[34px]",
                                                compact && "my-1.5 size-[30px]",
                                            )}
                                            disabled={disabled || isUploading}
                                            onClick={onSubmit}
                                            type="button"
                                        >
                                            {isUploading ? <Loader2Icon className="size-4 animate-spin" /> : <SendIcon className="size-4" />}
                                        </button>
                                    }
                                />
                                <TooltipContent side="bottom">{isUploading ? t`Waiting for uploads to complete…` : t`Send message`}</TooltipContent>
                            </Tooltip>
                        )}
                    </>
                )}
            </div>

            {/* Banned word error message */}
            {bannedWordError && <div className="px-3 pb-2 text-sm text-red-600 dark:text-red-400">{bannedWordError}</div>}
        </>
    );
};

ComposerInputArea.displayName = "ComposerInputArea";

export default ComposerInputArea;
