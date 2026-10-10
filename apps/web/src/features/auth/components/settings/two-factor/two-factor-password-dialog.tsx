"use client";

import { useLingui } from "@lingui/react/macro";
import { Button } from "@neore/ui/components/button";
import { useAppForm } from "@neore/ui/components/form";
import PasswordInput from "@neore/ui/components/form/password-input";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@neore/ui/components/responsive-dialog";
import cn from "@neore/ui/utils/cn";
import { Loader2 } from "lucide-react";
import type { ComponentProps } from "react";
import { useRef, useState } from "react";
import * as z from "zod";

import type { SettingsCardClassNames } from "@/components/settings/settings-card";
import { useAuth } from "@/features/auth/lib/auth-ui-provider";
import { getLocalizedError } from "@/features/auth/lib/utilities";

import BackupCodesDialog from "./backup-codes-dialog";

/**
 * sessionStorage key used to hand off the freshly minted TOTP provisioning URI
 * (which embeds the shared secret) from this dialog to the verification view.
 * Must match the consumer key in two-factor-form.tsx.
 */
const TOTP_URI_HANDOFF_KEY = "auth.totpURI.handoff";

interface TwoFactorPasswordDialogProperties extends ComponentProps<typeof Dialog> {
    classNames?: SettingsCardClassNames;
    isTwoFactorEnabled: boolean;
}

const TwoFactorPasswordDialog = ({ classNames, isTwoFactorEnabled, onOpenChange, ...properties }: TwoFactorPasswordDialogProperties) => {
    const { authClient, basePath, replace, toast, twoFactor, viewPaths } = useAuth();
    const [showBackupCodesDialog, setShowBackupCodesDialog] = useState(false);
    const [backupCodes, setBackupCodes] = useState<string[]>([]);
    // A ref, not state: the URI is never rendered — it is read once in the
    // backup-codes dialog's close handler and handed to the next view.
    const totpUriRef = useRef<string | null>(null);
    const { t } = useLingui();

    const formSchema = z.strictObject({
        password: z.string().min(1, { message: t`Password is required` }),
    });

    const enableTwoFactor = async ({ password }: z.infer<typeof formSchema>) => {
        try {
            const response = await authClient.twoFactor.enable({
                fetchOptions: { throw: true },
                password,
            });

            onOpenChange?.(false);

            // better-auth 1.7 narrowed this response to a discriminated union: only the
            // `totp` branch carries `totpURI` and `backupCodes`; enabling OTP returns
            // `{ method: "otp" }` alone. The old code read both unconditionally, so an
            // OTP enrolment set `undefined` backup codes and then opened the
            // backup-codes dialog on them.
            if (response.method !== "totp") {
                return;
            }

            setBackupCodes(response.backupCodes);

            if (twoFactor?.includes("totp")) {
                totpUriRef.current = response.totpURI;
            }

            setTimeout(() => {
                setShowBackupCodesDialog(true);
            }, 250);
        } catch (error) {
            toast({
                message: getLocalizedError({ error, t }),
                variant: "error",
            });
        }
    };

    const disableTwoFactor = async ({ password }: z.infer<typeof formSchema>) => {
        try {
            await authClient.twoFactor.disable({
                fetchOptions: { throw: true },
                password,
            });

            toast({
                message: t`Two-factor authentication disabled`,
                variant: "success",
            });

            onOpenChange?.(false);
        } catch (error) {
            toast({
                message: getLocalizedError({ error, t }),
                variant: "error",
            });
        }
    };

    const form = useAppForm({
        defaultValues: {
            password: "",
        },
        onSubmit: async ({ value }) => {
            await (isTwoFactorEnabled ? disableTwoFactor(value) : enableTwoFactor(value));
        },
        validators: {
            onChange: ({ value }) => {
                const result = formSchema.safeParse(value);

                if (!result.success) {
                    return { password: result.error.issues[0]?.message };
                }

                return undefined;
            },
        },
    });

    return (
        <>
            <Dialog onOpenChange={onOpenChange} {...properties}>
                <DialogContent className={cn("sm:max-w-md", classNames?.dialog)}>
                    <DialogHeader className={classNames?.dialog?.header}>
                        <DialogTitle className={classNames?.title}>{t`Two-Factor Authentication`}</DialogTitle>

                        <DialogDescription className={classNames?.description}>
                            {isTwoFactorEnabled
                                ? t`Enter your password to disable two-factor authentication`
                                : t`Enter your password to enable two-factor authentication`}
                        </DialogDescription>
                    </DialogHeader>

                    <form.AppForm>
                        <form
                            className="grid gap-4"
                            onSubmit={(e) => {
                                e.preventDefault();
                                e.stopPropagation();
                                form.handleSubmit();
                            }}
                        >
                            <form.AppField name="password">
                                {(field) => (
                                    <field.FormItem>
                                        <field.FormLabel className={classNames?.label}>{t`Password`}</field.FormLabel>

                                        <field.FormControl>
                                            <PasswordInput
                                                autoComplete="current-password"
                                                className={classNames?.input}
                                                onBlur={field.handleBlur}
                                                onChange={(e) => {
                                                    field.handleChange(e.target.value);
                                                }}
                                                placeholder={t`Enter your password`}
                                                value={field.state.value}
                                            />
                                        </field.FormControl>

                                        <field.FormMessage className={classNames?.error} />
                                    </field.FormItem>
                                )}
                            </form.AppField>

                            <DialogFooter className={classNames?.dialog?.footer}>
                                <Button
                                    className={cn(classNames?.button, classNames?.secondaryButton)}
                                    onClick={() => onOpenChange?.(false)}
                                    type="button"
                                    variant="secondary"
                                >
                                    {t`Cancel`}
                                </Button>

                                <form.Subscribe
                                    selector={(state) => ({ canSubmit: state.canSubmit, isSubmitting: state.isSubmitting }) as unknown as typeof state}
                                >
                                    {({ canSubmit, isSubmitting }) => (
                                        <Button
                                            className={cn(classNames?.button, classNames?.primaryButton)}
                                            disabled={!canSubmit || isSubmitting}
                                            type="submit"
                                        >
                                            {isSubmitting && <Loader2 className="animate-spin" />}
                                            {isTwoFactorEnabled ? t`Disable Two-Factor` : t`Enable Two-Factor`}
                                        </Button>
                                    )}
                                </form.Subscribe>
                            </DialogFooter>
                        </form>
                    </form.AppForm>
                </DialogContent>
            </Dialog>

            <BackupCodesDialog
                backupCodes={backupCodes}
                classNames={classNames}
                onOpenChange={(open) => {
                    setShowBackupCodesDialog(open);

                    if (!open) {
                        const url = `${basePath}/${viewPaths.TWO_FACTOR}`;

                        // Hand the TOTP provisioning URI to the next view via sessionStorage,
                        // not the URL. The URI embeds the TOTP shared secret, so putting it in
                        // a query string would leak it into browser history, the Referer header,
                        // and any analytics SDK that reads window.location.
                        const totpURI = totpUriRef.current;

                        if (twoFactor?.includes("totp") && totpURI) {
                            try {
                                globalThis.sessionStorage?.setItem(TOTP_URI_HANDOFF_KEY, totpURI);
                            } catch {
                                // sessionStorage unavailable (private mode / SSR) — fall through
                            }

                            // `replace` (not `navigate`) so the dialog URL is not left on the
                            // history stack — `navigate` takes an href only, it has no options arg.
                            replace(`${url}?hideForgotAuthenticator=true`);
                        } else {
                            replace(url);
                        }
                    }
                }}
                open={showBackupCodesDialog}
            />
        </>
    );
};

export default TwoFactorPasswordDialog;
