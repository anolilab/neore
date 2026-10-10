/**
 * Compute a TipTap/ProseMirror Commit from two arbitrary JSONContent snapshots.
 *
 * Uses `prosemirror-recreate-transform` to reverse-engineer the ProseMirror
 * steps needed to go from `oldContent` to `newContent`.
 */
import { recreateTransform } from "@fellow/prosemirror-recreate-transform";
import type { JSONContent } from "@tiptap/core";
import type { Schema } from "@tiptap/pm/model";
import { Node } from "@tiptap/pm/model";

/** Serialized ProseMirror step — always carries a `stepType` discriminator. */
export interface DiffStep {
    [key: string]: unknown;
    stepType: string;
}

export interface DiffCommit {
    doc: JSONContent;
    parent: JSONContent;
    steps: DiffStep[];
}

/**
 * Compute the diff between two document snapshots.
 * @param schema The ProseMirror schema (from `getSchema(extensions)`)
 * @param oldContent The older document state (TipTap JSONContent)
 * @param newContent The newer document state (TipTap JSONContent)
 * @returns A DiffCommit with parent, doc, and steps
 */
const computeCommit = (schema: Schema, oldContent: JSONContent, newContent: JSONContent): DiffCommit => {
    const oldDocument = Node.fromJSON(schema, oldContent);
    const newDocument = Node.fromJSON(schema, newContent);

    const tr = recreateTransform(oldDocument, newDocument, {
        complexSteps: true,
        wordDiffs: true,
    });

    return {
        doc: newContent,
        parent: oldContent,
        steps: tr.steps.map((s: { toJSON: () => DiffStep }) => s.toJSON()),
    };
};

export default computeCommit;
