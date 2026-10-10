"use client";

import { useLingui } from "@lingui/react/macro";
import { Button } from "@neore/ui/components/button";
import { Input } from "@neore/ui/components/input";
import { Label } from "@neore/ui/components/label";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogPanel, DialogTitle } from "@neore/ui/components/responsive-dialog";
import { GitBranch } from "lucide-react";
import type { FC } from "react";
import { useState } from "react";

interface ForkBranchDialogProps {
    onCancel: () => void;
    onCreate: (title: string) => Promise<void>;
    open: boolean;
}

const ForkBranchDialog: FC<ForkBranchDialogProps> = ({ onCancel, onCreate, open }) => {
    const { t } = useLingui();
    const [title, setTitle] = useState("");
    const [isCreating, setIsCreating] = useState(false);

    // Reset title when dialog opens. Adjusted during render rather than in an
    // effect so the reset lands in the same commit that opens the dialog.
    const [wasOpen, setWasOpen] = useState<boolean | undefined>(undefined);

    if (open !== wasOpen) {
        setWasOpen(open);

        if (open) {
            setTitle("");
            setIsCreating(false);
        }
    }

    const handleCreate = async () => {
        if (isCreating) {
            return;
        }

        setIsCreating(true);

        const branchTitle = title.trim() || t`New Branch`;

        try {
            await onCreate(branchTitle);
        } catch (error) {
            console.error("Failed to create branch:", error);
        } finally {
            setIsCreating(false);
        }
    };

    const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
        if (e.key !== "Enter" || e.shiftKey) {
            return;
        }

        e.preventDefault();
        handleCreate();
    };

    return (
        <Dialog onOpenChange={(isOpen) => !isOpen && !isCreating && onCancel()} open={open}>
            <DialogContent className="max-w-md">
                <DialogHeader>
                    <DialogTitle className="flex items-center gap-2">
                        <GitBranch className="size-5" />
                        {t`Fork Conversation`}
                    </DialogTitle>
                    <DialogDescription>{t`Create a new branch from this message. Give it a name to help you identify it later.`}</DialogDescription>
                </DialogHeader>

                <DialogPanel>
                    <div className="space-y-2">
                        <Label htmlFor="branch-title">{t`Branch Title`}</Label>
                        <Input
                            autoFocus
                            disabled={isCreating}
                            id="branch-title"
                            onChange={(e) => setTitle(e.target.value)}
                            onKeyDown={handleKeyDown}
                            placeholder={t`Enter branch title (optional)`}
                            value={title}
                        />
                    </div>
                </DialogPanel>

                <DialogFooter>
                    <Button disabled={isCreating} onClick={onCancel} variant="outline">
                        {t`Cancel`}
                    </Button>
                    <Button disabled={isCreating} onClick={handleCreate}>
                        {isCreating ? t`Creating...` : t`Create Branch`}
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
};

export default ForkBranchDialog;
