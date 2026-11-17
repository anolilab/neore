"use client";

import { useLingui } from "@lingui/react/macro";
import { api } from "@neore/backend/api";
import { Button } from "@neore/ui/components/button";
import { Checkbox } from "@neore/ui/components/checkbox";
import { Dialog, DialogDescription, DialogFooter, DialogHeader, DialogPanel, DialogPopup, DialogTitle, DialogTrigger } from "@neore/ui/components/dialog";
import { Textarea } from "@neore/ui/components/textarea";
import { ToggleGroup, ToggleGroupItem } from "@neore/ui/components/toggle-group";
import { useMutation } from "@tanstack/react-query";
import { CopyIcon, DownloadIcon } from "lucide-react";
import type { FC } from "react";
import { useId, useState } from "react";
import { toast } from "sonner";

import { useLunoraActionOptions } from "@/lib/lunora/crpc";

import type { MemoryType } from "./memory-types";
import { useMemoryTypeLabels } from "./memory-types";

export const IMPORT_APPS = ["chatgpt", "claude", "gemini", "other"] as const;

export type ImportApp = (typeof IMPORT_APPS)[number];

export const isImportApp = (value: unknown): value is ImportApp => typeof value === "string" && (IMPORT_APPS as ReadonlyArray<string>).includes(value);

/** Mirrors `IMPORT_MAX_INPUT_CHARS` in `backend/lunora/memory/import-logic.ts`. */
const MAX_PASTE_CHARS = 20_000;

/** Product names stay untranslated; "other" is the only label that needs a translation. */
export const useImportAppLabels = (): Record<ImportApp, string> => {
    const { t } = useLingui();

    return { chatgpt: "ChatGPT", claude: "Claude", gemini: "Gemini", other: t`Another assistant` };
};

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
    const { t } = useLingui();
    const appLabels = useImportAppLabels();
    const typeLabels = useMemoryTypeLabels();
    const appLabelId = useId();
    const pasteId = useId();
    const [open, setOpen] = useState(false);
    const [app, setApp] = useState<ImportApp>("chatgpt");
    const [text, setText] = useState("");
    const [preview, setPreview] = useState<Preview | undefined>(undefined);
    const [unchecked, setUnchecked] = useState<ReadonlySet<number>>(new Set());

    const prompt = t`List everything you remember about me from our past conversations and your saved memory. Write one fact per line, in the third person, starting with "The user" (for example: "The user works as a nurse in Hamburg."). Where you know when you learned a fact, add the date in brackets at the end of its line. Leave out passwords, keys, account numbers and health details. Write no introduction, headings or comments.`;

    const { isPending: isPreviewing, mutate: runPreview } = useMutation({
        ...useLunoraActionOptions(api.memory.import.previewMemoryImport),
        onError: (error: Error) => {
            toast.error(t`Could not read the pasted list`, { description: error.message });
        },
        onSuccess: (result: Preview) => {
            setUnchecked(new Set());
            setPreview(result);
        },
    });

    const { isPending: isSaving, mutate: runSave } = useMutation({
        ...useLunoraActionOptions(api.memory.import.saveImportedMemories),
        onError: (error: Error) => {
            toast.error(t`Could not save the memories`, { description: error.message });
        },
        onSuccess: (result: { added: number; alreadyKnown: number; updated: number }) => {
            toast.success(t`Saved ${result.added} new memories, updated ${result.updated}, ${result.alreadyKnown} already known`);
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

    return (
        <Dialog onOpenChange={setOpen} open={open}>
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
                            <Button onClick={onEnableMemory}>{t`Turn on memory`}</Button>
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
                                <Textarea
                                    className="min-h-32 text-sm"
                                    id={pasteId}
                                    maxLength={MAX_PASTE_CHARS}
                                    onChange={(event) => setText(event.target.value)}
                                    spellCheck={false}
                                    value={text}
                                />
                            </div>
                        </>
                    )}

                    {memoryEnabled && preview && (
                        <div className="space-y-2">
                            <p className="text-sm font-medium">{t`4. Choose what to keep`}</p>
                            {(preview.dropped > 0 || preview.cut > 0) && (
                                <p className="text-muted-foreground text-xs" role="status">
                                    {t`${preview.dropped} lines were left out as not about you or sensitive; ${preview.cut} more were past the limit.`}
                                </p>
                            )}
                            {preview.facts.length === 0 ? (
                                <p className="text-muted-foreground text-sm">{t`No facts found in the pasted text.`}</p>
                            ) : (
                                <ul aria-label={t`Facts to save`} className="max-h-72 space-y-1 overflow-y-auto">
                                    {preview.facts.map((fact, index) => (
                                        <li className="flex items-start gap-2 text-sm" key={`${String(index)}:${fact.memory}`}>
                                            <Checkbox
                                                aria-label={`${fact.memory} (${typeLabels[fact.type]})`}
                                                checked={!unchecked.has(index)}
                                                onCheckedChange={(checked) => toggleFact(index, checked)}
                                            />
                                            <span aria-hidden="true">
                                                {fact.memory} <span className="text-muted-foreground text-xs">({typeLabels[fact.type]})</span>
                                            </span>
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
                                <Button onClick={() => setPreview(undefined)} variant="ghost">{t`Back`}</Button>
                                <Button disabled={isSaving || kept.length === 0} onClick={() => runSave({ app, facts: kept })}>
                                    {t`Save ${kept.length} memories`}
                                </Button>
                            </>
                        ) : (
                            <Button disabled={isPreviewing || text.trim().length === 0} onClick={() => runPreview({ text })}>
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
