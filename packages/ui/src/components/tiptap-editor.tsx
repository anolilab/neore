"use client";

import "reactjs-tiptap-editor/style.css";
// Importing editor-locales registers all custom locales as a side effect.
import "../lib/editor-locales";

import { Plural, useLingui } from "@lingui/react/macro";
import { CharacterCount } from "@tiptap/extension-character-count";
import { Placeholder } from "@tiptap/extension-placeholder";
import type { Editor, JSONContent } from "@tiptap/react";
import { EditorContent, useEditor } from "@tiptap/react";
import type * as React from "react";
import { useEffect, useImperativeHandle } from "react";
import { RichTextProvider } from "reactjs-tiptap-editor";
import { Blockquote, RichTextBlockquote } from "reactjs-tiptap-editor/blockquote";
import { Bold, RichTextBold } from "reactjs-tiptap-editor/bold";
import { RichTextBubbleLink } from "reactjs-tiptap-editor/bubble";
import { BulletList, RichTextBulletList } from "reactjs-tiptap-editor/bulletlist";
import { Code, RichTextCode } from "reactjs-tiptap-editor/code";
import { Color, RichTextColor } from "reactjs-tiptap-editor/color";
import { Heading, RichTextHeading } from "reactjs-tiptap-editor/heading";
import { Highlight, RichTextHighlight } from "reactjs-tiptap-editor/highlight";
import { History, RichTextRedo, RichTextUndo } from "reactjs-tiptap-editor/history";
import { Italic, RichTextItalic } from "reactjs-tiptap-editor/italic";
import { localeActions } from "reactjs-tiptap-editor/locale-bundle";
import { OrderedList, RichTextOrderedList } from "reactjs-tiptap-editor/orderedlist";
import { RichTextStrike, Strike } from "reactjs-tiptap-editor/strike";
import { RichTextTaskList, TaskList } from "reactjs-tiptap-editor/tasklist";
import { RichTextUnderline, TextUnderline } from "reactjs-tiptap-editor/textunderline";

import { BASE_EXTENSIONS, EDITOR_PLACEHOLDER_CLASSES } from "../lib/tiptap-base-extensions";
import ToolbarSeparator from "../lib/tiptap-toolbar-separator";
import cn from "../utils/cn";

const EXTENSIONS = [
    ...BASE_EXTENSIONS,
    Bold,
    Italic,
    TextUnderline,
    Strike,
    Code,
    Heading,
    BulletList,
    OrderedList,
    TaskList,
    Blockquote,
    Color,
    Highlight,
    History,
];

export interface TiptapEditorRef {
    blur: () => void;
    clear: () => void;
    editor: Editor | null;
    focus: () => void;
    getContent: () => string;
    getHTML: () => string;
    getJSON: () => JSONContent;
    setContent: (content: string) => void;
}

export interface TiptapEditorProps {
    autofocus?: boolean;
    className?: string;
    content?: string;
    editable?: boolean;
    editorClassName?: string;

    /**
     * BCP 47 locale code (e.g. "en", "de").
     * The caller is responsible for registering custom locale messages via
     * `localeActions.setMessage(locale, messages)` before mounting if the
     * locale is not one of the built-in ones (en, vi, zh_CN, pt_BR, hu_HU, fi).
     */
    locale?: string;
    maxLength?: number;
    onBlur?: () => void;
    onChange?: (content: string) => void;
    onFocus?: () => void;
    placeholder?: string;
    ref?: React.Ref<TiptapEditorRef>;
    showCharacterCount?: boolean;
    showToolbar?: boolean;
}

export const TiptapEditor = ({
    autofocus = false,
    className,
    content = "",
    editable = true,
    editorClassName,
    locale,
    maxLength,
    onBlur,
    onChange,
    onFocus,
    placeholder,
    ref,
    showCharacterCount = false,
    showToolbar = true,
}: TiptapEditorProps) => {
    const { t } = useLingui();

    // Sync locale with the editor library
    useEffect(() => {
        if (locale) {
            localeActions.setLang(locale);
        }
    }, [locale]);

    const extensions = [
        ...EXTENSIONS,
        Placeholder.configure({
            emptyEditorClass: "is-editor-empty",
            placeholder: placeholder ?? t`Start writing...`,
        }),
        ...(maxLength == null ? [] : [CharacterCount.configure({ limit: maxLength })]),
    ];

    const editor = useEditor({
        autofocus,
        content,
        editable,
        editorProps: {
            attributes: {
                class: cn("prose prose-sm dark:prose-invert max-w-none focus:outline-none min-h-[100px] p-3", EDITOR_PLACEHOLDER_CLASSES, editorClassName),
            },
        },
        extensions,
        onBlur: () => {
            onBlur?.();
        },
        onFocus: () => {
            onFocus?.();
        },
        onUpdate: ({ editor: e }) => {
            onChange?.(e.getText());
        },
    });

    // Sync content changes from parent
    useEffect(() => {
        if (editor && content !== editor.getText()) {
            editor.commands.setContent(content);
        }
    }, [content, editor]);

    // Expose methods via ref
    useImperativeHandle(ref, () => {
        return {
            blur: () => {
                editor?.commands.blur();
            },
            clear: () => {
                editor?.commands.clearContent();
            },
            editor,
            focus: () => {
                editor?.commands.focus();
            },
            getContent: () => editor?.getText() ?? "",
            getHTML: () => editor?.getHTML() ?? "",
            getJSON: () => editor?.getJSON() ?? {},
            setContent: (newContent: string) => {
                editor?.commands.setContent(newContent);
            },
        };
    }, [editor]);

    const characterCount = editor?.storage.characterCount?.characters() ?? 0;
    const wordCount = editor?.storage.characterCount?.words() ?? 0;

    return (
        <RichTextProvider editor={editor}>
            <div className={cn("bg-background overflow-hidden rounded-md border", !editable && "cursor-not-allowed opacity-60", className)}>
                {showToolbar && editor && editable && (
                    <div className="bg-muted/30 flex flex-wrap items-center gap-0.5 border-b p-1">
                        <RichTextUndo />
                        <RichTextRedo />

                        <ToolbarSeparator />

                        <RichTextBold />
                        <RichTextItalic />
                        <RichTextUnderline />
                        <RichTextStrike />
                        <RichTextCode />
                        <RichTextColor />
                        <RichTextHighlight />

                        <ToolbarSeparator />

                        <RichTextHeading />

                        <ToolbarSeparator />

                        <RichTextBulletList />
                        <RichTextOrderedList />
                        <RichTextTaskList />
                        <RichTextBlockquote />
                    </div>
                )}

                <EditorContent editor={editor} />

                {showCharacterCount && (
                    <div className="text-muted-foreground bg-muted/30 flex items-center justify-end gap-2 border-t px-3 py-1.5 text-xs">
                        <span>
                            <Plural one="# word" other="# words" value={wordCount} />
                        </span>
                        <span>·</span>
                        <span>
                            {maxLength ? (
                                t`${characterCount}/${maxLength} characters`
                            ) : (
                                <Plural one="# character" other="# characters" value={characterCount} />
                            )}
                        </span>
                    </div>
                )}
            </div>

            {/* Bubble menu for links */}
            <RichTextBubbleLink />
        </RichTextProvider>
    );
};

TiptapEditor.displayName = "TiptapEditor";

// Minimal editor without toolbar for compact use cases
export const TiptapEditorMinimal = (props: TiptapEditorProps) => <TiptapEditor {...props} showCharacterCount={false} showToolbar={false} />;

TiptapEditorMinimal.displayName = "TiptapEditorMinimal";
