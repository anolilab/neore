"use client";

/**
 * TipTap Canvas Editor — Full-featured text editor for the canvas panel.
 * Uses reactjs-tiptap-editor for composable toolbar, bubble menus, and slash commands.
 */

import "reactjs-tiptap-editor/style.css";
// Importing editor-locales registers all custom locales as a side effect.
import "../lib/editor-locales";

import { useLingui } from "@lingui/react/macro";
import type { Extensions } from "@tiptap/core";
import { Placeholder } from "@tiptap/extension-placeholder";
import type { Editor, JSONContent } from "@tiptap/react";
import { EditorContent, useEditor } from "@tiptap/react";
import type * as React from "react";
import type { ReactNode } from "react";
import { useEffect, useImperativeHandle, useMemo, useRef } from "react";
import { RichTextProvider } from "reactjs-tiptap-editor";
import { Blockquote, RichTextBlockquote } from "reactjs-tiptap-editor/blockquote";
import { Bold, RichTextBold } from "reactjs-tiptap-editor/bold";
import { RichTextBubbleImage, RichTextBubbleLink, RichTextBubbleTable } from "reactjs-tiptap-editor/bubble";
import { BulletList, RichTextBulletList } from "reactjs-tiptap-editor/bulletlist";
import { Code, RichTextCode } from "reactjs-tiptap-editor/code";
import { CodeBlock, RichTextCodeBlock } from "reactjs-tiptap-editor/codeblock";
import { Color, RichTextColor } from "reactjs-tiptap-editor/color";
import { Heading, RichTextHeading } from "reactjs-tiptap-editor/heading";
import { Highlight, RichTextHighlight } from "reactjs-tiptap-editor/highlight";
import { History, RichTextRedo, RichTextUndo } from "reactjs-tiptap-editor/history";
import { HorizontalRule, RichTextHorizontalRule } from "reactjs-tiptap-editor/horizontalrule";
import { Image as TiptapImage, RichTextImage } from "reactjs-tiptap-editor/image";
import { Italic, RichTextItalic } from "reactjs-tiptap-editor/italic";
import { Link as TiptapLink, RichTextLink } from "reactjs-tiptap-editor/link";
import { localeActions } from "reactjs-tiptap-editor/locale-bundle";
import { OrderedList, RichTextOrderedList } from "reactjs-tiptap-editor/orderedlist";
import { SlashCommand } from "reactjs-tiptap-editor/slashcommand";
import { RichTextStrike, Strike } from "reactjs-tiptap-editor/strike";
import { RichTextTable, Table as TiptapTable } from "reactjs-tiptap-editor/table";
import { RichTextTaskList, TaskList } from "reactjs-tiptap-editor/tasklist";
import { RichTextAlign, TextAlign } from "reactjs-tiptap-editor/textalign";
import { RichTextUnderline, TextUnderline } from "reactjs-tiptap-editor/textunderline";

import { BASE_EXTENSIONS, EDITOR_PLACEHOLDER_CLASSES } from "../lib/tiptap-base-extensions";
import { htmlToMarkdown, markdownToHTML, markdownToTiptapJSON } from "../lib/tiptap-markdown";
import ToolbarSeparator from "../lib/tiptap-toolbar-separator";
import cn from "../utils/cn";

export { EDITOR_LOCALE_MAP } from "../lib/editor-locales";

// -------------------------------------------------------------------
// Types
// -------------------------------------------------------------------

export interface TiptapCanvasEditorRef {
    editor: Editor | null;
    focus: () => void;
    getHTML: () => string;
    getJSON: () => JSONContent;
    getMarkdown: () => string;
    /** Parses markdown with this editor's schema WITHOUT applying it — for previews such as an AI diff. */
    markdownToJSON: (markdown: string) => JSONContent;
    setContent: (content: string) => void;
    setJSON: (json: JSONContent) => void;
}

export interface TiptapCanvasEditorProps {
    /** Debounce delay for auto-save in ms */
    autoSaveDelay?: number;
    /** Additional content to render (e.g., custom handlers) */
    children?: ReactNode;
    /** Additional class for the container */
    className?: string;
    /** Initial content (markdown string) */
    content?: string;
    /** Initial content as JSON (takes precedence over content) */
    contentJson?: JSONContent | null;
    /** `false` renders read-only (no toolbar edits, no autosave). Defaults to `true`. */
    editable?: boolean;
    /** Extra extensions appended to the built-in set — e.g. a comment mark. Read once, at mount. */
    extensions?: Extensions;

    /**
     * BCP 47 locale code mapped to an editor locale (e.g. "en", "de").
     * Use EDITOR_LOCALE_MAP to convert from app locale codes.
     */
    locale?: string;
    /** Called when content changes (debounced). Returns markdown, JSON, and optional commit info. */
    onSave?: (content: string, contentJson: JSONContent, commit?: ChangeCommit) => void;
    ref?: React.Ref<TiptapCanvasEditorRef>;
    /** Show the fixed toolbar at the top */
    toolbar?: boolean;
}

/** Change commit info for version history */
export interface ChangeCommit {
    changes: number;
    timestamp: number;
}

// -------------------------------------------------------------------
// Extensions
// -------------------------------------------------------------------

// The Placeholder extension is added per editor (see `placeholderExtension`) so its text is translated.
const EXTENSIONS = [
    ...BASE_EXTENSIONS,
    // Formatting marks
    Bold,
    Italic,
    TextUnderline,
    Strike,
    Code,
    // Block nodes
    Heading,
    BulletList,
    OrderedList,
    TaskList,
    Blockquote,
    CodeBlock,
    HorizontalRule,
    // Rich content
    TiptapLink,
    TiptapImage.configure({ resourceImage: "link" }),
    TiptapTable,
    // Colors & styles
    Color,
    Highlight,
    TextAlign,
    // Utilities
    History,
    SlashCommand,
];

// -------------------------------------------------------------------
// Main Editor Component
// -------------------------------------------------------------------

const DEFAULT_AUTOSAVE_DELAY = 1500;

export const TiptapCanvasEditor = ({
    autoSaveDelay = DEFAULT_AUTOSAVE_DELAY,
    children,
    className,
    content = "",
    contentJson,
    editable = true,
    extensions,
    locale,
    onSave,
    ref,
    toolbar = false,
}: TiptapCanvasEditorProps) => {
    const { t } = useLingui();
    const debounceRef = useRef<ReturnType<typeof setTimeout>>(null);
    // Read once, when the editor is created: `useEditor` does not re-apply extensions.
    const placeholderExtension = useMemo(
        () =>
            Placeholder.configure({
                emptyNodeClass: "is-editor-empty",
                placeholder: t`Write, or type '/' for commands…`,
            }),
        [t],
    );
    const transactionCountRef = useRef(0);
    const initializedRef = useRef(false);

    // Sync locale → editor locale whenever it changes
    useEffect(() => {
        if (locale) {
            localeActions.setLang(locale);
        }
    }, [locale]);

    const editor = useEditor({
        content: "",
        editable,
        editorProps: {
            attributes: {
                class: cn("prose prose-sm dark:prose-invert max-w-none focus:outline-none min-h-[200px] p-4", EDITOR_PLACEHOLDER_CLASSES),
            },
        },
        extensions: extensions ? [...EXTENSIONS, placeholderExtension, ...extensions] : [...EXTENSIONS, placeholderExtension],
        immediatelyRender: false,
        onUpdate: ({ editor: e, transaction }) => {
            if (!onSave) {
                return;
            }

            if (!transaction.docChanged) {
                return;
            }

            transactionCountRef.current++;

            if (debounceRef.current) {
                clearTimeout(debounceRef.current);
            }

            debounceRef.current = setTimeout(() => {
                const html = e.getHTML();
                const markdown = htmlToMarkdown(html);
                const json = e.getJSON();
                const commit: ChangeCommit = {
                    changes: transactionCountRef.current,
                    timestamp: Date.now(),
                };

                onSave(markdown, json, commit);
                transactionCountRef.current = 0;
            }, autoSaveDelay);
        },
    });

    // Set initial content once editor is ready
    useEffect(() => {
        if (!editor || initializedRef.current) {
            return;
        }

        initializedRef.current = true;

        if (contentJson) {
            editor.commands.setContent(contentJson);
        } else if (content) {
            const html = markdownToHTML(content);

            editor.commands.setContent(html);
        }
    }, [editor, content, contentJson]);

    useEffect(() => {
        editor?.setEditable(editable);
    }, [editor, editable]);

    // Cleanup debounce on unmount
    useEffect(
        () => () => {
            if (debounceRef.current) {
                clearTimeout(debounceRef.current);
            }
        },
        [],
    );

    // Expose ref methods
    useImperativeHandle(ref, () => {
        return {
            editor,
            focus: () => {
                editor?.commands.focus();
            },
            getHTML: () => editor?.getHTML() ?? "",
            getJSON: () => editor?.getJSON() ?? { content: [], type: "doc" },
            getMarkdown: () => (editor ? htmlToMarkdown(editor.getHTML()) : ""),
            markdownToJSON: (markdown: string) => markdownToTiptapJSON(editor?.extensionManager.extensions ?? EXTENSIONS, markdown),
            setContent: (newContent: string) => {
                if (!editor) {
                    return;
                }

                const html = markdownToHTML(newContent);

                editor.commands.setContent(html);
            },
            setJSON: (json: JSONContent) => {
                editor?.commands.setContent(json);
            },
        };
    }, [editor]);

    if (!editor) {
        return (
            <div className="flex h-full items-center justify-center">
                <div className="text-muted-foreground text-sm">{t`Loading editor…`}</div>
            </div>
        );
    }

    return (
        <RichTextProvider editor={editor}>
            <div className={cn("flex h-full flex-col overflow-hidden", className)}>
                {toolbar && editable && (
                    <div className="flex flex-wrap items-center gap-0.5 border-b px-3 py-1.5">
                        <RichTextUndo />
                        <RichTextRedo />
                        <ToolbarSeparator />
                        <RichTextBold />
                        <RichTextItalic />
                        <RichTextUnderline />
                        <RichTextStrike />
                        <RichTextCode />
                        <ToolbarSeparator />
                        <RichTextHeading />
                        <RichTextAlign />
                        <ToolbarSeparator />
                        <RichTextBulletList />
                        <RichTextOrderedList />
                        <RichTextTaskList />
                        <ToolbarSeparator />
                        <RichTextBlockquote />
                        <RichTextCodeBlock />
                        <RichTextHorizontalRule />
                        <ToolbarSeparator />
                        <RichTextLink />
                        <RichTextImage />
                        <RichTextTable />
                        <ToolbarSeparator />
                        <RichTextColor />
                        <RichTextHighlight />
                    </div>
                )}

                <div className="flex-1 overflow-auto" style={{ paddingBottom: 100 }}>
                    <EditorContent editor={editor} />
                </div>

                {children}
            </div>

            {/* Contextual bubble menus */}
            <RichTextBubbleLink />
            <RichTextBubbleImage />
            <RichTextBubbleTable />
        </RichTextProvider>
    );
};

TiptapCanvasEditor.displayName = "TiptapCanvasEditor";
