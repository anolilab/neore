"use client";

import { useLingui } from "@lingui/react/macro";
import { api } from "@neore/backend/api";
import { Alert, AlertDescription, AlertTitle } from "@neore/ui/components/alert";
import { Button } from "@neore/ui/components/button";
import { Checkbox } from "@neore/ui/components/checkbox";
import { Label } from "@neore/ui/components/label";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogPanel, DialogTitle } from "@neore/ui/components/responsive-dialog";
import { useMutation } from "@tanstack/react-query";
import { CopyIcon, FileUpIcon, Loader2Icon, ShieldAlertIcon } from "lucide-react";
import type { ChangeEvent, FC } from "react";
import { useId, useRef, useState } from "react";
import { toast } from "sonner";

import { useLunoraActionOptions } from "@/lib/lunora/crpc";

import type { BundleReviewEntry } from "../lib/bundle-review";
import { defaultSelection, fitsSkillSlots, selectedCount, toggleSelection } from "../lib/bundle-review";

/** The server's cap on a bundle file (`BUNDLE_LIMITS.bytes`); a bigger file is refused before it is sent. */
const MAX_BUNDLE_BYTES = 512 * 1024;

interface BundleImportDialogProps {
    onClose: () => void;
    onImported: () => void;
    open: boolean;
}

interface Review {
    description: string;
    entries: BundleReviewEntry[];
    name: string;
    skillSlotsLeft: number | null;
}

interface Imported {
    items: { id: string; key: string; kind: "group" | "skill" | "trigger"; title: string; webhookSecret?: string }[];
    warnings: string[];
}

const errorText = (error: unknown, fallback: string): string => (error instanceof Error && error.message ? error.message : fallback);

const useKindLabel = (): ((kind: "group" | "skill" | "trigger") => string) => {
    const { t } = useLingui();

    return (kind) => {
        if (kind === "group") {
            return t`Group chat`;
        }

        return kind === "skill" ? t`Skill` : t`Schedule or webhook`;
    };
};

const List: FC<{ items: string[]; label: string; tone?: "warning" }> = ({ items, label, tone }) => (
    <p className={tone === "warning" ? "text-xs text-amber-600 dark:text-amber-400" : "text-muted-foreground text-xs"}>
        <span className="font-medium">{label}</span> {items.join(", ")}
    </p>
);

/** What importing one item will do, in the words of the person reading it. */
const EntryDetails: FC<{ entry: BundleReviewEntry }> = ({ entry }) => {
    const { t } = useLingui();
    const { group, skill, trigger } = entry;

    return (
        <div className="space-y-0.5">
            {skill && (
                <>
                    <p className="text-muted-foreground line-clamp-2 text-xs">{skill.description}</p>
                    {skill.tools.length > 0 ? (
                        <List items={skill.tools} label={t`Adds these tools:`} />
                    ) : (
                        <p className="text-muted-foreground text-xs">{t`Adds no tools.`}</p>
                    )}
                    {skill.disabledTools.length > 0 && <List items={skill.disabledTools} label={t`Turns these tools off:`} />}
                    {skill.droppedTools.length > 0 && <List items={skill.droppedTools} label={t`Ignored, not available here:`} tone="warning" />}
                    {skill.model && <p className="text-muted-foreground text-xs">{t`Prefers the model ${skill.model}.`}</p>}
                    <p className="text-muted-foreground text-xs">{t`Imported as /${skill.slug}.`}</p>
                </>
            )}
            {trigger?.type === "schedule" && (
                <>
                    <p className="text-muted-foreground text-xs">
                        {t`Runs on the schedule ${trigger.schedule ?? ""}${trigger.timezone ? ` (${trigger.timezone})` : " (UTC)"}, on ${trigger.model}.`}
                    </p>
                    {trigger.nextRunAt !== undefined && (
                        <p className="text-muted-foreground text-xs">{t`If you turn it on, the next run is ${new Date(trigger.nextRunAt).toLocaleString()}.`}</p>
                    )}
                </>
            )}
            {trigger?.type === "webhook" && (
                <>
                    <p className="text-muted-foreground text-xs">{t`Runs when a webhook is received, on ${trigger.model}. You get a new signing secret and URL for it.`}</p>
                    {trigger.filters.length > 0 && <List items={trigger.filters} label={t`Only when:`} />}
                </>
            )}
            {trigger?.task && <p className="text-muted-foreground line-clamp-3 text-xs whitespace-pre-wrap">{t`Task: ${trigger.task}`}</p>}
            {trigger?.systemPrompt && (
                <p className="text-muted-foreground line-clamp-3 text-xs whitespace-pre-wrap">{t`Instructions: ${trigger.systemPrompt}`}</p>
            )}
            {trigger && <p className="text-muted-foreground text-xs">{t`Created switched off.`}</p>}
            {group && (
                <>
                    <p className="text-muted-foreground text-xs">{t`Mode ${group.mode}, on ${group.model}. Nothing starts when it is created.`}</p>
                    <List items={group.participants} label={t`Participants:`} />
                </>
            )}
            {entry.problems.map((problem) => (
                <p className="text-destructive text-xs" key={problem}>
                    {problem}
                </p>
            ))}
            {entry.warnings.map((warning) => (
                <p className="text-xs text-amber-600 dark:text-amber-400" key={warning}>
                    {warning}
                </p>
            ))}
        </div>
    );
};

const WebhookSecret: FC<{ secret: string; title: string }> = ({ secret, title }) => {
    const { t } = useLingui();

    const handleCopy = async () => {
        try {
            await navigator.clipboard.writeText(secret);
            toast.success(t`Webhook secret copied to clipboard`);
        } catch {
            toast.error(t`Could not copy the secret. Select it and copy it manually.`);
        }
    };

    return (
        <div className="space-y-1 rounded-md border border-amber-500/50 p-3">
            <p className="text-sm font-medium">{t`Webhook secret for "${title}"`}</p>
            <p className="text-muted-foreground text-xs">{t`Copy this secret now and store it with your webhook sender. It will not be shown again.`}</p>
            <div className="flex items-center gap-2">
                <code className="bg-muted min-w-0 flex-1 truncate rounded px-2 py-1 font-mono text-xs select-all">{secret}</code>
                <Button
                    onClick={() => {
                        void handleCopy();
                    }}
                    size="sm"
                    type="button"
                    variant="outline"
                >
                    <CopyIcon aria-hidden="true" className="mr-1.5 size-3" />
                    {t`Copy`}
                </Button>
            </div>
        </div>
    );
};

const ImportResult: FC<{ done: Imported; onClose: () => void }> = ({ done, onClose }) => {
    const { t } = useLingui();
    const kindLabel = useKindLabel();

    const secrets = done.items.filter((item) => item.webhookSecret !== undefined);

    return (
        <>
            <DialogHeader>
                <DialogTitle>{t`Bundle imported`}</DialogTitle>
                <DialogDescription>{t`${done.items.length} items were created. Schedules and webhooks are switched off; turn each one on when you are ready.`}</DialogDescription>
            </DialogHeader>
            <DialogPanel className="space-y-3">
                <ul className="space-y-1 text-sm">
                    {done.items.map((item) => (
                        <li key={item.key}>
                            <span className="text-muted-foreground text-xs">{kindLabel(item.kind)}: </span>
                            {item.title}
                        </li>
                    ))}
                </ul>
                {secrets.map((item) => (
                    <WebhookSecret key={item.key} secret={item.webhookSecret!} title={item.title} />
                ))}
                {done.warnings.length > 0 && (
                    <ul className="space-y-0.5 text-xs text-amber-600 dark:text-amber-400">
                        {done.warnings.map((warning) => (
                            <li key={warning}>{warning}</li>
                        ))}
                    </ul>
                )}
            </DialogPanel>
            <DialogFooter>
                <Button onClick={onClose} type="button">
                    {t`Done`}
                </Button>
            </DialogFooter>
        </>
    );
};

/**
 * Import a bundle someone sent: upload → the server parses and dry-runs it →
 * a REVIEW screen lists every item and what it will do → the user picks what
 * to import → the result, with the signing secret of each new webhook (shown
 * once). The review is the safety boundary: nothing runs until the user turns
 * it on, and the server re-checks all of it on import.
 */
const BundleImportDialogBody: FC<Omit<BundleImportDialogProps, "open">> = ({ onClose, onImported }) => {
    const { t } = useLingui();
    const kindLabel = useKindLabel();
    const fileInput = useRef<HTMLInputElement>(null);
    const headingId = useId();
    const [markdown, setMarkdown] = useState("");
    const [filename, setFilename] = useState("");
    const [review, setReview] = useState<Review | null>(null);
    const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
    const [done, setDone] = useState<Imported | null>(null);
    const [error, setError] = useState<string | null>(null);
    const { isPending: isReading, mutateAsync: previewBundle } = useMutation(useLunoraActionOptions(api.skills.bundle.previewBundle));
    const { isPending: isImporting, mutateAsync: importBundle } = useMutation(useLunoraActionOptions(api.skills.bundle.importBundle));

    if (done) {
        return <ImportResult done={done} onClose={onClose} />;
    }

    const handleFile = async (event: ChangeEvent<HTMLInputElement>) => {
        const input = event.target;
        const file = input.files?.[0];

        input.value = "";

        if (!file) {
            return;
        }

        setError(null);
        setReview(null);

        if (file.size > MAX_BUNDLE_BYTES) {
            setError(t`The file is larger than ${MAX_BUNDLE_BYTES / 1024} KB, which is more than a bundle can be.`);

            return;
        }

        try {
            const text = await file.text();
            const next = await previewBundle({ markdown: text });

            setMarkdown(text);
            setFilename(file.name);
            setReview(next);
            setSelected(defaultSelection(next.entries));
        } catch (error_) {
            setError(errorText(error_, t`This file could not be read as a bundle.`));
        }
    };

    const handleImport = async () => {
        try {
            const result = await importBundle({ markdown, selected: [...selected] });

            setDone(result);
            onImported();
        } catch (error_) {
            setError(errorText(error_, t`The bundle could not be imported.`));
        }
    };

    const entries = review?.entries ?? [];
    const fitsSlots = fitsSkillSlots(selected, entries, review?.skillSlotsLeft ?? null);
    const canImport = !!review && selected.size > 0 && fitsSlots && !isImporting;

    return (
        <>
            <DialogHeader>
                <DialogTitle>{t`Import a bundle`}</DialogTitle>
                <DialogDescription>{t`Upload a bundle file (.md). You will see everything in it and choose what to import; nothing is created until you confirm.`}</DialogDescription>
            </DialogHeader>
            <DialogPanel className="space-y-4">
                <div className="flex items-center gap-2">
                    <Button disabled={isReading} onClick={() => fileInput.current?.click()} type="button" variant="outline">
                        {isReading ? (
                            <Loader2Icon aria-hidden="true" className="mr-2 size-4 animate-spin" />
                        ) : (
                            <FileUpIcon aria-hidden="true" className="mr-2 size-4" />
                        )}
                        {t`Choose bundle file`}
                    </Button>
                    {filename && <span className="text-muted-foreground truncate text-xs">{filename}</span>}
                    <input
                        accept=".md,.markdown,text/markdown"
                        aria-hidden="true"
                        className="hidden"
                        onChange={handleFile}
                        ref={fileInput}
                        tabIndex={-1}
                        type="file"
                    />
                </div>
                <div aria-live="polite" role="status">
                    {error && <p className="text-destructive text-sm">{error}</p>}
                </div>
                {review && (
                    <section aria-labelledby={headingId} className="space-y-3">
                        <Alert>
                            <ShieldAlertIcon aria-hidden="true" />
                            <AlertTitle>{t`This bundle came from someone else`}</AlertTitle>
                            <AlertDescription>
                                {t`Read each item below before you import it. Nothing in the bundle runs until you turn it on: schedules and webhooks are created switched off, group chats are created without starting anything, and skills only run when you use them. A skill adds the tools listed for it, and your own tool permissions still apply.`}
                            </AlertDescription>
                        </Alert>
                        <div>
                            <h3 className="text-sm font-medium" id={headingId}>
                                {review.name}
                            </h3>
                            {review.description && <p className="text-muted-foreground text-xs">{review.description}</p>}
                        </div>
                        {review.entries.length === 0 && <p className="text-muted-foreground text-sm">{t`This bundle has no items.`}</p>}
                        <ul className="space-y-3">
                            {review.entries.map((entry) => {
                                const inputId = `${headingId}-${entry.key}`;
                                const blocked = entry.problems.length > 0;

                                return (
                                    <li className="flex items-start gap-2 rounded-md border p-3" key={entry.key}>
                                        <Checkbox
                                            checked={selected.has(entry.key)}
                                            className="mt-0.5"
                                            disabled={blocked}
                                            id={inputId}
                                            onCheckedChange={() => setSelected((current) => toggleSelection(current, entry.key, entries))}
                                        />
                                        <div className="min-w-0 flex-1 space-y-0.5">
                                            <Label className="font-medium" htmlFor={inputId}>
                                                {entry.title}
                                                <span className="text-muted-foreground ml-2 text-xs font-normal">{kindLabel(entry.kind)}</span>
                                            </Label>
                                            <EntryDetails entry={entry} />
                                        </div>
                                    </li>
                                );
                            })}
                        </ul>
                        {!fitsSlots && (
                            <p className="text-destructive text-sm" role="status">
                                {t`You can add ${review.skillSlotsLeft ?? 0} more skills on this plan. Untick some skills or upgrade.`}
                            </p>
                        )}
                    </section>
                )}
            </DialogPanel>
            <DialogFooter>
                <Button onClick={onClose} type="button" variant="outline">
                    {t`Cancel`}
                </Button>
                <Button disabled={!canImport} onClick={handleImport} type="button">
                    {isImporting && <Loader2Icon aria-hidden="true" className="mr-2 size-4 animate-spin" />}
                    {t`Import ${selectedCount(selected, entries)} items`}
                </Button>
            </DialogFooter>
        </>
    );
};

const BundleImportDialog: FC<BundleImportDialogProps> = ({ open, ...props }) => (
    <Dialog onOpenChange={(next) => !next && props.onClose()} open={open}>
        <DialogContent className="sm:max-w-2xl">{open && <BundleImportDialogBody {...props} />}</DialogContent>
    </Dialog>
);

export default BundleImportDialog;
