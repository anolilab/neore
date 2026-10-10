"use client";

import { Field } from "@base-ui/react/field";
import { useLingui } from "@lingui/react/macro";
import { Button } from "@neore/ui/components/button";
import { Input } from "@neore/ui/components/input";
import { Label } from "@neore/ui/components/label";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@neore/ui/components/responsive-dialog";
import cn from "@neore/ui/utils/cn";
import type { ComponentProps } from "react";
import { useState } from "react";

import { useSession } from "@/features/auth/hooks/session-user-management";
import { useAuth } from "@/features/auth/lib/auth-ui-provider";
import { getLocalizedError } from "@/features/auth/lib/utilities";

import type { SettingsCardClassNames } from "./settings-card";

interface SessionFreshnessDialogProperties extends ComponentProps<typeof Dialog> {
    classNames?: SettingsCardClassNames;

    onVerified?: () => void;
}

const SessionFreshnessDialog = ({ classNames, onOpenChange, onVerified, ...properties }: SessionFreshnessDialogProperties) => {
    const { authClient } = useAuth();
    const { data: sessionData } = useSession(authClient);
    const userEmail = sessionData?.user?.email;

    const [password, setPassword] = useState("");
    const [isPending, setIsPending] = useState(false);
    const [error, setError] = useState("");
    const { t } = useLingui();

    const handleSubmit = async (e: React.FormEvent) => {
        e.preventDefault();

        if (!password.trim()) {
            return;
        }

        if (!userEmail) {
            setError(t`No active session found. Please sign in again.`);

            return;
        }

        setIsPending(true);
        setError("");

        try {
            // Re-authenticate by signing in with the current account's email and the
            // entered password. Better Auth issues a fresh session on success and
            // throws on invalid credentials — that's what gates the sensitive action.
            await authClient.signIn.email({
                email: userEmail,
                fetchOptions: { throw: true },
                password,
                rememberMe: true,
            });

            onVerified?.();
            onOpenChange?.(false);
            setPassword("");
        } catch (verificationError) {
            setError(getLocalizedError({ error: verificationError, t }) || t`Invalid password. Please try again.`);
        } finally {
            setIsPending(false);
        }
    };

    return (
        <Dialog onOpenChange={onOpenChange} {...properties}>
            <DialogContent
                className={classNames?.dialog?.content}
                onOpenAutoFocus={(e) => {
                    e.preventDefault();
                }}
            >
                <DialogHeader className={classNames?.dialog?.header}>
                    <DialogTitle className={cn("text-lg md:text-xl", classNames?.title)}>{t`Verify Your Identity`}</DialogTitle>

                    <DialogDescription className={cn("text-xs md:text-sm", classNames?.description)}>
                        {t`For security reasons, please confirm your password to continue with this action.`}
                    </DialogDescription>
                </DialogHeader>

                <form className="space-y-4" onSubmit={handleSubmit}>
                    <Field.Root className="space-y-2">
                        <Label htmlFor="verification-password">{t`Current Password`}</Label>
                        <Input
                            autoFocus
                            id="verification-password"
                            onChange={(e) => {
                                setPassword(e.target.value);
                            }}
                            placeholder={t`Enter your current password`}
                            required
                            type="password"
                            value={password}
                        />
                        {error && <p className="text-destructive text-sm">{error}</p>}
                    </Field.Root>

                    <DialogFooter className={classNames?.dialog?.footer}>
                        <Button
                            className={cn(classNames?.button, classNames?.outlineButton)}
                            disabled={isPending}
                            onClick={() => onOpenChange?.(false)}
                            type="button"
                            variant="outline"
                        >
                            {t`Cancel`}
                        </Button>

                        <Button className={cn(classNames?.button, classNames?.primaryButton)} disabled={!password.trim() || isPending} type="submit">
                            {isPending ? t`Verifying...` : t`Verify`}
                        </Button>
                    </DialogFooter>
                </form>
            </DialogContent>
        </Dialog>
    );
};

export default SessionFreshnessDialog;
