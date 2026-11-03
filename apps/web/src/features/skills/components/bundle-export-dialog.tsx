"use client";

import { useLingui } from "@lingui/react/macro";
import { api } from "@neore/backend/api";
import type { Id } from "@neore/backend/dataModel";
import { Button } from "@neore/ui/components/button";
import { Checkbox } from "@neore/ui/components/checkbox";
import { Input } from "@neore/ui/components/input";
import { Label } from "@neore/ui/components/label";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogPanel, DialogTitle } from "@neore/ui/components/responsive-dialog";
import { useMutation, useQuery } from "@tanstack/react-query";
import { FileDownIcon, Loader2Icon } from "lucide-react";
import type { FC } from "react";
import { useId, useState } from "react";
import { toast } from "sonner";

import { saveBlob } from "@/lib/download";
import { useCRPC, useLunoraActionOptions } from "@/lib/lunora/crpc";

import { exportedSkillIds } from "../lib/bundle-review";

interface BundleExportDialogProps {
    onClose: () => void;
    open: boolean;
}

interface PickerItem<T extends string> {
    description?: string;
    disabledReason?: string;
    id: T;
    label: string;
}

interface PickerProps<T extends string> {
    emptyLabel: string;
    items: PickerItem<T>[];
    legend: string;
    onToggle: (id: T) => void;
    selected: ReadonlySet<T>;
}

/** A group of checkboxes under a legend. An item that cannot be exported stays listed, unticked, with its reason. */
const Picker = <T extends string>({ emptyLabel, items, legend, onToggle, selected }: PickerProps<T>) => {
    const { t } = useLingui();
    const baseId = useId();

    return (
        <fieldset className="space-y-2">
            <legend className="text-sm font-medium">{legend}</legend>
            {items.length === 0 && <p className="text-muted-foreground text-sm">{emptyLabel}</p>}
            <ul className="space-y-1.5">
                {items.map((item) => {
                    const inputId = `${baseId}-${item.id}`;

                    return (
                        <li className="flex items-start gap-2" key={item.id}>
                            <Checkbox
                                aria-describedby={item.disabledReason ? `${inputId}-reason` : undefined}
                                checked={selected.has(item.id)}
                                className="mt-0.5"
                                disabled={item.disabledReason !== undefined}
                                id={inputId}
                                onCheckedChange={() => onToggle(item.id)}
                            />
                            <div className="min-w-0">
                                <Label className="font-normal" htmlFor={inputId}>
                                    {item.label}
                                </Label>
                                {item.description && <p className="text-muted-foreground line-clamp-1 text-xs">{item.description}</p>}
                                {item.disabledReason && (
                                    <p className="text-muted-foreground text-xs" id={`${inputId}-reason`}>
                                        {t`Cannot be exported: ${item.disabledReason}`}
                                    </p>
                                )}
                            </div>
                        </li>
                    );
                })}
            </ul>
        </fieldset>
    );
};

const toggled = <T extends string>(set: ReadonlySet<T>, id: T): Set<T> => {
    const next = new Set(set);

    if (!next.delete(id)) {
        next.add(id);
    }

    return next;
};

const errorText = (error: unknown, fallback: string): string => (error instanceof Error && error.message ? error.message : fallback);

/**
 * Pick skills, schedules / webhooks and group chats of your own and download
 * them as one Markdown file. Secrets are never in it: the server builds the file
 * from a whitelist of fields (docs/skills.mdx, "Share a bundle").
 */
const BundleExportDialogBody: FC<Omit<BundleExportDialogProps, "open">> = ({ onClose }) => {
    const { t } = useLingui();
    const crpc = useCRPC();
    const nameId = useId();
    const descriptionId = useId();
    const { data: candidates, isPending: isLoading } = useQuery(crpc.skills.bundle.listBundleCandidates.queryOptions({}, { live: false }));
    const { isPending: isExporting, mutateAsync: exportBundle } = useMutation(useLunoraActionOptions(api.skills.bundle.exportBundle));
    const [name, setName] = useState("");
    const [description, setDescription] = useState("");
    const [skills, setSkills] = useState<ReadonlySet<Id<"skills">>>(new Set());
    const [triggers, setTriggers] = useState<ReadonlySet<Id<"triggers">>>(new Set());
    const [groups, setGroups] = useState<ReadonlySet<Id<"threads">>>(new Set());

    const limits = candidates?.limits;
    const skillCount = candidates
        ? exportedSkillIds(
              skills,
              groups,
              candidates.groupChats.map((group) => {
                  return { id: group.id, participantSkillIds: group.participantSkillIds };
              }),
          ).size
        : 0;
    const overLimit = !!limits && (skillCount > limits.skills || triggers.size > limits.triggers || groups.size > limits.groupChats);
    const nothingPicked = skills.size + triggers.size + groups.size === 0;

    const handleExport = async () => {
        try {
            const result = await exportBundle({
                description: description.trim() || undefined,
                groupChatIds: [...groups],
                name: name.trim() || t`Team bundle`,
                skillIds: [...skills],
                triggerIds: [...triggers],
            });

            saveBlob(new Blob([result.markdown], { type: "text/markdown;charset=utf-8" }), result.filename);
            toast.success(t`Exported ${result.itemCount} items`);
            onClose();
        } catch (error) {
            toast.error(errorText(error, t`The bundle could not be exported.`));
        }
    };

    return (
        <>
            <DialogHeader>
                <DialogTitle>{t`Export a bundle`}</DialogTitle>
                <DialogDescription>
                    {t`Pick skills, schedules, webhooks and group chats to share as one Markdown file. API keys, webhook secrets, connector tokens and other credentials are never included, and neither are your account or organization ids.`}
                </DialogDescription>
            </DialogHeader>
            <DialogPanel className="space-y-5">
                <div className="grid gap-3 sm:grid-cols-2">
                    <div className="space-y-1.5">
                        <Label htmlFor={nameId}>{t`Bundle name`}</Label>
                        <Input id={nameId} maxLength={100} onChange={(event) => setName(event.target.value)} placeholder={t`Team bundle`} value={name} />
                    </div>
                    <div className="space-y-1.5">
                        <Label htmlFor={descriptionId}>{t`Description (optional)`}</Label>
                        <Input id={descriptionId} maxLength={1000} onChange={(event) => setDescription(event.target.value)} value={description} />
                    </div>
                </div>
                {isLoading && (
                    <p className="text-muted-foreground flex items-center gap-2 text-sm" role="status">
                        <Loader2Icon aria-hidden="true" className="size-4 animate-spin" />
                        {t`Loading your items…`}
                    </p>
                )}
                {candidates && (
                    <>
                        <Picker
                            emptyLabel={t`You have no skills of your own yet.`}
                            items={candidates.skills.map((skill) => {
                                return { description: skill.description, id: skill.id, label: `${skill.name} (/${skill.slug})` };
                            })}
                            legend={t`Skills`}
                            onToggle={(id) => setSkills((current) => toggled(current, id))}
                            selected={skills}
                        />
                        <Picker
                            emptyLabel={t`You have no schedules or webhooks.`}
                            items={candidates.triggers.map((trigger) => {
                                return {
                                    description: trigger.type === "schedule" ? t`Schedule ${trigger.schedule ?? ""}` : t`Webhook`,
                                    disabledReason: trigger.exportable ? undefined : trigger.reason,
                                    id: trigger.id,
                                    label: trigger.name,
                                };
                            })}
                            legend={t`Schedules and webhooks`}
                            onToggle={(id) => setTriggers((current) => toggled(current, id))}
                            selected={triggers}
                        />
                        <Picker
                            emptyLabel={t`You have no group chats.`}
                            items={candidates.groupChats.map((group) => {
                                return {
                                    description: t`${group.mode}, ${group.participantSkillIds.length} participants. Its participants are included as skills.`,
                                    disabledReason: group.exportable ? undefined : group.reason,
                                    id: group.id,
                                    label: group.title,
                                };
                            })}
                            legend={t`Group chats`}
                            onToggle={(id) => setGroups((current) => toggled(current, id))}
                            selected={groups}
                        />
                    </>
                )}
                {limits && (
                    <p aria-live="polite" className={overLimit ? "text-destructive text-sm" : "text-muted-foreground text-xs"} role="status">
                        {t`In the file: ${skillCount} of ${limits.skills} skills, ${triggers.size} of ${limits.triggers} schedules and webhooks, ${groups.size} of ${limits.groupChats} group chats.`}
                    </p>
                )}
            </DialogPanel>
            <DialogFooter>
                <Button onClick={onClose} type="button" variant="outline">
                    {t`Cancel`}
                </Button>
                <Button disabled={nothingPicked || overLimit || isExporting} onClick={handleExport} type="button">
                    {isExporting ? (
                        <Loader2Icon aria-hidden="true" className="mr-2 size-4 animate-spin" />
                    ) : (
                        <FileDownIcon aria-hidden="true" className="mr-2 size-4" />
                    )}
                    {t`Download`}
                </Button>
            </DialogFooter>
        </>
    );
};

const BundleExportDialog: FC<BundleExportDialogProps> = ({ open, ...props }) => (
    <Dialog onOpenChange={(next) => !next && props.onClose()} open={open}>
        <DialogContent className="sm:max-w-2xl">{open && <BundleExportDialogBody {...props} />}</DialogContent>
    </Dialog>
);

export default BundleExportDialog;
