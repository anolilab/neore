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
import type { EditorState } from "@tiptap/pm/state";
import { Selection } from "@tiptap/pm/state";
import { EditorContent, useEditor } from "@tiptap/react";
import StarterKitExtension from "@tiptap/starter-kit";
import clsx from "clsx";
import { useCallback, useEffect, useImperativeHandle, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";

import { useUserSettings } from "@/features/auth/hooks/use-user-settings";
import useFavoriteModels from "@/features/chat/core/hooks/use-favorite-models";
import { composerDraftFrom, markComposerDraft } from "@/features/chat/core/utils/draft-origin";
import type { PromptHistoryDirection } from "@/features/chat/core/utils/prompt-history";
import type { PromptVariable } from "@/features/prompts/lib/prompt-variables";
import useFeatureFlaggedModels from "@/hooks/use-feature-flagged-models";
import { LOAD_MARKS, useLoadMark } from "@/lib/analytics/load-marks";

import type { ChatReference } from "../chat-reference";
import { cleanEditorText } from "./clean-editor-text";
import { readComposerText } from "./composer-text";
import { composerEditorAttributes } from "./editor-attributes";
import EmojiShortcodePopup from "./emoji-shortcode-popup";
import type { BannedWordMatch } from "./extensions/banned-word-decoration";
import BannedWordDecoration from "./extensions/banned-word-decoration";
import type { EmojiShortcodeMatch } from "./extensions/emoji-shortcode";
import EmojiShortcode from "./extensions/emoji-shortcode";
import type { FileMentionMatch } from "./extensions/file-mention";
import FileMention from "./extensions/file-mention";
import GhostCompletion, { getGhostCompletion } from "./extensions/ghost-completion";
import PromptHistoryKeys from "./extensions/prompt-history-keys";
import QuoteChip, { refreshQuoteChipLabels } from "./extensions/quote-chip";
import type { SlashCommandMatch } from "./extensions/slash-command";
import SlashCommand from "./extensions/slash-command";
import SubmitOnEnter from "./extensions/submit-on-enter";
import type { VariableAutocompleteMatch } from "./extensions/variable-autocomplete";
import VariableAutocomplete from "./extensions/variable-autocomplete";
import VimMode, { refreshVimMode } from "./extensions/vim-mode";
import type { VaultFileRef } from "./file-mention-popup";
import FileMentionPopup from "./file-mention-popup";
import type { GhostController, GhostEligibility, GhostRequest } from "./ghost-completion-controller";
import { createGhostController, shouldAnnounceGhost } from "./ghost-completion-controller";
import { appendPlainText, composerCoreExtensionOptions, pastePlainText } from "./paste-plain-text";
import { plainTextToHtml } from "./plain-text";
import SlashCommandPopup from "./slash-command-popup";
import { useEmojiShortcode } from "./use-emoji-shortcode";
import useMentionPrefetch from "./use-mention-prefetch";
import VariableAutocompletePopup from "./variable-autocomplete-popup";
import type { VimMode as VimModeName } from "./vim-keys";
import { WrapSelection } from "./wrap-selection";

// ============================================================================
// Types
// ============================================================================

export interface ComposerTiptapEditorProps {
    /** Auto focus on mount */
    autoFocus?: boolean;
    /** Banned word matches for highlighting */
    bannedWordMatches?: BannedWordMatch[];
    /** The chat being typed into; the @ popup does not offer it as a reference */
    currentThreadId?: string;
    /** Custom variables for {{variable}} autocomplete */
    customVariables?: PromptVariable[];
    /** Id of the element that describes the field (aria-describedby) */
    describedBy?: string;
    /** Whether input is disabled */
    disabled?: boolean;
    /** Marks the field aria-invalid */
    invalid?: boolean;
    /** Whether a recalled prompt is showing; insert-mode Escape then restores the draft instead of leaving insert mode. */
    isHistoryRecalled?: () => boolean;
    /** Whether streaming is active */
    isStreaming?: boolean;
    /** Max height in rows (approximate) */
    maxRows?: number;

    /** The chat the suggestion belongs to: the same text in another chat is placed again. */
    nextPromptScope?: string | null;

    /**
     * The suggested next prompt after a reply, shown as ghost text in an empty composer: Tab inserts it, Escape or typing
     * dismisses it. Set once per reply; `null` clears it.
     */
    nextPromptSuggestion?: string | null;

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
    /** Called when a chat is selected from the @ popup, to attach its text */
    onSelectChat?: (chat: ChatReference) => void;
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

    /**
     * Slash commands, @ mentions and {{variable}} suggestions. They read the
     * signed-in user's prompts, skills, files and chats, so a composer shown to
     * a signed-out visitor turns them off. Default on.
     */
    suggestions?: boolean;
    /** Text value (synced from store) */
    value: string;
}

export interface ComposerTiptapEditorRef {
    /** `text` typed at the document's end, the blocks before it untouched; false when the editor cannot take it. */
    appendText: (text: string) => boolean;
    blur: () => void;
    focus: () => void;
    getEditor: () => Editor | null;
    /** Whether `event` is a paste made with Ctrl/Cmd+Shift+V, which keeps the text exactly as copied. */
    isPlainPaste: (event: { timeStamp: number }) => boolean;
    /** Inserts `text` over the selection (of `at` when given) as one undoable paste, a paragraph per line; false without an editor or when the text changed since `at`. */
    pasteText: (text: string, at?: EditorState) => boolean;
}

// ============================================================================
// Constants — hoisted to avoid new references on every render
// (rerender-memo-with-default-value)
// ============================================================================

const EMPTY_BANNED_MATCHES: BannedWordMatch[] = [];
const EMPTY_VARIABLES: PromptVariable[] = [];

/** A paste this soon after Ctrl/Cmd+Shift+V came from it: the paste event itself does not say. */
const PLAIN_PASTE_WINDOW_MS = 1000;

/** How long the "suggestion available" announcement stays in the live region. */
const ANNOUNCEMENT_CLEAR_MS = 4000;

/** The editor half of a ghost-eligibility snapshot; the rest comes from props. */
const editorGhostState = (editor: Editor, focused: boolean): Pick<GhostEligibility, "caretAtEnd" | "focused" | "text"> => {
    const { doc, selection } = editor.state;

    return {
        caretAtEnd: selection.empty && selection.head === Selection.atEnd(doc).from,
        focused,
        text: readComposerText(editor),
    };
};

// ============================================================================
// Component
// ============================================================================

const ComposerTiptapEditor = ({
    autoFocus = true,
    currentThreadId,
    bannedWordMatches = EMPTY_BANNED_MATCHES,
    customVariables = EMPTY_VARIABLES,
    describedBy,
    disabled = false,
    invalid = false,
    isStreaming = false,
    maxRows = 5,
    onCancel,
    onChange,
    onHistoryNavigate,
    isHistoryRecalled,
    onPaste,
    onSelectChat,
    onSelectFileUpload,
    onSelectVaultFile,
    onSubmit,
    placeholder: placeholderProp,
    nextPromptScope = null,
    nextPromptSuggestion = null,
    ref,
    requestCompletion,
    suggestions = true,
    value,
}: ComposerTiptapEditorProps & { ref?: React.RefObject<ComposerTiptapEditorRef | null> }) => {
    const { t } = useLingui();
    const placeholder = placeholderProp ?? t`Type your message...`;
    // Track whether the current text update originated from the editor
    // to avoid infinite sync loops
    const isInternalUpdate = useRef(false);
    const editorContainerRef = useRef<HTMLDivElement>(null);

    // Popup state
    const [slashMatchState, setSlashMatch] = useState<SlashCommandMatch | null>(null);
    // Whether the slash menu shows: a slash with nothing to list shows nothing, so it must not hold the emoji list back.
    const [slashOpen, setSlashOpen] = useState(false);
    const [fileMentionMatchState, setFileMentionMatch] = useState<FileMentionMatch | null>(null);
    const [variableMatchState, setVariableMatch] = useState<VariableAutocompleteMatch | null>(null);
    const [emojiMatchState, setEmojiMatch] = useState<EmojiShortcodeMatch | null>(null);
    // With suggestions off nothing opens, so Enter still sends "/like this".
    const slashMatch = suggestions ? slashMatchState : null;
    const fileMentionMatch = suggestions ? fileMentionMatchState : null;
    const variableMatch = suggestions ? variableMatchState : null;
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

    // Opt-in Vim keys (`userSettings.composerVimMode`; `getUserSettings` is already a first-paint query).
    const { data: userSettings } = useUserSettings();
    const isVimEnabled = userSettings?.composerVimMode === true;
    const vimEnabledRef = useRef(isVimEnabled);
    const historyRecalledRef = useRef(isHistoryRecalled);
    const [vimMode, setVimMode] = useState<VimModeName>("insert");

    useEffect(() => {
        vimEnabledRef.current = isVimEnabled;
        historyRecalledRef.current = isHistoryRecalled;
    }, [isVimEnabled, isHistoryRecalled]);

    const plainPasteKeyAt = useRef(-Infinity);

    // The key handlers the extensions call. Tiptap's `extension.options` is a getter that returns a fresh object, and
    // shortcuts read the options captured when the editor was built, so a handler assigned onto it later is lost; the
    // extensions read this ref at key time instead. No popup check here: an open popup (one with items) takes Enter, the
    // arrows and Escape on `window` in the capture phase, and a match without items must still let Enter send.
    const keyHandlersRef = useRef({ isStreaming, onCancel, onHistoryNavigate, onSubmit });

    useLayoutEffect(() => {
        keyHandlersRef.current = { isStreaming, onCancel, onHistoryNavigate, onSubmit };
    }, [isStreaming, onCancel, onHistoryNavigate, onSubmit]);

    // Create editor
    const editor = useEditor({
        autofocus: autoFocus ? "end" : false,
        coreExtensionOptions: composerCoreExtensionOptions,
        editable: !disabled,
        editorProps: {
            attributes: composerEditorAttributes({ describedBy, invalid, label: t`Message` }),
            // The composer's paste handler runs first (capture phase) and prevents a paste it turns into a file; the editor
            // then leaves that paste alone, so a long text is never both attached and inserted.
            handlePaste: (_view, event) => event.defaultPrevented,
            handleKeyDown: (_view, event) => {
                // `code` is the physical key: on a Cyrillic or Greek layout `key` is not "v" for the same shortcut.
                if (event.shiftKey && (event.ctrlKey || event.metaKey) && (event.code === "KeyV" || event.key.toLowerCase() === "v")) {
                    plainPasteKeyAt.current = event.timeStamp;
                }

                return false;
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
            // eslint-disable-next-line react-hooks/refs -- tiptap calls these options from editor events, never during render
            PromptHistoryKeys.configure({
                onNavigate: (direction: PromptHistoryDirection) => keyHandlersRef.current.onHistoryNavigate?.(direction) ?? null,
            }),
            // eslint-disable-next-line react-hooks/refs -- tiptap calls these options from editor events, never during render
            SubmitOnEnter.configure({
                // Escape cancels only with a cancel handler to call; otherwise it falls through.
                isStreaming: () => keyHandlersRef.current.isStreaming && keyHandlersRef.current.onCancel !== undefined,
                onCancel: () => keyHandlersRef.current.onCancel?.(),
                onSubmit: () => keyHandlersRef.current.onSubmit(),
            }),
            BannedWordDecoration,
            QuoteChip.configure({
                labels: () => {
                    return { goToReply: t`Go to reply` };
                },
            }),
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
            EmojiShortcode.configure({
                onStateChange: setEmojiMatch,
            }),
            // Inert until `requestCompletion` is set: it only draws what it is handed.
            // An accepted completion is the model's text: the draft is marked like a clicked suggestion, unless it already holds a mark.
            GhostCompletion.configure({ onAccept: () => composerDraftFrom() ?? markComposerDraft("suggestion") }),
            // eslint-disable-next-line react-hooks/refs -- tiptap calls these options from editor events, never during render
            VimMode.configure({
                isEnabled: () => vimEnabledRef.current,
                isHistoryRecalled: () => historyRecalledRef.current?.() ?? false,
                onModeChange: setVimMode,
            }),
            // After VimMode: vim's normal mode takes typed text, and that must win over a wrap (`wrap-selection.ts`).
            WrapSelection,
        ],
        immediatelyRender: false,
        onUpdate: ({ editor: ed }) => {
            isInternalUpdate.current = true;
            // Reads the raw text (the store counts what it removes), then cleans the document itself.
            const text = readComposerText(ed);

            cleanEditorText(ed);
            onChange(text);
            // Reset flag after microtask
            queueMicrotask(() => {
                isInternalUpdate.current = false;
            });
        },
    });

    // The "@" and "/" menus' data, loaded on the first edit that leaves text in the composer, so they open with it.
    const suggestionsWarm = useMentionPrefetch(editor, suggestions);

    // Real-user load timing: the composer counts as visible once its editor exists (`lib/analytics/load-marks.ts`).
    useLoadMark(LOAD_MARKS.composerVisible, editor !== null);

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

                if (editor.isEmpty) {
                    editor.view.dispatch(editor.state.tr);
                }

                container.classList.remove("placeholder-changing");
            }, 180);

            return () => clearTimeout(timer);
        }

        placeholderRef.current = placeholder;

        if (editor.isEmpty) {
            editor.view.dispatch(editor.state.tr);
        }

        return undefined;
    }, [placeholder, editor]);

    // Expose ref methods
    useImperativeHandle(ref, () => {
        return {
            blur: () => editor?.commands.blur(),
            focus: () => editor?.commands.focus(),
            getEditor: () => editor,
            // One shortcut, one paste: a normal paste right after it keeps its formatting.
            isPlainPaste: (event: { timeStamp: number }) => {
                const plain = event.timeStamp - plainPasteKeyAt.current < PLAIN_PASTE_WINDOW_MS;

                plainPasteKeyAt.current = -Infinity;

                return plain;
            },
            appendText: (text: string) => (editor && !editor.isDestroyed ? appendPlainText(editor, text) : false),
            pasteText: (text: string, at?: EditorState) => (editor && !editor.isDestroyed ? pastePlainText(editor, text, at) : false),
        };
    }, [editor]);

    // Sync external text changes to editor (store → tiptap)
    useEffect(() => {
        if (!editor || isInternalUpdate.current) {
            return;
        }

        const currentText = readComposerText(editor);

        if (currentText !== value) {
            // Convert plain text to paragraphs
            if (value) {
                editor.commands.setContent(plainTextToHtml(value), { emitUpdate: false });
            } else {
                editor.commands.clearContent();
                // A prompt sent from normal mode must not leave the next one in normal mode, where typed letters are commands.
                refreshVimMode(editor.view);
            }
        }
    }, [value, editor]);

    // Update editable state
    useEffect(() => {
        if (editor) {
            editor.setEditable(!disabled);
        }
    }, [disabled, editor]);

    // Turning Vim on or off while the editor is open: the caret class and the mode label follow at once, not at the next keystroke.
    useEffect(() => {
        if (editor && !editor.isDestroyed) {
            refreshVimMode(editor.view);
        }
    }, [isVimEnabled, editor]);

    // A locale switch changes the labels of the quote chips already drawn; the editor itself is not recreated for it. The
    // switch re-renders the composer, so the chips are repainted after each render. That is one small query, and a repaint
    // only writes a label that changed.
    useEffect(() => {
        if (editor && !editor.isDestroyed) {
            refreshQuoteChipLabels(editor.view.dom);
        }
    });

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

    // Replace for slash commands, file mentions, variables and emoji shortcodes
    const handleReplace = useCallback(
        (from: number, to: number, replacement: string) => {
            if (!editor) {
                return;
            }

            editor.chain().focus().deleteRange({ from, to }).insertContent(replacement).run();
        },
        [editor],
    );

    // Focus decides whether the `:shortcode` list is the composer's: keys typed in another field are not its to take. Read
    // from the editor rather than tracked by an effect, so the state is right when the editor autofocuses on mount.
    const subscribeEmojiFocus = useCallback(
        (notify: () => void): (() => void) => {
            if (!editor) {
                return () => {};
            }

            editor.on("focus", notify);
            editor.on("blur", notify);

            return () => {
                editor.off("focus", notify);
                editor.off("blur", notify);
            };
        },
        [editor],
    );
    const emojiEditorFocused = useSyncExternalStore(
        subscribeEmojiFocus,
        () => editor?.isFocused ?? false,
        () => false,
    );

    // The `:shortcode` list. It waits while another popup is open, since each takes the keys while it shows, while the
    // composer is disabled, and in Vim normal mode, where Enter and Escape are the Vim keys.
    const emoji = useEmojiShortcode({
        enabled: suggestions && !disabled && vimMode !== "normal" && !slashOpen && !fileMentionMatch && !variableMatch,
        focused: emojiEditorFocused,
        match: emojiMatchState,
        onReplace: handleReplace,
    });
    const emojiOpen = emoji.open;
    const emojiListboxId = emoji.listboxId;
    const emojiActiveOptionId = emoji.activeOptionId;

    // The list is fixed to the composer's box as measured when it opened: re-measure while it is open, so scrolling or
    // resizing does not leave it behind.
    useEffect(() => {
        if (!emojiOpen) {
            return undefined;
        }

        let frame: number | undefined;

        // At most one measurement a frame, and none of the state update when the box has not moved: a scroll of the message
        // list must not re-render the whole composer.
        const remeasure = () => {
            frame = undefined;

            const container = editorContainerRef.current;

            if (!container) {
                return;
            }

            const rect = container.getBoundingClientRect();

            setEditorRect((previous) => {
                const moved =
                    !previous || previous.left !== rect.left || previous.top !== rect.top || previous.width !== rect.width || previous.height !== rect.height;

                return moved ? rect : previous;
            });
        };
        const schedule = () => {
            frame ??= requestAnimationFrame(remeasure);
        };

        // Measured as the list opens too: it may reopen after the composer moved while the list was closed.
        schedule();
        globalThis.addEventListener("scroll", schedule, { capture: true, passive: true });
        globalThis.addEventListener("resize", schedule);

        // A long shortcode that wraps grows the composer upward, with no scroll or resize: its own size change re-measures it.
        const observer = new ResizeObserver(schedule);

        if (editorContainerRef.current) {
            observer.observe(editorContainerRef.current);
        }

        return () => {
            if (frame !== undefined) {
                cancelAnimationFrame(frame);
            }

            observer.disconnect();
            globalThis.removeEventListener("scroll", schedule, { capture: true });
            globalThis.removeEventListener("resize", schedule);
        };
    }, [emojiOpen]);

    // The editor reads its attributes once, at creation: push a changed description, validity or open list to the live element.
    useEffect(() => {
        if (editor && !editor.isDestroyed) {
            editor.setOptions({
                editorProps: {
                    ...editor.options.editorProps,
                    attributes: composerEditorAttributes({
                        describedBy,
                        invalid,
                        label: t`Message`,
                        popup: emojiOpen ? { activeOptionId: emojiActiveOptionId, listboxId: emojiListboxId } : undefined,
                    }),
                },
            });
        }
    }, [editor, describedBy, invalid, t, emojiOpen, emojiActiveOptionId, emojiListboxId]);

    // ---- Ghost-text autocomplete -------------------------------------------
    const [ghostAnnouncement, setGhostAnnouncement] = useState("");
    const ghostControllerRef = useRef<GhostController | null>(null);
    const ghostPropsRef = useRef({ disabled, isStreaming, popupOpen: false });
    const requestCompletionRef = useRef(requestCompletion);
    const lastAnnouncedAtRef = useRef<number | null>(null);
    // The prompt last placed, by chat and text: the same text for another chat is said again.
    // `dismissed` is set only when the person removes the prompt (typing or Escape): a pause hides it without dismissing it.
    const lastPlacedPromptRef = useRef<{ dismissed: boolean; scope: string | null; text: string } | null>(null);
    const hasCompletionSource = Boolean(requestCompletion);
    // A shortcode being typed counts as a popup, open or not yet, so the ghost does not finish it while it is typed. A bare
    // colon, or the colon that closes a finished `:dog:`, has an empty query and is not typing one.
    const emojiTyping = suggestions && emojiMatchState !== null && emojiMatchState.query !== "";
    const isPopupOpen = Boolean(slashMatch || fileMentionMatch || variableMatch || emojiOpen || emojiTyping);
    const ghostAnnouncementText = t`Suggestion available, press Right Arrow to accept`;

    useEffect(() => {
        requestCompletionRef.current = requestCompletion;
    }, [requestCompletion]);

    // The suggested next prompt is its own ghost source: the as-you-type controller clears what it does not own (on focus,
    // for instance). It is placed when the suggestion arrives, once: typing dismisses it, and clearing the draft does not
    // bring it back, because this runs only when the suggestion changes.
    const promptAnnouncementText = nextPromptSuggestion ? t`Suggested next prompt: ${nextPromptSuggestion}. Press Tab to insert.` : "";

    useEffect(() => {
        if (!editor || editor.isDestroyed) {
            return undefined;
        }

        // A disabled composer holds no prompt, because Tab would otherwise insert it into a draft that cannot be edited.
        if (!nextPromptSuggestion || disabled || readComposerText(editor) !== "") {
            editor.commands.setSuggestedPrompt(null);
            // The cleanup below cancels this suggestion's clear timer, so its line is cleared here instead of being left in the live region.
            setGhostAnnouncement("");

            // A reply without a suggestion starts over. A pause or a draft does not: a prompt dismissed in this reply stays dismissed.
            if (!nextPromptSuggestion) {
                lastPlacedPromptRef.current = null;
            }

            return undefined;
        }

        // Placed once per reply: a dismissal (typing or Escape) is not undone by a pause or a cleared draft.
        if (
            lastPlacedPromptRef.current?.dismissed &&
            lastPlacedPromptRef.current.scope === nextPromptScope &&
            lastPlacedPromptRef.current.text === nextPromptSuggestion
        ) {
            return undefined;
        }

        editor.commands.setSuggestedPrompt(nextPromptSuggestion);

        // The same text for another chat is already what the live region holds, so it would not be said again: it is cleared, and said
        // in a later task.
        const sameTextForAnotherChat = lastPlacedPromptRef.current?.text === nextPromptSuggestion && lastPlacedPromptRef.current.scope !== nextPromptScope;

        lastPlacedPromptRef.current = { dismissed: false, scope: nextPromptScope, text: nextPromptSuggestion };

        let restoreAnnouncement: ReturnType<typeof setTimeout> | undefined;

        if (sameTextForAnotherChat) {
            setGhostAnnouncement("");
            restoreAnnouncement = setTimeout(setGhostAnnouncement, 0, promptAnnouncementText);
        } else {
            setGhostAnnouncement(promptAnnouncementText);
        }

        const clearAnnouncement = setTimeout(setGhostAnnouncement, ANNOUNCEMENT_CLEAR_MS, "");

        // Typing or Escape removes the prompt, and its line goes with it rather than when the timer runs out. The placement above
        // is not seen: this listener is added after it.
        const onTransaction = () => {
            if (getGhostCompletion(editor.state)?.kind === "prompt") {
                return;
            }

            // The person removed it (typing or Escape): it is dismissed for this reply, so a pause does not bring it back.
            if (lastPlacedPromptRef.current) {
                lastPlacedPromptRef.current.dismissed = true;
            }

            editor.off("transaction", onTransaction);
            clearTimeout(clearAnnouncement);
            clearTimeout(restoreAnnouncement);
            setGhostAnnouncement("");
        };

        editor.on("transaction", onTransaction);

        return () => {
            editor.off("transaction", onTransaction);
            clearTimeout(clearAnnouncement);
            clearTimeout(restoreAnnouncement);
        };
    }, [disabled, editor, nextPromptScope, nextPromptSuggestion, promptAnnouncementText]);

    useEffect(() => {
        if (!editor || !hasCompletionSource) {
            return undefined;
        }

        let clearAnnouncement: ReturnType<typeof setTimeout> | undefined;

        const controller = createGhostController({
            getText: () => readComposerText(editor),
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

    // The editor's text now, for a `/clear` that finished while the person may have kept typing. A destroyed editor (the
    // chat changed) reads as empty, which no command matches.
    const readDraft = useCallback(() => (editor && !editor.isDestroyed ? editor.getText() : ""), [editor]);

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
        <div className="relative w-full" onPasteCapture={onPaste} ref={editorContainerRef}>
            <div className="w-full overflow-y-auto" style={{ maxHeight: `${maxHeight}px` }}>
                <EditorContent
                    className={clsx(
                        "[&_.tiptap]:min-h-10 [&_.tiptap]:w-full [&_.tiptap]:border-none [&_.tiptap]:bg-transparent [&_.tiptap]:py-2.5 [&_.tiptap]:text-base [&_.tiptap]:outline-none",
                        "[&_.tiptap]:text-gray-900 dark:[&_.tiptap]:text-gray-100",
                        "[&_.tiptap_p]:m-0",
                        // Vim normal mode: a block cursor on the character the next command acts on, instead of the caret.
                        "[&_.vim-cursor]:bg-primary/50 [&_.tiptap.vim-normal]:caret-transparent",
                        "[&_.tiptap.is-editor-empty_.is-empty]:before:pointer-events-none [&_.tiptap.is-editor-empty_.is-empty]:before:float-left [&_.tiptap.is-editor-empty_.is-empty]:before:h-0 [&_.tiptap.is-editor-empty_.is-empty]:before:text-gray-500 [&_.tiptap.is-editor-empty_.is-empty]:before:content-[attr(data-placeholder)]",
                        disabled && "cursor-not-allowed opacity-50",
                    )}
                    editor={editor}
                />
            </div>

            {isVimEnabled && (
                <span aria-live="polite" className="text-muted-foreground pointer-events-none absolute right-1 bottom-0 font-mono text-[10px]" role="status">
                    {vimMode === "normal" ? t`-- NORMAL --` : t`-- INSERT --`}
                </span>
            )}

            {/* The ghost itself is aria-hidden; this says once in a while that a ghost is there to accept. */}
            {(hasCompletionSource || Boolean(nextPromptSuggestion)) && (
                <span aria-live="polite" className="sr-only" role="status">
                    {ghostAnnouncement}
                </span>
            )}

            {/* Slash command popup */}
            <SlashCommandPopup
                currentThreadId={currentThreadId}
                editorRect={editorRect}
                favoriteModelIds={favoriteModelIds}
                match={slashMatch}
                models={models}
                onDismiss={handleDismissSlash}
                onOpenChange={setSlashOpen}
                onReplace={handleReplace}
                readDraft={readDraft}
                warm={suggestionsWarm}
            />

            {/* File mention popup */}
            <FileMentionPopup
                currentThreadId={currentThreadId}
                editorRect={editorRect}
                match={fileMentionMatch}
                onDismiss={handleDismissFileMention}
                onReplace={handleReplace}
                onSelectChat={onSelectChat}
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

            {/* Emoji shortcode list. The announcement is always mounted, so a screen reader hears each count change. */}
            {suggestions && (
                <span aria-live="polite" className="sr-only" role="status">
                    {emoji.announcement}
                </span>
            )}
            <EmojiShortcodePopup
                editorRect={editorRect}
                listboxId={emoji.listboxId}
                onHighlight={emoji.highlight}
                onSelect={emoji.select}
                open={emoji.open}
                selected={emoji.selected}
                suggestions={emoji.suggestions}
            />
        </div>
    );
};

ComposerTiptapEditor.displayName = "ComposerTiptapEditor";

export { ComposerTiptapEditor };
