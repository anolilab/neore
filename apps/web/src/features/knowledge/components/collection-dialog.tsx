"use client";

import { useLingui } from "@lingui/react/macro";
import { Button } from "@neore/ui/components/button";
import { Input } from "@neore/ui/components/input";
import { Label } from "@neore/ui/components/label";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogPanel, DialogTitle } from "@neore/ui/components/responsive-dialog";
import { Switch } from "@neore/ui/components/switch";
import { Textarea } from "@neore/ui/components/textarea";
import type { FC, FormEvent } from "react";
import { useId, useState } from "react";

export interface CollectionDraft {
    description: string;
    name: string;
    shareWithOrganization: boolean;
}

interface CollectionDialogProps {
    /** The collection being edited; absent when creating one. */
    initial?: CollectionDraft;
    isSaving: boolean;
    onOpenChange: (open: boolean) => void;
    onSave: (draft: CollectionDraft) => Promise<void>;
    open: boolean;
    /** The active organization's name; sharing is only offered inside one. */
    organizationName?: string;
}

/** Limits mirror `knowledge/collections.ts`, which enforces them. */
const MAX_NAME = 80;
const MAX_DESCRIPTION = 500;

const CollectionDialogBody: FC<Omit<CollectionDialogProps, "open">> = ({ initial, isSaving, onOpenChange, onSave, organizationName }) => {
    const { t } = useLingui();
    const [draft, setDraft] = useState<CollectionDraft>(initial ?? { description: "", name: "", shareWithOrganization: false });
    const nameId = useId();
    const descriptionId = useId();
    const shareId = useId();

    const handleSubmit = async (event: FormEvent) => {
        event.preventDefault();

        if (draft.name.trim()) {
            await onSave({ ...draft, name: draft.name.trim() });
        }
    };

    return (
        <form noValidate onSubmit={handleSubmit}>
            <DialogHeader>
                <DialogTitle>{initial ? t`Edit collection` : t`New collection`}</DialogTitle>
                <DialogDescription>{t`Group knowledge files into a library you can attach to a chat or a project as a whole.`}</DialogDescription>
            </DialogHeader>
            <DialogPanel className="space-y-4">
                <div className="space-y-1.5">
                    <Label htmlFor={nameId}>{t`Name`}</Label>
                    <Input
                        autoFocus
                        id={nameId}
                        maxLength={MAX_NAME}
                        onChange={(event) => setDraft({ ...draft, name: event.target.value })}
                        placeholder={t`e.g. Product handbook`}
                        required
                        value={draft.name}
                    />
                </div>
                <div className="space-y-1.5">
                    <Label htmlFor={descriptionId}>{t`Description`}</Label>
                    <Textarea
                        id={descriptionId}
                        maxLength={MAX_DESCRIPTION}
                        onChange={(event) => setDraft({ ...draft, description: event.target.value })}
                        rows={3}
                        value={draft.description}
                    />
                </div>
                <div className="flex items-start justify-between gap-4">
                    <div className="space-y-0.5">
                        <Label htmlFor={shareId}>{t`Share with organization`}</Label>
                        <p className="text-muted-foreground text-xs">
                            {organizationName
                                ? t`Members of ${organizationName} can attach this collection and the AI can cite it for them. Only you can change it.`
                                : t`Switch to an organization to share a collection with it.`}
                        </p>
                    </div>
                    <Switch
                        checked={draft.shareWithOrganization}
                        disabled={!organizationName}
                        id={shareId}
                        onCheckedChange={(checked) => setDraft({ ...draft, shareWithOrganization: checked })}
                    />
                </div>
            </DialogPanel>
            <DialogFooter>
                <Button onClick={() => onOpenChange(false)} type="button" variant="outline">
                    {t`Cancel`}
                </Button>
                <Button disabled={isSaving || !draft.name.trim()} type="submit">
                    {initial ? t`Save` : t`Create`}
                </Button>
            </DialogFooter>
        </form>
    );
};

const CollectionDialog: FC<CollectionDialogProps> = ({ open, ...props }) => (
    <Dialog onOpenChange={props.onOpenChange} open={open}>
        <DialogContent>
            {/* Mounted per open, so the form starts from `initial` each time. */}
            {open && <CollectionDialogBody {...props} />}
        </DialogContent>
    </Dialog>
);

export default CollectionDialog;
