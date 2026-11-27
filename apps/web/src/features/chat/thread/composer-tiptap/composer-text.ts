import type { Editor, TextSerializer } from "@tiptap/core";
import { getText, getTextSerializersFromSchema } from "@tiptap/core";
import type { Node, Schema } from "@tiptap/pm/model";

const serializersBySchema = new WeakMap<Schema, Record<string, TextSerializer>>();
const textByDocument = new WeakMap<Node, string>();

/**
 * The composer's text, one line per block, as `editor.getText({ blockSeparator: "\n" })` reads it. A keystroke asks
 * for it several times (the change handler, then the ghost completion on the update and on the selection change);
 * ProseMirror documents are immutable, so each document is serialised once and every later read is a lookup.
 */
export const readComposerText = (editor: Editor): string => {
    const { doc, schema } = editor.state;
    const cached = textByDocument.get(doc);

    if (cached !== undefined) {
        return cached;
    }

    let textSerializers = serializersBySchema.get(schema);

    if (!textSerializers) {
        textSerializers = getTextSerializersFromSchema(schema);
        serializersBySchema.set(schema, textSerializers);
    }

    const text = getText(doc, { blockSeparator: "\n", textSerializers });

    textByDocument.set(doc, text);

    return text;
};
