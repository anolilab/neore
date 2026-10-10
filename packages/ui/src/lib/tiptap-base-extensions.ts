/**
 * Primitive Tiptap extensions shared by all editors in this package.
 *
 * reactjs-tiptap-editor must NOT be used with StarterKit — it manages its own
 * instances of history, bold, italic etc. via keyed ProseMirror plugins.
 * Mixing StarterKit causes "Adding different instances of a keyed plugin" errors.
 * These extensions replace the parts of StarterKit that are safe to include.
 */

import { Document } from "@tiptap/extension-document";
import { HardBreak } from "@tiptap/extension-hard-break";
import { ListItem } from "@tiptap/extension-list";
import { Paragraph } from "@tiptap/extension-paragraph";
import { Text } from "@tiptap/extension-text";
import { TextStyle } from "@tiptap/extension-text-style";
import { Dropcursor, Gapcursor, TrailingNode } from "@tiptap/extensions";

export const BASE_EXTENSIONS = [Document, Text, Paragraph, HardBreak, Dropcursor, Gapcursor, TrailingNode, ListItem, TextStyle];

/**
 * Tailwind classes for the placeholder ::before pseudo-element.
 * Applied to the TipTap editor content area via editorProps.attributes.class.
 */
export const EDITOR_PLACEHOLDER_CLASSES =
    "[&_.is-editor-empty:first-child::before]:content-[attr(data-placeholder)]" +
    " [&_.is-editor-empty:first-child::before]:text-muted-foreground" +
    " [&_.is-editor-empty:first-child::before]:float-left" +
    " [&_.is-editor-empty:first-child::before]:pointer-events-none" +
    " [&_.is-editor-empty:first-child::before]:h-0";
