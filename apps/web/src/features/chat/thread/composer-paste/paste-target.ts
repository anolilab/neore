import type { Editor } from "@tiptap/core";

/**
 * Whether the composer takes a paste now: not while disabled or while its editor is read-only. Asked again once a
 * converted paste is ready, since the composer can be disabled while the conversion runs.
 */
export const takesPaste = (disabled: boolean, editor: Editor | null | undefined): boolean =>
    !disabled && !(editor && !editor.isDestroyed && !editor.isEditable);
