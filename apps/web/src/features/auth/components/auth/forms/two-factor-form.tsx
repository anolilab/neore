"use client";

import { useLingui } from "@lingui/react/macro";
import { Button } from "@neore/ui/components/button";
import { Checkbox } from "@neore/ui/components/checkbox";
import { useAppForm } from "@neore/ui/components/form";
import { InputOTP } from "@neore/ui/components/input-otp";
import useIsHydrated from "@neore/ui/hooks/use-hydrated";
import cn from "@neore/ui/utils/cn";
import { Link, useSearch } from "@tanstack/react-router";
import type { BetterFetchError } from "better-auth/react";
import { Loader2, QrCodeIcon, SendIcon } from "lucide-react";
import { useEffect, useEffectEvent, useRef, useState } from "react";
import QrCodeSvg from "react-qr-code";
import * as z from "zod";

import CopyButton from "@/components/copy-button";
import type { AuthFormClassNames } from "@/features/auth/components/auth/auth-form";
import OTPInputGroup from "@/features/auth/components/auth/otp-input-group";
import { useSession } from "@/features/auth/hooks/session-user-management";
import useOnSuccessTransition from "@/features/auth/hooks/use-success-transition";
import { useAuth } from "@/features/auth/lib/auth-ui-provider";
import { getLocalizedError } from "@/features/auth/lib/utilities";
import type { User } from "@/features/auth/types/auth-core-types";

export interface TwoFactorFormProperties {
    className?: string;
    classNames?: AuthFormClassNames;
    isSubmitting?: boolean;
    otpSeparators?: 0 | 1 | 2;
    redirectTo?: string;
    setIsSubmitting?: (value: boolean) => void;
}

// Helper function to extract secret from TOTP URI
const extractSecretFromTotpUri = (totpURI: string): string | null => {
    try {
        const url = new URL(totpURI);

        return url.searchParams.get("secret");
    } catch {
        return null;
    }
};

const TwoFactorForm = ({ className, classNames, isSubmitting, otpSeparators = 0, redirectTo, setIsSubmitting }: TwoFactorFormProperties) => {
    const { t } = useLingui();

    const formSchema = z.strictObject({
        code: z
            .string()
            .min(1, {
                message: t`One-time password is required`,
            })
            .refine((value) => value.length >= 6, {
                error: t`One-time password is invalid`,
            }),
        trustDevice: z.boolean(),
    });

    const isHydrated = useIsHydrated();
    const search = useSearch({ strict: false });

    // Read the TOTP provisioning URI from sessionStorage (one-shot handoff from the
    // password dialog) instead of the URL query string. URLs leak via history,
    // Referer, and analytics; sessionStorage is scoped to the tab and we clear it
    // immediately after the first read.
    const [totpURI, setTotpURI] = useState<string | null>(null);

    useEffect(() => {
        if (!isHydrated) return;

        try {
            const stored = globalThis.sessionStorage?.getItem("auth.totpURI.handoff");

            if (stored) {
                setTotpURI(stored);
                globalThis.sessionStorage?.removeItem("auth.totpURI.handoff");

                return;
            }
        } catch {
            // sessionStorage unavailable — fall back to the (legacy) URL search param
        }

        // Backwards compatibility: still honor totpURI in the URL for any in-flight
        // navigations from older clients. Only used as a last resort.
        if (search?.totpURI) setTotpURI(search.totpURI);
    }, [isHydrated, search?.totpURI]);

    const digits = isHydrated ? search?.digits : null;
    const isHideForgotAuthenticator = !!search?.hideForgotAuthenticator;
    const totpSecret = totpURI ? extractSecretFromTotpUri(totpURI) : null;

    const initialSendReference = useRef(false);

    const { authClient, basePath, toast, twoFactor, viewPaths } = useAuth();

    const { isPending: transitionPending, onSuccess } = useOnSuccessTransition({
        redirectTo,
    });

    const { data: sessionData } = useSession(authClient);
    const isTwoFactorEnabled = (sessionData?.user as User)?.twoFactorEnabled;

    const [method, setMethod] = useState<"totp" | "otp" | null>(twoFactor?.length === 1 ? (twoFactor[0] ?? null) : null);

    const [isSendingOtp, setIsSendingOtp] = useState(false);
    const [cooldownSeconds, setCooldownSeconds] = useState(0);

    const form = useAppForm({
        defaultValues: {
            code: "",
            trustDevice: false,
        },
        onSubmit: async ({ value }) => {
            try {
                const verifyMethod = method === "totp" ? authClient.twoFactor.verifyTotp : authClient.twoFactor.verifyOtp;

                await verifyMethod({
                    code: value.code,
                    fetchOptions: { throw: true },
                    trustDevice: value.trustDevice,
                });

                await onSuccess();

                if (sessionData && !isTwoFactorEnabled) {
                    toast({
                        message: t`Two-factor authentication enabled`,
                        variant: "success",
                    });
                }
            } catch (error) {
                toast({
                    message: getLocalizedError({ error, t }),
                    variant: "error",
                });

                form.reset();
            }
        },
        validators: {
            onChange: formSchema,
        },
    });

    const isBusy = isSubmitting || form.state.isSubmitting || transitionPending;

    useEffect(() => {
        setIsSubmitting?.(form.state.isSubmitting || transitionPending);
    }, [form.state.isSubmitting, transitionPending, setIsSubmitting]);

    const sendOtp = async () => {
        if (isSendingOtp || cooldownSeconds > 0) {
            return;
        }

        try {
            setIsSendingOtp(true);
            await authClient.twoFactor.sendOtp({
                fetchOptions: { throw: true },
            });
            setCooldownSeconds(60);
        } catch (error) {
            toast({
                message: getLocalizedError({ error, t }),
                variant: "error",
            });

            if ((error as BetterFetchError).error.code === "INVALID_TWO_FACTOR_COOKIE") {
                globalThis.history.back();
            }
        }

        initialSendReference.current = false;
        setIsSendingOtp(false);
    };

    // An effect event: the send must fire when the method switches to "otp", not
    // every time the cooldown ticks down or `sendOtp` is re-created.
    const sendInitialOtp = useEffectEvent(() => {
        if (cooldownSeconds > 0 || initialSendReference.current) {
            return;
        }

        initialSendReference.current = true;
        sendOtp();
    });

    useEffect(() => {
        if (method !== "otp") {
            return;
        }

        sendInitialOtp();
    }, [method]);

    useEffect(() => {
        if (cooldownSeconds <= 0) {
            return undefined;
        }

        const timer = setTimeout(() => {
            setCooldownSeconds((previous) => previous - 1);
        }, 1000);

        return () => {
            clearTimeout(timer);
        };
    }, [cooldownSeconds]);

    return (
        <form.AppForm>
            <form
                className={cn("grid w-full gap-6", className, classNames?.base)}
                onSubmit={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    form.handleSubmit();
                }}
                suppressHydrationWarning
            >
                {twoFactor?.includes("totp") && totpURI && method === "totp" && (
                    <div className="space-y-4">
                        <div className={classNames?.label}>
                            {t`Using an authenticator app like`}{" "}
                            <a
                                className="text-blue-500 hover:underline"
                                href="https://www.google.com/search?q=google+authenticator"
                                rel="noreferrer"
                                target="_blank"
                            >
                                Google Authenticator
                            </a>
                            ,{" "}
                            <a
                                className="text-blue-500 hover:underline"
                                href="https://www.google.com/search?q=google+authenticator"
                                rel="noreferrer"
                                target="_blank"
                            >
                                Microsoft Authenticator
                            </a>{" "}
                            {t`or`}{" "}
                            <a
                                className="text-blue-500 hover:underline"
                                href="https://www.google.com/search?q=google+authenticator"
                                rel="noreferrer"
                                target="_blank"
                            >
                                Authy
                            </a>
                            , {t`scan this QR code. it will generate a 6 digit code for you to enter below.`}
                        </div>
                        <QrCodeSvg className={cn("mx-auto border shadow-xs", classNames?.qrCode)} value={totpURI} />

                        {totpSecret && (
                            <div className="max-w-sm space-y-2">
                                <p className="text-muted-foreground text-center text-sm">
                                    {t`Scan not working? Copy this code key and enter it manually in your authentication app.`}
                                </p>
                                <div className="bg-muted/50 flex items-center justify-center gap-2 rounded-md border p-3">
                                    <code className="font-mono text-sm break-all">{totpSecret}</code>
                                    <CopyButton textToCopy={totpSecret} />
                                </div>
                            </div>
                        )}
                    </div>
                )}

                {method !== null && (
                    <>
                        <form.AppField name="code">
                            {(field) => (
                                <field.FormItem>
                                    <div className="flex items-center justify-between">
                                        <field.FormLabel className={classNames?.label}>{t`One-time password`}</field.FormLabel>

                                        {!isHideForgotAuthenticator && (
                                            <Link
                                                className={cn("text-sm hover:underline", classNames?.forgotPasswordLink)}
                                                to={`${basePath}/${viewPaths.RECOVER_ACCOUNT}${isHydrated ? globalThis.location.search : ""}`}
                                            >
                                                {t`Forgot authenticator`}
                                            </Link>
                                        )}
                                    </div>

                                    <field.FormControl>
                                        <InputOTP
                                            className={classNames?.otpInput}
                                            containerClassName={classNames?.otpInputContainer}
                                            disabled={isBusy}
                                            maxLength={digits}
                                            onChange={(value) => {
                                                field.handleChange(value);

                                                if (value.length === digits) {
                                                    form.handleSubmit();
                                                }
                                            }}
                                            value={field.state.value}
                                        >
                                            <OTPInputGroup otpSeparators={otpSeparators} />
                                        </InputOTP>
                                    </field.FormControl>

                                    <field.FormMessage className={classNames?.error} />
                                </field.FormItem>
                            )}
                        </form.AppField>

                        <form.AppField name="trustDevice">
                            {(field) => (
                                <field.FormItem className="flex">
                                    <field.FormControl>
                                        <Checkbox
                                            checked={field.state.value}
                                            className={classNames?.checkbox}
                                            disabled={isBusy}
                                            onCheckedChange={(checked: boolean) => {
                                                field.handleChange(checked);
                                            }}
                                        />
                                    </field.FormControl>

                                    <field.FormLabel className={classNames?.label}>{t`Trust this device`}</field.FormLabel>
                                </field.FormItem>
                            )}
                        </form.AppField>
                    </>
                )}

                <div className="grid gap-4">
                    {method !== null && (
                        <form.Subscribe selector={(state) => ({ canSubmit: state.canSubmit, isSubmitting: state.isSubmitting }) as unknown as typeof state}>
                            {({ canSubmit, isSubmitting: isSubmittingState }) => (
                                <Button className={cn(classNames?.button, classNames?.primaryButton)} disabled={!canSubmit || isSubmittingState} type="submit">
                                    {isSubmittingState && <Loader2 className="animate-spin" />}
                                    {t`Two-factor authentication`}
                                </Button>
                            )}
                        </form.Subscribe>
                    )}

                    {method === "otp" && twoFactor?.includes("otp") && (
                        <Button
                            className={cn(classNames?.button, classNames?.outlineButton)}
                            disabled={cooldownSeconds > 0 || isSendingOtp || isBusy}
                            onClick={sendOtp}
                            type="button"
                            variant="outline"
                        >
                            {isSendingOtp ? <Loader2 className="animate-spin" /> : <SendIcon className={classNames?.icon} />}

                            {t`Resend code`}
                            {cooldownSeconds > 0 && ` (${cooldownSeconds})`}
                        </Button>
                    )}

                    {method !== "otp" && twoFactor?.includes("otp") && (
                        <Button
                            className={cn(classNames?.button, classNames?.secondaryButton)}
                            disabled={isBusy}
                            onClick={() => {
                                setMethod("otp");
                            }}
                            type="button"
                            variant="secondary"
                        >
                            <SendIcon className={classNames?.icon} />
                            {t`Send verification code`}
                        </Button>
                    )}

                    {method !== "totp" && twoFactor?.includes("totp") && (
                        <Button
                            className={cn(classNames?.button, classNames?.secondaryButton)}
                            disabled={isBusy}
                            onClick={() => {
                                setMethod("totp");
                            }}
                            type="button"
                            variant="secondary"
                        >
                            <QrCodeIcon className={classNames?.icon} />
                            {t`Continue with authenticator`}
                        </Button>
                    )}
                </div>
            </form>
        </form.AppForm>
    );
};

export default TwoFactorForm;
