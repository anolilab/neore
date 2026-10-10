"use client";

import { msg } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";
import type { Id } from "@neore/backend/dataModel";
import { Button } from "@neore/ui/components/button";
import { Label } from "@neore/ui/components/label";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@neore/ui/components/responsive-dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@neore/ui/components/select";
import { Textarea } from "@neore/ui/components/textarea";
import { Loader2 } from "lucide-react";
import { useState } from "react";

import { showError, showSuccess } from "@/lib/toast";

import { useBanUser, useUnbanUser } from "../hooks/use-admin";

interface BanUserDialogProps {
    isBanned: boolean;
    onOpenChange: (open: boolean) => void;
    onSuccess?: () => void;
    open: boolean;
    userId: Id<"user">;
    userName: string;
}

const BAN_DURATIONS = [
    { label: msg`1 hour`, value: 3600 },
    { label: msg`24 hours`, value: 86_400 },
    { label: msg`7 days`, value: 604_800 },
    { label: msg`30 days`, value: 2_592_000 },
    { label: msg`Permanent`, value: 0 },
];

const BanUserDialog = ({ isBanned, onOpenChange, onSuccess, open, userId, userName }: BanUserDialogProps) => {
    const { i18n, t } = useLingui();

    const banUser = useBanUser();
    const unbanUser = useUnbanUser();

    const [reason, setReason] = useState("");
    const [duration, setDuration] = useState<string>("86400");

    const handleBan = async () => {
        try {
            // `duration` only ever holds a Select value from BAN_DURATIONS, so the
            // radix parse and a plain coercion agree.
            const durationSeconds = Math.trunc(Number(duration));

            await banUser.mutateAsync({
                banExpiresIn: durationSeconds > 0 ? durationSeconds : undefined,
                banReason: reason || undefined,
                userId,
            });

            showSuccess(t`User has been banned`);

            onOpenChange(false);
            setReason("");
            setDuration("86400");
            onSuccess?.();
        } catch (error: any) {
            showError(error.message || t`Failed to ban user`);
        }
    };

    const handleUnban = async () => {
        try {
            await unbanUser.mutateAsync({
                userId,
            });

            showSuccess(t`User has been unbanned`);

            onOpenChange(false);
            onSuccess?.();
        } catch (error: any) {
            showError(error.message || t`Failed to unban user`);
        }
    };

    const isPending = banUser.isPending || unbanUser.isPending;

    if (isBanned) {
        return (
            <Dialog onOpenChange={onOpenChange} open={open}>
                <DialogContent>
                    <DialogHeader>
                        <DialogTitle>{t`Unban User`}</DialogTitle>
                        <DialogDescription>{t`Are you sure you want to unban ${userName}? They will regain access to the platform.`}</DialogDescription>
                    </DialogHeader>

                    <DialogFooter>
                        <Button disabled={isPending} onClick={() => onOpenChange(false)} variant="outline">
                            {t`Cancel`}
                        </Button>
                        <Button disabled={isPending} onClick={handleUnban}>
                            {isPending && <Loader2 className="mr-2 size-4 animate-spin" />}
                            {t`Unban User`}
                        </Button>
                    </DialogFooter>
                </DialogContent>
            </Dialog>
        );
    }

    return (
        <Dialog onOpenChange={onOpenChange} open={open}>
            <DialogContent>
                <DialogHeader>
                    <DialogTitle>{t`Ban User`}</DialogTitle>
                    <DialogDescription>{t`Ban ${userName} from accessing the platform. They will not be able to sign in until unbanned.`}</DialogDescription>
                </DialogHeader>

                <div className="grid gap-4 py-4">
                    <div className="grid gap-2">
                        <Label htmlFor="duration">{t`Duration`}</Label>
                        <Select onValueChange={(value) => value && setDuration(value)} value={duration}>
                            <SelectTrigger>
                                <SelectValue placeholder={t`Select duration`} />
                            </SelectTrigger>
                            <SelectContent>
                                {BAN_DURATIONS.map((d) => (
                                    <SelectItem key={d.value} value={String(d.value)}>
                                        {i18n._(d.label)}
                                    </SelectItem>
                                ))}
                            </SelectContent>
                        </Select>
                    </div>

                    <div className="grid gap-2">
                        <Label htmlFor="reason">{t`Reason (optional)`}</Label>
                        <Textarea
                            id="reason"
                            onChange={(e) => setReason(e.target.value)}
                            placeholder={t`Enter a reason for the ban...`}
                            rows={3}
                            value={reason}
                        />
                    </div>
                </div>

                <DialogFooter>
                    <Button disabled={isPending} onClick={() => onOpenChange(false)} variant="outline">
                        {t`Cancel`}
                    </Button>
                    <Button disabled={isPending} onClick={handleBan} variant="destructive">
                        {isPending && <Loader2 className="mr-2 size-4 animate-spin" />}
                        {t`Ban User`}
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
};

export default BanUserDialog;
