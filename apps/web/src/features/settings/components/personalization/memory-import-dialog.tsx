"use client";

import { plural } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";
import { api } from "@neore/backend/api";
import { Button } from "@neore/ui/components/button";
import { Checkbox } from "@neore/ui/components/checkbox";
import { Dialog, DialogDescription, DialogFooter, DialogHeader, DialogPanel, DialogPopup, DialogTitle, DialogTrigger } from "@neore/ui/components/dialog";
import { Label } from "@neore/ui/components/label";
import { Textarea } from "@neore/ui/components/textarea";
import { ToggleGroup, ToggleGroupItem } from "@neore/ui/components/toggle-group";
import { useMutation } from "@tanstack/react-query";
import { CopyIcon, DownloadIcon } from "lucide-react";
import type { FC } from "react";
import { useEffect, useId, useRef, useState } from "react";
import { toast } from "sonner";

import { useLunoraActionOptions } from "@/lib/lunora/crpc";

import type { ImportApp } from "./memory-import-apps";
import { IMPORT_APPS, isImportApp, useImportAppLabels } from "./memory-import-apps";
import type { MemoryType } from "./memory-types";
import { useMemoryTypeLabels } from "./memory-types";

/** Mirrors `IMPORT_MAX_INPUT_CHARS` in `backend/lunora/memory/import-logic.ts`. */
const MAX_PASTE_CHARS = 20_000;

interface Preview {
    cut: number;
    dropped: number;
    facts: { memory: string; type: MemoryType }[];
}

interface MemoryImportDialogProps {
    memoryEnabled: boolean;
    onEnableMemory: () => Promise<void>;
    onImported: () => void;
}

/**
 * Brings in what another assistant knows about the user: pick the assistant, copy a prompt
 * that asks it to list its memory, paste the answer, uncheck what to leave out, save.
 */
const MemoryImportDialog: FC<MemoryImportDialogProps> = ({ memoryEnabled, onEnableMemory, onImported }) => {
    const { i18n, t } = useLingui();
    const appLabels = useImportAppLabels();
    const typeLabels = useMemoryTypeLabels();
    const appLabelId = useId();
    const pasteId = useId();
    const factsHeadingId = useId();
    const tooLongId = useId();
    const [open, setOpen] = useState(false);
    const [app, setApp] = useState<ImportApp>("chatgpt");
    const [text, setText] = useState("");
    const [preview, setPreview] = useState<Preview | undefined>(undefined);
    const [unchecked, setUnchecked] = useState<ReadonlySet<number>>(new Set());
    const [isEnabling, setIsEnabling] = useState(false);
    // Where focus goes once the step it belongs to has rendered: the control that moved there just unmounted.
    const focusNext = useRef<string | undefined>(undefined);

    // Disabled while the setting saves, so a double activation sends one update.
    const enableMemory = async () => {
        setIsEnabling(true);
        focusNext.current = pasteId;
        await onEnableMemory();
        setIsEnabling(false);
    };

    useEffect(() => {
        const target = focusNext.current ? document.querySelector<HTMLElement>(`#${CSS.escape(focusNext.current)}`) : null;

        if (!target) {
            return;
        }

        focusNext.current = undefined;
        target.focus();
    }, [memoryEnabled, preview]);

    const prompt = t`List everything you remember about me from our past conversations and your saved memory. Write one fact per line, in the third person, starting with "The user" (for example: "The user works as a nurse in Hamburg."). Where you know when you learned a fact, add the date in brackets at the end of its line. Leave out passwords, keys, account numbers and health details. Write no introduction, headings or comments.`;

    const { isPending: isPreviewing, mutate: runPreview } = useMutation({
        ...useLunoraActionOptions(api.memory.import.previewMemoryImport),
    });

    // Bumped on every close: a preview that answers after the dialog closed is not shown.
    const opening = useRef(0);

    const startPreview = () => {
        const started = opening.current;

        runPreview(
            { text },
            {
                onError: (error: Error) => {
                    if (opening.current === started) {
                        toast.error(t`Could not read the pasted list`, { description: error.message });
                    }
                },
                onSuccess: (result: Preview) => {
                    if (opening.current !== started) {
                        return;
                    }

                    setUnchecked(new Set());
                    focusNext.current = factsHeadingId;
                    setPreview(result);
                },
            },
        );
    };

    const { isPending: isSaving, mutate: runSave } = useMutation({
        ...useLunoraActionOptions(api.memory.import.saveImportedMemories),
        onError: (error: Error) => {
            toast.error(t`Could not save the memories`, { description: error.message });
        },
        onSuccess: (result: { added: number; alreadyKnown: number; updated: number }) => {
            toast.success(plural(result.added, { one: "Saved # new memory", other: "Saved # new memories" }), {
                description: t`Updated: ${result.updated} · Already known: ${result.alreadyKnown}`,
            });
            setOpen(false);
            setText("");
            setPreview(undefined);
            onImported();
        },
    });

    const copyPrompt = async () => {
        try {
            await navigator.clipboard.writeText(prompt);
            toast.success(t`Prompt copied`);
        } catch {
            toast.error(t`Could not copy the prompt`);
        }
    };

    const toggleFact = (index: number, checked: boolean) => {
        setUnchecked((previous) => {
            const next = new Set(previous);

            if (checked) {
                next.delete(index);
            } else {
                next.add(index);
            }

            return next;
        });
    };

    const kept = preview?.facts.filter((_, index) => !unchecked.has(index)) ?? [];
    const tooLong = text.length > MAX_PASTE_CHARS;
    const maxPasteChars = i18n.number(MAX_PASTE_CHARS);

    return (
        <Dialog
            onOpenChange={(next) => {
                // Stays open while a save runs: its answer closes the dialog, and would drop a paste made after a reopen.
                if (!next && isSaving) {
                    return;
                }

                setOpen(next);

                // Closing drops the preview: reopening starts from the paste, never from facts checked earlier.
                if (!next) {
                    opening.current += 1;
                    setPreview(undefined);
                    setUnchecked(new Set());
                }
            }}
            open={open}
        >
            <DialogTrigger render={<Button className="w-full" variant="outline" />}>
                <DownloadIcon aria-hidden="true" className="mr-2 h-4 w-4" />
                {t`Bring in what another AI knows about you`}
            </DialogTrigger>
            <DialogPopup>
                <DialogHeader>
                    <DialogTitle>{t`Bring in what another AI knows about you`}</DialogTitle>
                    <DialogDescription>{t`Ask your other assistant to list what it remembers, paste its answer, and choose which facts to keep. The pasted text is only read as a list of facts.`}</DialogDescription>
                </DialogHeader>
                <DialogPanel className="space-y-4">
                    {!memoryEnabled && (
                        <div className="space-y-2">
                            <p className="text-sm">{t`Memory is off. Turn it on to bring in memories; nothing is saved while it is off.`}</p>
                            <Button disabled={isEnabling} onClick={enableMemory}>
                                {t`Turn on memory`}
                            </Button>
                        </div>
                    )}

                    {memoryEnabled && !preview && (
                        <>
                            <div className="space-y-1">
                                <span className="text-sm font-medium" id={appLabelId}>{t`1. Which assistant?`}</span>
                                <ToggleGroup
                                    aria-labelledby={appLabelId}
                                    className="flex-wrap"
                                    onValueChange={(value) => {
                                        const next = value?.[0];

                                        if (isImportApp(next)) {
                                            setApp(next);
                                        }
                                    }}
                                    size="sm"
                                    spacing={1}
                                    value={[app]}
                                    variant="outline"
                                >
                                    {IMPORT_APPS.map((option) => (
                                        <ToggleGroupItem key={option} value={option}>
                                            {appLabels[option]}
                                        </ToggleGroupItem>
                                    ))}
                                </ToggleGroup>
                            </div>
                            <div className="space-y-1">
                                <p className="text-sm font-medium">{t`2. Send it this prompt`}</p>
                                <p className="bg-muted rounded-md p-2 text-xs">{prompt}</p>
                                <Button onClick={copyPrompt} size="sm" variant="outline">
                                    <CopyIcon aria-hidden="true" className="mr-1 size-3" />
                                    {t`Copy prompt`}
                                </Button>
                            </div>
                            <div className="space-y-1">
                                <label className="text-sm font-medium" htmlFor={pasteId}>{t`3. Paste its answer`}</label>
                                {/* No `maxLength`: the browser would drop the end of a long paste without a word. Read-only while a
                                    preview runs, so the facts it returns belong to the text on screen. */}
                                <Textarea
                                    aria-describedby={tooLong ? tooLongId : undefined}
                                    aria-invalid={tooLong}
                                    className="min-h-32 text-sm"
                                    id={pasteId}
                                    onChange={(event) => setText(event.target.value)}
                                    readOnly={isPreviewing}
                                    spellCheck={false}
                                    value={text}
                                />
                                {tooLong && (
                                    <p className="text-destructive text-xs" id={tooLongId}>
                                        {t`This is longer than ${maxPasteChars} characters. Paste it in parts and bring in each one.`}
                                    </p>
                                )}
                            </div>
                        </>
                    )}

                    {memoryEnabled && preview && (
                        <div className="space-y-2">
                            <p className="text-sm font-medium outline-none" id={factsHeadingId} tabIndex={-1}>
                                {t`4. Choose what to keep`}
                            </p>
                            <div className="text-muted-foreground space-y-0.5 text-xs" role="status">
                                {preview.dropped > 0 && (
                                    <p>
                                        {plural(preview.dropped, {
                                            one: "# line was left out as not about you or sensitive.",
                                            other: "# lines were left out as not about you or sensitive.",
                                        })}
                                    </p>
                                )}
                                {preview.cut > 0 && (
                                    <p>{plural(preview.cut, { one: "# more line was past the limit.", other: "# more lines were past the limit." })}</p>
                                )}
                            </div>
                            {preview.facts.length === 0 ? (
                                <p className="text-muted-foreground text-sm">{t`No facts found in the pasted text.`}</p>
                            ) : (
                                <ul aria-label={t`Facts to save`} className="max-h-72 space-y-1 overflow-y-auto">
                                    {preview.facts.map((fact, index) => (
                                        <li className="flex min-h-11 items-start gap-2 text-sm" key={`${String(index)}:${fact.memory}`}>
                                            <Checkbox
                                                checked={!unchecked.has(index)}
                                                id={`${pasteId}-fact-${String(index)}`}
                                                onCheckedChange={(checked) => toggleFact(index, checked)}
                                            />
                                            <Label className="font-normal" htmlFor={`${pasteId}-fact-${String(index)}`}>
                                                {fact.memory} <span className="text-muted-foreground text-xs">({typeLabels[fact.type]})</span>
                                            </Label>
                                        </li>
                                    ))}
                                </ul>
                            )}
                        </div>
                    )}
                </DialogPanel>
                {memoryEnabled && (
                    <DialogFooter>
                        {preview ? (
                            <>
                                {/* Not while a save runs: its answer closes the dialog and would drop a newer paste. */}
                                <Button
                                    disabled={isSaving}
                                    onClick={() => {
                                        focusNext.current = pasteId;
                                        setPreview(undefined);
                                    }}
                                    variant="ghost"
                                >
                                    {t`Back`}
                                </Button>
                                <Button disabled={isSaving || kept.length === 0} onClick={() => runSave({ app, facts: kept })}>
                                    {plural(kept.length, { one: "Save # memory", other: "Save # memories" })}
                                </Button>
                            </>
                        ) : (
                            <Button disabled={isEnabling || isPreviewing || tooLong || text.trim().length === 0} onClick={startPreview}>
                                {isPreviewing ? t`Reading…` : t`Preview`}
                            </Button>
                        )}
                    </DialogFooter>
                )}
            </DialogPopup>
        </Dialog>
    );
};

export default MemoryImportDialog;
