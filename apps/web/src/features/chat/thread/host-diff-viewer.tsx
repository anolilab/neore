"use client";

/**
 * A host turn's frozen patch as text, one list of lines per file, where lines can be selected and commented on
 * (plans/acp-agent-host.md §4.9). The patch is the agent's text, so every line is plain text, never Markdown. Each file's
 * lines are a multi-select list with a roving tab stop: Arrow keys move, Shift with an arrow extends the selection,
 * Space selects the line, Enter (or the button) opens the comment box, Escape clears. A selection stays in one file.
 */

import { Trans, useLingui } from "@lingui/react/macro";
import { Button } from "@neore/ui/components/button";
import cn from "@neore/ui/utils/cn";
import { MessageSquarePlusIcon } from "lucide-react";
import type { FC, KeyboardEvent, MouseEvent } from "react";
import { useMemo, useRef, useState } from "react";

import DiffCommentForm from "@/features/chat/host/diff-comment-form";
import type { DiffFile, DiffLine } from "@/features/chat/host/diff-comments";
import { describeRange, parsePatchFiles, rangeOf } from "@/features/chat/host/diff-comments";
import { useDiffCommentStore, useDiffDraft } from "@/features/chat/host/diff-comments-store";

import type { PatchLineKind } from "./host-changes-lines";
import { classifyPatch } from "./host-changes-lines";

const LINE_CLASS: Record<PatchLineKind, string | undefined> = {
    add: "text-green-700 dark:text-green-400",
    context: undefined,
    header: "text-muted-foreground font-medium",
    hunk: "text-muted-foreground",
    remove: "text-red-700 dark:text-red-400",
};

interface Selection {
    anchor: number;
    composing: boolean;
    file: number;
    head: number;
}

interface HostDiffViewerProps {
    /** Where comments go; without it the patch is shown read-only. */
    comment?: { messageId: string; threadId: string };
    patch: string;
}

/** The selectable lines between two positions of a file's lines, in order. */
const linesBetween = (file: DiffFile, selection: Pick<Selection, "anchor" | "head">): DiffLine[] =>
    file.lines.slice(Math.min(selection.anchor, selection.head), Math.max(selection.anchor, selection.head) + 1).filter((line) => line.selectable);

const selectableAt = (file: DiffFile, from: number, step: 1 | -1): number | undefined => {
    for (let index = from; index >= 0 && index < file.lines.length; index += step) {
        if (file.lines[index]?.selectable) {
            return index;
        }
    }

    return undefined;
};

interface DiffFileViewProps {
    commented: ReadonlySet<string>;
    file: DiffFile;
    fileIndex: number;
    messageId: string;
    selection: Selection | undefined;
    setSelection: (next: Selection | undefined) => void;
    threadId: string;
}

const DiffFileView: FC<DiffFileViewProps> = ({ commented, file, fileIndex, messageId, selection, setSelection, threadId }) => {
    const { t } = useLingui();
    const mine = selection?.file === fileIndex ? selection : undefined;
    const [stop, setStop] = useState(() => selectableAt(file, 0, 1) ?? 0);
    const elements = useRef(new Map<number, HTMLLIElement>());
    const [fileForm, setFileForm] = useState(false);
    const selected = mine ? linesBetween(file, mine) : [];
    const range = rangeOf(selected);
    const rangeLabel = range ? describeRange(range) : "";
    const lo = mine ? Math.min(mine.anchor, mine.head) : -1;
    const hi = mine ? Math.max(mine.anchor, mine.head) : -1;
    const kindWord: Record<PatchLineKind, string> = { add: t`added`, context: t`unchanged`, header: "", hunk: "", remove: t`removed` };

    const move = (index: number, extend: boolean) => {
        setStop(index);
        elements.current.get(index)?.focus();

        if (extend) {
            setSelection({ anchor: mine?.anchor ?? stop, composing: false, file: fileIndex, head: index });
        }
    };

    const startComment = (index: number) => {
        setSelection({ anchor: mine?.anchor ?? index, composing: true, file: fileIndex, head: mine?.head ?? index });
    };

    const onKeyDown = (event: KeyboardEvent<HTMLLIElement>, index: number) => {
        const shift = event.shiftKey;
        let target: number | undefined;

        switch (event.key) {
            case " ": {
                event.preventDefault();
                setSelection({ anchor: index, composing: false, file: fileIndex, head: index });

                return;
            }
            case "ArrowDown": {
                target = selectableAt(file, index + 1, 1);

                break;
            }
            case "ArrowUp": {
                target = selectableAt(file, index - 1, -1);

                break;
            }
            case "c":
            case "Enter": {
                event.preventDefault();
                startComment(index);

                return;
            }
            case "End": {
                target = selectableAt(file, file.lines.length - 1, -1);

                break;
            }
            case "Home": {
                target = selectableAt(file, 0, 1);

                break;
            }
            default: {
                if (event.key === "Escape" && mine) {
                    event.preventDefault();
                    event.stopPropagation();
                    setSelection(undefined);

                    return;
                }

                return;
            }
        }

        event.preventDefault();

        if (target !== undefined) {
            move(target, shift);
        }
    };

    const onClick = (event: MouseEvent<HTMLLIElement>, index: number) => {
        setStop(index);
        setSelection({ anchor: event.shiftKey && mine ? mine.anchor : index, composing: false, file: fileIndex, head: index });
    };

    const addLineComment = (text: string) => {
        if (range) {
            useDiffCommentStore.getState().add(threadId, { messageId, path: file.path, range, text });
        }

        setSelection(undefined);
        elements.current.get(stop)?.focus();
    };

    return (
        <section aria-label={t`Changes to ${file.path}`} className="border-border rounded-md border">
            <div className="bg-muted/50 flex items-center justify-between gap-2 px-3 py-1">
                <h3 className="min-w-0 truncate font-mono text-xs font-medium">{file.path}</h3>
                <Button aria-label={t`Comment on the whole file ${file.path}`} onClick={() => setFileForm(true)} size="xs" type="button" variant="ghost">
                    <MessageSquarePlusIcon aria-hidden="true" className="size-3.5" />
                    <Trans>Comment on file</Trans>
                </Button>
            </div>
            <ul aria-label={t`Lines of ${file.path}`} aria-multiselectable="true" className="overflow-x-auto font-mono text-xs leading-5" role="listbox">
                {file.lines.map((line, index) => {
                    if (!line.selectable) {
                        return (
                            <li className={cn("px-3 whitespace-pre", LINE_CLASS[line.kind])} key={line.id} role="presentation">
                                {line.text}
                            </li>
                        );
                    }

                    const number = line.newNumber ?? line.oldNumber ?? 0;
                    const isSelected = index >= lo && index <= hi;

                    return (
                        <li
                            aria-label={t`Line ${number}, ${kindWord[line.kind]}: ${line.text}`}
                            aria-selected={isSelected}
                            className={cn(
                                "focus-visible:ring-ring cursor-pointer px-3 whitespace-pre focus-visible:ring-2 focus-visible:outline-none focus-visible:ring-inset",
                                LINE_CLASS[line.kind],
                                isSelected && "bg-primary/15",
                                commented.has(`${file.path}\u{0}${line.id}`) && "border-l-primary border-l-2",
                            )}
                            data-line={line.id}
                            key={line.id}
                            onClick={(event) => onClick(event, index)}
                            onFocus={() => setStop(index)}
                            onKeyDown={(event) => onKeyDown(event, index)}
                            ref={(element) => {
                                if (element) {
                                    elements.current.set(index, element);
                                } else {
                                    elements.current.delete(index);
                                }
                            }}
                            role="option"
                            tabIndex={index === stop ? 0 : -1}
                        >
                            {line.text}
                        </li>
                    );
                })}
            </ul>
            {mine && range && !mine.composing && (
                <div className="border-border border-t p-2">
                    <Button onClick={() => startComment(mine.head)} size="sm" type="button" variant="outline">
                        <MessageSquarePlusIcon aria-hidden="true" className="size-4" />
                        {t`Comment on lines ${rangeLabel}`}
                    </Button>
                </div>
            )}
            {mine?.composing && range && (
                <div className="border-border border-t">
                    <DiffCommentForm
                        label={t`Comment on ${file.path}, lines ${rangeLabel}`}
                        onCancel={() => {
                            setSelection(undefined);
                            elements.current.get(stop)?.focus();
                        }}
                        onSubmit={addLineComment}
                    />
                </div>
            )}
            {fileForm && (
                <div className="border-border border-t">
                    <DiffCommentForm
                        label={t`Comment on the whole file ${file.path}`}
                        onCancel={() => setFileForm(false)}
                        onSubmit={(text) => {
                            useDiffCommentStore.getState().add(threadId, { messageId, path: file.path, text });
                            setFileForm(false);
                        }}
                    />
                </div>
            )}
        </section>
    );
};

const PlainPatch: FC<{ patch: string }> = ({ patch }) => (
    <pre className="overflow-x-auto font-mono text-xs leading-5" data-testid="host-changes-patch">
        {classifyPatch(patch).map((line) => (
            <span className={LINE_CLASS[line.kind]} key={line.id}>
                {line.text}
                {"\n"}
            </span>
        ))}
    </pre>
);

const CommentableDiff: FC<{ messageId: string; patch: string; threadId: string }> = ({ messageId, patch, threadId }) => {
    const files = useMemo(() => parsePatchFiles(patch), [patch]);
    const drafts = useDiffDraft(threadId);
    const [selection, setSelection] = useState<Selection | undefined>();
    const commented = useMemo(() => {
        const ids = new Set<string>();

        for (const comment of drafts) {
            const file = files.find((entry) => entry.path === comment.path);

            if (comment.messageId !== messageId || !comment.range || !file) {
                continue;
            }

            for (const line of file.lines) {
                const number = line.newNumber ?? line.oldNumber;
                const side = line.newNumber === undefined ? "old" : "new";

                if (line.selectable && side === comment.range.side && number !== undefined && number >= comment.range.from && number <= comment.range.to) {
                    ids.add(`${file.path}\u{0}${line.id}`);
                }
            }
        }

        return ids;
    }, [drafts, files, messageId]);

    // A patch with no file header in it has nothing to attach a comment to.
    if (files.length === 0) {
        return <PlainPatch patch={patch} />;
    }

    return (
        <div className="flex flex-col gap-3" data-testid="host-changes-patch">
            {files.map((file, index) => (
                <DiffFileView
                    commented={commented}
                    file={file}
                    fileIndex={index}
                    key={`${String(index)}:${file.path}`}
                    messageId={messageId}
                    selection={selection}
                    setSelection={setSelection}
                    threadId={threadId}
                />
            ))}
        </div>
    );
};

const HostDiffViewer: FC<HostDiffViewerProps> = ({ comment, patch }) =>
    comment ? <CommentableDiff messageId={comment.messageId} patch={patch} threadId={comment.threadId} /> : <PlainPatch patch={patch} />;

export default HostDiffViewer;
