import { useLingui } from "@lingui/react/macro";
import * as React from "react";

import {
    AlertDialog,
    AlertDialogAction,
    AlertDialogCancel,
    AlertDialogContent,
    AlertDialogDescription,
    AlertDialogFooter,
    AlertDialogHeader,
    AlertDialogTitle,
} from "./alert-dialog";

interface ConfirmDialogProperties {
    cancelLabel?: string;
    confirmLabel?: string;
    description?: string;
    loading?: boolean;
    onConfirm: () => void;
    onOpenChange: (open: boolean) => void;
    open: boolean;
    title: string;
}

const ConfirmDialog: React.FC<ConfirmDialogProperties> = ({ cancelLabel, confirmLabel, description, loading, onConfirm, onOpenChange, open, title }) => {
    const { t } = useLingui();
    const resolvedCancelLabel = cancelLabel ?? t`Cancel`;
    const resolvedConfirmLabel = confirmLabel ?? t`Confirm`;

    return (
        <AlertDialog onOpenChange={onOpenChange} open={open}>
            <AlertDialogContent>
                <AlertDialogHeader>
                    <AlertDialogTitle>{title}</AlertDialogTitle>
                    {description && <AlertDialogDescription>{description}</AlertDialogDescription>}
                </AlertDialogHeader>
                <AlertDialogFooter>
                    <AlertDialogCancel disabled={loading}>{resolvedCancelLabel}</AlertDialogCancel>
                    <AlertDialogAction aria-busy={loading} disabled={loading} onClick={onConfirm}>
                        {resolvedConfirmLabel}
                    </AlertDialogAction>
                </AlertDialogFooter>
            </AlertDialogContent>
        </AlertDialog>
    );
};

export default ConfirmDialog;
