"use client";

/**
 * ComposerTiptapEditor - Tiptap-based editor for the chat composer
 *
 * Replaces the plain textarea with a tiptap editor that provides:
 * - Slash commands (/model, /prompt, /skill) via ProseMirror plugin
 * - File @ mentions for attaching files
 * - Variable autocomplete ({{variable}}) via ProseMirror plugin
 * - Banned word highlighting via ProseMirror decorations
 * - Enter to submit, Shift+Enter for newline
 * - Opt-in ghost-text autocomplete (Right Arrow at the end of the line accepts, Esc dismisses)
 * - Bidirectional sync with the Zustand composerText store
 *
 * The editor outputs plain text (no rich formatting). It uses tiptap
 * for its extensibility (suggestions, decorations) not for rich text.
 */

import { useLingui } from "@lingui/react/macro";
import type { Editor } from "@tiptap/core";
import PlaceholderExtension from "@tiptap/extension-placeholder";
import { Selection } from "@tiptap/pm/state";
import { EditorContent, useEditor } from "@tiptap/react";
import StarterKitExtension from "@tiptap/starter-kit";
import clsx from "clsx";
import { useCallback, useEffect, useImperativeHandle, useRef, useState } from "react";

import useFavoriteModels from "@/features/chat/core/hooks/use-favorite-models";
import type { PromptHistoryDirection } from "@/features/chat/core/utils/prompt-history";
import type { PromptVariable } from "@/features/prompts/lib/prompt-variables";
import useFeatureFlaggedModels from "@/hooks/use-feature-flagged-models";

import type { BannedWordMatch } from "./extensions/banned-word-decoration";
import BannedWordDecoration from "./extensions/banned-word-decoration";
import type { FileMentionMatch } from "./extensions/file-mention";
import FileMention from "./extensions/file-mention";
import GhostCompletion from "./extensions/ghost-completion";
import PromptHistoryKeys from "./extensions/prompt-history-keys";
import type { SlashCommandMatch } from "./extensions/slash-command";
import SlashCommand from "./extensions/slash-command";
import SubmitOnEnter from "./extensions/submit-on-enter";
import type { VariableAutocompleteMatch } from "./extensions/variable-autocomplete";
import VariableAutocomplete from "./extensions/variable-autocomplete";
import type { VaultFileRef } from "./file-mention-popup";
import FileMentionPopup from "./file-mention-popup";
import type { GhostController, GhostEligibility, GhostRequest } from "./ghost-completion-controller";
import { createGhostController, shouldAnnounceGhost } from "./ghost-completion-controller";
import { plainTextToHtml } from "./plain-text";
import SlashCommandPopup from "./slash-command-popup";
import VariableAutocompletePopup from "./variable-autocomplete-popup";

// ============================================================================
// Types
// ============================================================================

export interface ComposerTiptapEditorProps {
    /** Auto focus on mount */
    autoFocus?: boolean;
    /** Banned word matches for highlighting */
    bannedWordMatches?: BannedWordMatch[];
    /** Custom variables for {{variable}} autocomplete */
    customVariables?: PromptVariable[];
    /** Whether input is disabled */
    disabled?: boolean;
    /** Whether streaming is active */
    isStreaming?: boolean;
    /** Max height in rows (approximate) */
    maxRows?: number;
    /** Called when cancel/stop is clicked */
    onCancel?: () => void;
    /** Called when text changes */
    onChange: (value: string) => void;

    /**
     * Prompt-history navigation (ArrowUp at the start / ArrowDown at the end /
     * Escape). Returns the text to show, or `null` to let the key through.
     */
    onHistoryNavigate?: (direction: PromptHistoryDirection) => string | null;
    /** Called on paste (for file and long text handling) */
    onPaste?: (e: React.ClipboardEvent) => void;
    /** Called when "Upload new file" is selected from the @ popup */
    onSelectFileUpload?: () => void;
    /** Called when a vault file is selected from the @ popup */
    onSelectVaultFile?: (file: VaultFileRef) => void;
    /** Called on submit (Enter without Shift) */
    onSubmit: () => void;
    /** Placeholder text */
    placeholder?: string;

    /**
     * Ghost-text autocomplete source. Omit to turn the feature off (the user
     * setting is off, or this composer is not a chat composer).
     */
    requestCompletion?: GhostRequest;
    /** Text value (synced from store) */
    value: string;
}

export interface ComposerTiptapEditorRef {
    blur: () => void;
    focus: () => void;
    getEditor: () => Editor | null;
}

// ============================================================================
// Constants — hoisted to avoid new references on every render
// (rerender-memo-with-default-value)
// ============================================================================

const EMPTY_BANNED_MATCHES: BannedWordMatch[] = [];
const EMPTY_VARIABLES: PromptVariable[] = [];

/** How long the "suggestion available" announcement stays in the live region. */
const ANNOUNCEMENT_CLEAR_MS = 4000;

/** The editor half of a ghost-eligibility snapshot; the rest comes from props. */
const editorGhostState = (editor: Editor, focused: boolean): Pick<GhostEligibility, "caretAtEnd" | "focused" | "text"> => {
    const { doc, selection } = editor.state;

    return {
        caretAtEnd: selection.empty && selection.head === Selection.atEnd(doc).from,
        focused,
        text: editor.getText({ blockSeparator: "\n" }),
    };
};

// ============================================================================
// Component
// ============================================================================

const ComposerTiptapEditor = ({
    autoFocus = true,
    bannedWordMatches = EMPTY_BANNED_MATCHES,
    customVariables = EMPTY_VARIABLES,
    disabled = false,
    isStreaming = false,
    maxRows = 5,
    onCancel,
    onChange,
    onHistoryNavigate,
    onPaste,
    onSelectFileUpload,
    onSelectVaultFile,
    onSubmit,
    placeholder: placeholderProp,
    ref,
    requestCompletion,
    value,
}: ComposerTiptapEditorProps & { ref?: React.RefObject<ComposerTiptapEditorRef | null> }) => {
    const { t } = useLingui();
    const placeholder = placeholderProp ?? t`Type your message...`;
    // Track whether the current text update originated from the editor
    // to avoid infinite sync loops
    const isInternalUpdate = useRef(false);
    const editorContainerRef = useRef<HTMLDivElement>(null);

    // Popup state
    const [slashMatch, setSlashMatch] = useState<SlashCommandMatch | null>(null);
    const [fileMentionMatch, setFileMentionMatch] = useState<FileMentionMatch | null>(null);
    const [variableMatch, setVariableMatch] = useState<VariableAutocompleteMatch | null>(null);
    const [editorRect, setEditorRect] = useState<DOMRect | null>(null);

    // Model data for slash commands (filtered by PostHog feature flags)
    const models = useFeatureFlaggedModels();
    const { favoriteModelIds } = useFavoriteModels();

    // Shared function to update editor rect for popup positioning
    const updateEditorRect = useCallback(() => {
        if (editorContainerRef.current) {
            setEditorRect(editorContainerRef.current.getBoundingClientRect());
        }
    }, []);

    // Slash command state change handler
    const handleSlashStateChange = useCallback(
        (match: SlashCommandMatch | null) => {
            setSlashMatch(match);

            if (match) {
                updateEditorRect();
            }
        },
        [updateEditorRect],
    );

    // File mention state change handler
    const handleFileMentionStateChange = useCallback(
        (match: FileMentionMatch | null) => {
            setFileMentionMatch(match);

            if (match) {
                updateEditorRect();
            }
        },
        [updateEditorRect],
    );

    // Variable autocomplete state change handler
    const handleVariableStateChange = useCallback(
        (match: VariableAutocompleteMatch | null) => {
            setVariableMatch(match);

            if (match) {
                updateEditorRect();
            }
        },
        [updateEditorRect],
    );

    // Keep placeholder in a ref so the Placeholder extension can read the latest value
    // without recreating the editor on every cycle.
    const placeholderRef = useRef(placeholder);

    // Create editor
    const editor = useEditor({
        autofocus: autoFocus ? "end" : false,
        editable: !disabled,
        editorProps: {
            attributes: {
                class: clsx(
                    "min-h-10 w-full resize-none border-none bg-transparent text-base outline-none",
                    "text-gray-900 dark:text-gray-100",
                    "focus:ring-0",
                ),
            },
        },
        extensions: [
            StarterKitExtension.configure({
                blockquote: false,
                // Disable rich text features - this is a plain text composer
                bold: false,
                bulletList: false,
                code: false,
                codeBlock: false,
                heading: false,
                horizontalRule: false,
                italic: false,
                listItem: false,
                orderedList: false,
                strike: false,
            }),
            // eslint-disable-next-line react-hooks/refs -- tiptap calls these options from editor events, never during render
            PlaceholderExtension.configure({
                emptyEditorClass: "is-editor-empty",
                // Function form so the extension always reads the latest ref value
                // without the editor being recreated.
                placeholder: () => placeholderRef.current ?? "",
            }),
            // Before SubmitOnEnter: Escape restores a recalled prompt's draft first.
            PromptHistoryKeys,
            SubmitOnEnter.configure({
                isStreaming: () => isStreaming,
                onCancel,
                onSubmit: () => {
                    // Initial handler - will be kept in sync via useEffect
                    onSubmit();
                },
            }),
            BannedWordDecoration,
            // eslint-disable-next-line react-hooks/refs -- tiptap calls these options from editor events, never during render
            SlashCommand.configure({
                onStateChange: handleSlashStateChange,
            }),
            // eslint-disable-next-line react-hooks/refs -- tiptap calls these options from editor events, never during render
            FileMention.configure({
                onStateChange: handleFileMentionStateChange,
            }),
            // eslint-disable-next-line react-hooks/refs -- tiptap calls these options from editor events, never during render
            VariableAutocomplete.configure({
                onStateChange: handleVariableStateChange,
            }),
            // Inert until `requestCompletion` is set: it only draws what it is handed.
            GhostCompletion,
        ],
        immediatelyRender: false,
        onUpdate: ({ editor: ed }) => {
            isInternalUpdate.current = true;
            const text = ed.getText({ blockSeparator: "\n" });

            onChange(text);
            // Reset flag after microtask
            queueMicrotask(() => {
                isInternalUpdate.current = false;
            });
        },
    });

    // Sync placeholder ref + trigger a decoration re-render (with a brief fade) when placeholder changes.
    useEffect(() => {
        if (!editor) {
            return undefined;
        }

        const container = editorContainerRef.current;

        if (container) {
            container.classList.add("placeholder-changing");
            const timer = setTimeout(() => {
                placeholderRef.current = placeholder;
                editor.view.dispatch(editor.state.tr);
                container.classList.remove("placeholder-changing");
            }, 180);

            return () => clearTimeout(timer);
        }

        placeholderRef.current = placeholder;
        editor.view.dispatch(editor.state.tr);

        return undefined;
    }, [placeholder, editor]);

    // Expose ref methods
    useImperativeHandle(ref, () => {
        return {
            blur: () => editor?.commands.blur(),
            focus: () => editor?.commands.focus(),
            getEditor: () => editor,
        };
    }, [editor]);

    // Sync external text changes to editor (store → tiptap)
    useEffect(() => {
        if (!editor || isInternalUpdate.current) {
            return;
        }

        const currentText = editor.getText({ blockSeparator: "\n" });

        if (currentText !== value) {
            // Convert plain text to paragraphs
            if (value) {
                editor.commands.setContent(plainTextToHtml(value), { emitUpdate: false });
            } else {
                editor.commands.clearContent();
            }
        }
    }, [value, editor]);

    // Update editable state
    useEffect(() => {
        if (editor) {
            editor.setEditable(!disabled);
        }
    }, [disabled, editor]);

    // Update banned word decorations when matches change
    useEffect(() => {
        if (!editor) {
            return;
        }

        // Dispatched as plugin state rather than mutated onto the extension's
        // options: the old form reached into `extensionManager`, wrote a field
        // the plugin no longer reads, and then forced a rebuild with a no-op
        // transaction to make it take effect.
        editor.commands.setBannedWordMatches(bannedWordMatches);
    }, [bannedWordMatches, editor]);

    // Update submit/cancel handlers - guard against submitting when a popup is open
    useEffect(() => {
        if (!editor) {
            return;
        }

        for (const extension of editor.extensionManager.extensions) {
            if (extension.name === "promptHistoryKeys") {
                // eslint-disable-next-line react-hooks/immutability -- tiptap reads extension options at event time; reassigning them is its documented way to swap a handler without recreating the editor
                extension.options.onNavigate = (direction: PromptHistoryDirection) => {
                    if (slashMatch || fileMentionMatch || variableMatch || !onHistoryNavigate) {
                        return null;
                    }

                    return onHistoryNavigate(direction);
                };
            }

            if (extension.name !== "submitOnEnter") {
                continue;
            }

            extension.options.onSubmit = () => {
                if (slashMatch || fileMentionMatch || variableMatch) {
                    return;
                }

                onSubmit();
            };
            extension.options.onCancel = onCancel;
            extension.options.isStreaming = () => isStreaming;
        }
    }, [onSubmit, onCancel, onHistoryNavigate, isStreaming, slashMatch, fileMentionMatch, variableMatch, editor]);

    // ---- Ghost-text autocomplete -------------------------------------------
    const [ghostAnnouncement, setGhostAnnouncement] = useState("");
    const ghostControllerRef = useRef<GhostController | null>(null);
    const ghostPropsRef = useRef({ disabled, isStreaming, popupOpen: false });
    const requestCompletionRef = useRef(requestCompletion);
    const lastAnnouncedAtRef = useRef<number | null>(null);
    const hasCompletionSource = Boolean(requestCompletion);
    const isPopupOpen = Boolean(slashMatch || fileMentionMatch || variableMatch);
    const ghostAnnouncementText = t`Suggestion available, press Right Arrow to accept`;

    useEffect(() => {
        requestCompletionRef.current = requestCompletion;
    }, [requestCompletion]);

    useEffect(() => {
        if (!editor || !hasCompletionSource) {
            return undefined;
        }

        let clearAnnouncement: ReturnType<typeof setTimeout> | undefined;

        const controller = createGhostController({
            getText: () => editor.getText({ blockSeparator: "\n" }),
            onSuggestion: (suggestion) => {
                if (editor.isDestroyed) {
                    return;
                }

                editor.commands.setGhostCompletion(suggestion);

                const now = Date.now();

                if (suggestion !== null && shouldAnnounceGhost(lastAnnouncedAtRef.current, now)) {
                    lastAnnouncedAtRef.current = now;
                    setGhostAnnouncement(ghostAnnouncementText);
                    clearTimeout(clearAnnouncement);
                    clearAnnouncement = setTimeout(setGhostAnnouncement, ANNOUNCEMENT_CLEAR_MS, "");
                }
            },
            request: async (text, signal) => (await requestCompletionRef.current?.(text, signal)) ?? null,
        });

        const report = (focused: boolean) => {
            controller.update({ ...ghostPropsRef.current, ...editorGhostState(editor, focused) });
        };
        const onEditorChange = () => report(editor.isFocused);
        const onFocus = () => report(true);
        const onBlur = () => report(false);

        ghostControllerRef.current = controller;
        editor.on("update", onEditorChange);
        editor.on("selectionUpdate", onEditorChange);
        editor.on("focus", onFocus);
        editor.on("blur", onBlur);

        return () => {
            editor.off("update", onEditorChange);
            editor.off("selectionUpdate", onEditorChange);
            editor.off("focus", onFocus);
            editor.off("blur", onBlur);
            controller.dispose();
            clearTimeout(clearAnnouncement);
            ghostControllerRef.current = null;

            if (!editor.isDestroyed) {
                editor.commands.setGhostCompletion(null);
            }
        };
    }, [editor, hasCompletionSource, ghostAnnouncementText]);

    // Streaming, disabling or a popup opening clears the ghost and cancels what is pending.
    useEffect(() => {
        ghostPropsRef.current = { disabled, isStreaming, popupOpen: isPopupOpen };

        if (editor && ghostControllerRef.current) {
            ghostControllerRef.current.update({ ...ghostPropsRef.current, ...editorGhostState(editor, editor.isFocused) });
        }
    }, [disabled, isStreaming, isPopupOpen, editor]);

    // Handle replace for slash commands, file mentions, and variables
    const handleReplace = useCallback(
        (from: number, to: number, replacement: string) => {
            if (!editor) {
                return;
            }

            editor.chain().focus().deleteRange({ from, to }).insertContent(replacement).run();
        },
        [editor],
    );

    // Dismiss popups
    const handleDismissSlash = useCallback(() => {
        setSlashMatch(null);
        editor?.commands.focus();
    }, [editor]);

    const handleDismissFileMention = useCallback(() => {
        setFileMentionMatch(null);
        editor?.commands.focus();
    }, [editor]);

    const handleDismissVariable = useCallback(() => {
        setVariableMatch(null);
        editor?.commands.focus();
    }, [editor]);

    // Max height calculation
    const lineHeight = 24;
    const maxHeight = lineHeight * maxRows;

    return (
        <div className="relative w-full" onPaste={onPaste} ref={editorContainerRef}>
            <div className="w-full overflow-y-auto" style={{ maxHeight: `${maxHeight}px` }}>
                <EditorContent
                    className={clsx(
                        "[&_.tiptap]:min-h-10 [&_.tiptap]:w-full [&_.tiptap]:border-none [&_.tiptap]:bg-transparent [&_.tiptap]:py-2.5 [&_.tiptap]:text-base [&_.tiptap]:outline-none",
                        "[&_.tiptap]:text-gray-900 dark:[&_.tiptap]:text-gray-100",
                        "[&_.tiptap_p]:m-0",
                        "[&_.tiptap.is-editor-empty_.is-empty]:before:pointer-events-none [&_.tiptap.is-editor-empty_.is-empty]:before:float-left [&_.tiptap.is-editor-empty_.is-empty]:before:h-0 [&_.tiptap.is-editor-empty_.is-empty]:before:text-gray-500 [&_.tiptap.is-editor-empty_.is-empty]:before:content-[attr(data-placeholder)]",
                        disabled && "cursor-not-allowed opacity-50",
                    )}
                    editor={editor}
                />
            </div>

            {/* The ghost itself is aria-hidden; this says once in a while that Right Arrow would accept one. */}
            {hasCompletionSource && (
                <span aria-live="polite" className="sr-only" role="status">
                    {ghostAnnouncement}
                </span>
            )}

            {/* Slash command popup */}
            <SlashCommandPopup
                editorRect={editorRect}
                favoriteModelIds={favoriteModelIds}
                match={slashMatch}
                models={models}
                onDismiss={handleDismissSlash}
                onReplace={handleReplace}
            />

            {/* File mention popup */}
            <FileMentionPopup
                editorRect={editorRect}
                match={fileMentionMatch}
                onDismiss={handleDismissFileMention}
                onReplace={handleReplace}
                onSelectFileUpload={onSelectFileUpload}
                onSelectVaultFile={onSelectVaultFile}
            />

            {/* Variable autocomplete popup */}
            <VariableAutocompletePopup
                customVariables={customVariables}
                editorRect={editorRect}
                match={variableMatch}
                onDismiss={handleDismissVariable}
                onReplace={handleReplace}
            />
        </div>
    );
};

ComposerTiptapEditor.displayName = "ComposerTiptapEditor";

export { ComposerTiptapEditor };
