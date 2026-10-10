"use client";

import { useLingui } from "@lingui/react/macro";
import {
    AlertDialog,
    AlertDialogAction,
    AlertDialogCancel,
    AlertDialogContent,
    AlertDialogDescription,
    AlertDialogFooter,
    AlertDialogHeader,
    AlertDialogTitle,
} from "@neore/ui/components/responsive-alert-dialog";
import { Loader2 } from "lucide-react";
import type { FC } from "react";

interface DeleteConfirmationDialogProperties {
    description?: string;
    isDeleting?: boolean;
    itemName?: string;
    onConfirm: () => void | Promise<void>;
    onOpenChange: (open: boolean) => void;
    open: boolean;
    title?: string;
}

const DeleteConfirmationDialog: FC<DeleteConfirmationDialogProperties> = ({
    description,
    isDeleting = false,
    itemName,
    onConfirm,
    onOpenChange,
    open,
    title,
}) => {
    const { t } = useLingui();

    const handleConfirm = async () => {
        await onConfirm();
    };

    const defaultTitle = itemName ? t`Delete ${itemName}` : t`Delete`;
    const defaultDescription = itemName
        ? t`Are you sure you want to delete "${itemName}"? This action cannot be undone.`
        : t`Are you sure you want to delete this item? This action cannot be undone.`;

    return (
        <AlertDialog onOpenChange={onOpenChange} open={open}>
            <AlertDialogContent>
                <AlertDialogHeader>
                    <AlertDialogTitle>{title || defaultTitle}</AlertDialogTitle>
                    <AlertDialogDescription>{description || defaultDescription}</AlertDialogDescription>
                </AlertDialogHeader>

                <AlertDialogFooter>
                    <AlertDialogCancel disabled={isDeleting}>{t`Cancel`}</AlertDialogCancel>
                    <AlertDialogAction
                        className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                        disabled={isDeleting}
                        onClick={handleConfirm}
                    >
                        {isDeleting ? (
                            <div className="flex items-center gap-2">
                                <Loader2 className="size-4 animate-spin" />
                                {t`Deleting...`}
                            </div>
                        ) : (
                            t`Delete`
                        )}
                    </AlertDialogAction>
                </AlertDialogFooter>
            </AlertDialogContent>
        </AlertDialog>
    );
};

export default DeleteConfirmationDialog;
