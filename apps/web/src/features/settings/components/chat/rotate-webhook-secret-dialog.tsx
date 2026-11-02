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
} from "@neore/ui/components/alert-dialog";
import { Label } from "@neore/ui/components/label";
import type { FC } from "react";
import { useId, useState } from "react";

interface RotateWebhookSecretDialogProperties {
    loading: boolean;
    name: string;
    onConfirm: (keepOldFor24h: boolean) => void;
    onOpenChange: (open: boolean) => void;
    open: boolean;
}

/** Confirms a webhook secret rotation, with the opt-in 24 hour overlap for the old secret. */
const RotateWebhookSecretDialog: FC<RotateWebhookSecretDialogProperties> = ({ loading, name, onConfirm, onOpenChange, open }) => {
    const { t } = useLingui();
    const overlapId = useId();
    const [keepOld, setKeepOld] = useState(false);
    const [wasOpen, setWasOpen] = useState(open);

    // Every opening starts unticked: a successful rotation closes the dialog from the parent, not through onOpenChange.
    if (open !== wasOpen) {
        setWasOpen(open);

        if (open) setKeepOld(false);
    }

    return (
        <AlertDialog
            onOpenChange={(next) => {
                onOpenChange(next);
            }}
            open={open}
        >
            <AlertDialogContent>
                <AlertDialogHeader>
                    <AlertDialogTitle>{t`Rotate the secret of "${name}"?`}</AlertDialogTitle>
                    <AlertDialogDescription>
                        {t`A new secret is shown once. The old secret stops working at once unless you keep it below, so update the sender right after. The webhook URL stays the same.`}
                    </AlertDialogDescription>
                </AlertDialogHeader>
                <div className="flex items-start gap-2">
                    <input checked={keepOld} className="mt-1" id={overlapId} onChange={(event) => setKeepOld(event.target.checked)} type="checkbox" />
                    <Label htmlFor={overlapId}>{t`Keep accepting the old secret for 24 hours`}</Label>
                </div>
                <AlertDialogFooter>
                    <AlertDialogCancel disabled={loading}>{t`Cancel`}</AlertDialogCancel>
                    <AlertDialogAction aria-busy={loading} disabled={loading} onClick={() => onConfirm(keepOld)}>
                        {t`Rotate secret`}
                    </AlertDialogAction>
                </AlertDialogFooter>
            </AlertDialogContent>
        </AlertDialog>
    );
};

export default RotateWebhookSecretDialog;
