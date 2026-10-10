/**
 * TipTap extension configuration for the canvas text editor.
 * Composes extensions equivalent to the ProseKit defineBasicExtension()
 * with code-block highlighting and change tracking.
 */
import type { Extensions } from "@tiptap/core";
import { CharacterCount } from "@tiptap/extension-character-count";
import { CodeBlockLowlight } from "@tiptap/extension-code-block-lowlight";
import { Color } from "@tiptap/extension-color";
import { Highlight } from "@tiptap/extension-highlight";
import { Image } from "@tiptap/extension-image";
import { Link } from "@tiptap/extension-link";
import { Placeholder } from "@tiptap/extension-placeholder";
import { Subscript } from "@tiptap/extension-subscript";
import { Superscript } from "@tiptap/extension-superscript";
import { Table } from "@tiptap/extension-table";
import { TableCell } from "@tiptap/extension-table-cell";
import { TableHeader } from "@tiptap/extension-table-header";
import { TableRow } from "@tiptap/extension-table-row";
import { TaskItem } from "@tiptap/extension-task-item";
import { TaskList } from "@tiptap/extension-task-list";
import { TextAlign } from "@tiptap/extension-text-align";
import { TextStyle } from "@tiptap/extension-text-style";
import { Typography } from "@tiptap/extension-typography";
import { Underline } from "@tiptap/extension-underline";
import { StarterKit } from "@tiptap/starter-kit";
import { common, createLowlight } from "lowlight";

// Create lowlight instance with common languages
const lowlight = createLowlight(common);

/**
 * The extensions array for the canvas text editor.
 * Equivalent to ProseKit's defineBasicExtension() + placeholder + code highlighting.
 *
 * Provides: doc, text, paragraph, heading, list (bullet, ordered), task lists,
 * blockquote, image, horizontal-rule, table, code-block with syntax highlighting,
 * italic, bold, underline, strike, code, link, highlight, typography, history,
 * subscript, superscript, text alignment.
 */
export const createCanvasExtensions = (options?: { placeholder?: string }): Extensions => [
    StarterKit.configure({
        // Disable the default code block - we'll use CodeBlockLowlight instead
        codeBlock: false,
        heading: {
            levels: [1, 2, 3, 4, 5, 6],
        },
    }),
    Placeholder.configure({
        emptyEditorClass: "is-editor-empty",
        placeholder: options?.placeholder ?? "Start writing...",
    }),
    CharacterCount,
    TaskList,
    TaskItem.configure({
        nested: true,
    }),
    Highlight.configure({
        multicolor: true,
    }),
    Typography,
    TextStyle,
    TextAlign.configure({
        types: ["heading", "paragraph"],
    }),
    Color,
    Underline,
    Subscript,
    Superscript,
    Link.configure({
        autolink: true,
        defaultProtocol: "https",
        HTMLAttributes: {
            class: "text-primary underline underline-offset-2",
        },
        openOnClick: false,
    }),
    Image.configure({
        allowBase64: true,
        HTMLAttributes: {
            class: "rounded-md max-w-full",
        },
        inline: false,
    }),
    Table.configure({
        HTMLAttributes: {
            class: "border-collapse table-auto w-full",
        },
        resizable: true,
    }),
    TableRow,
    TableCell.configure({
        HTMLAttributes: {
            class: "border border-muted-foreground/30 p-2",
        },
    }),
    TableHeader.configure({
        HTMLAttributes: {
            class: "border border-muted-foreground/30 p-2 bg-muted font-semibold",
        },
    }),
    CodeBlockLowlight.configure({
        defaultLanguage: "plaintext",
        HTMLAttributes: {
            class: "rounded-md bg-muted p-4 font-mono text-sm overflow-x-auto",
        },
        lowlight,
    }),
];

/**
 * Get the extensions array for the canvas editor.
 * Cached for reuse in markdown conversion.
 */
export const getCanvasExtensions = ((): (() => Extensions) => {
    let cachedExtensions: Extensions | null = null;

    return (): Extensions => {
        cachedExtensions ??= createCanvasExtensions();

        return cachedExtensions;
    };
})();
