/**
 * CodeMirror support for `@label` mentions in a workflow prompt.
 *
 * Only what `@uiw/react-codemirror` re-exports is used: `@codemirror/autocomplete` is not a
 * dependency of this app. The completion source is registered through `languageData`, which
 * the editor's `basicSetup` autocompletion reads, so its list and keyboard handling are
 * CodeMirror's own.
 */

import type { DecorationSet, EditorView, Extension, ViewUpdate } from "@uiw/react-codemirror";
import { Decoration, EditorState, MatchDecorator, ViewPlugin } from "@uiw/react-codemirror";

/** The part of CodeMirror's completion context this source reads. */
interface MentionContext {
    matchBefore: (expression: RegExp) => { from: number; text: string } | null;
    state: EditorState;
}

const WORD_CHAR = /[\p{L}\p{N}_]/u;

const MENTION_PREFIX = /@[^\n@]*/u;

const escapeRegExp = (value: string): string => value.replaceAll(/[.*+?^${}()|[\]\\]/gu, String.raw`\$&`);

/** Matches `@label` for the given labels, longest first, and only where the label ends on a boundary. */
const mentionPattern = (labels: ReadonlyArray<string>): RegExp => {
    const alternatives = labels.toSorted((a, b) => b.length - a.length).map((label) => escapeRegExp(label));

    return new RegExp(String.raw`@(?:${alternatives.join("|")})(?![\p{L}\p{N}_])`, "gu");
};

/** Completion source: after an `@` that starts a word, offer the labels. Accepting inserts `@Label `. */
const mentionCompletion = (labels: ReadonlyArray<string>) => (context: MentionContext) => {
    const match = context.matchBefore(MENTION_PREFIX);

    if (!match) {
        return null;
    }

    if (match.from > 0 && WORD_CHAR.test(context.state.sliceDoc(match.from - 1, match.from))) {
        return null;
    }

    return {
        from: match.from,
        options: labels.map((label) => {
            return { apply: `@${label} `, label: `@${label}`, type: "variable" };
        }),
    };
};

const mentionMark = Decoration.mark({ class: "rounded bg-primary/15 px-0.5 font-medium text-primary" });

const highlightMentions = (labels: ReadonlyArray<string>): Extension => {
    const matcher = new MatchDecorator({ decoration: mentionMark, regexp: mentionPattern(labels) });

    return ViewPlugin.fromClass(
        class {
            public decorations: DecorationSet;

            public constructor(view: EditorView) {
                this.decorations = matcher.createDeco(view);
            }

            public update(update: ViewUpdate): void {
                this.decorations = matcher.updateDeco(update, this.decorations);
            }
        },
        { decorations: (instance) => instance.decorations },
    );
};

/** The editor extensions for mentions over `labels`: completion and highlighting. */
export const mentionExtensions = (labels: ReadonlyArray<string>): Extension[] => {
    if (labels.length === 0) {
        return [];
    }

    return [EditorState.languageData.of(() => [{ autocomplete: mentionCompletion(labels) }]), highlightMentions(labels)];
};
