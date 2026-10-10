"use client";

import { useLingui } from "@lingui/react/macro";
import { Button } from "@neore/ui/components/button";
import { useAppForm } from "@neore/ui/components/form";
import { Input } from "@neore/ui/components/input";
import { InputOTP } from "@neore/ui/components/input-otp";
import useIsHydrated from "@neore/ui/hooks/use-hydrated";
import cn from "@neore/ui/utils/cn";
import { useStore } from "@tanstack/react-form";
import { Loader2 } from "lucide-react";
import { useEffect, useState } from "react";
import * as z from "zod";

import useOnSuccessTransition from "@/features/auth/hooks/use-success-transition";
import { useAuth } from "@/features/auth/lib/auth-ui-provider";
import emailSchema from "@/features/auth/validators/email-schema";

import type { AuthFormClassNames } from "../auth-form";
import OTPInputGroup from "../otp-input-group";

export interface EmailOTPFormProperties {
    className?: string;
    classNames?: AuthFormClassNames;
    isSubmitting?: boolean;
    otpSeparators?: 0 | 1 | 2;
    redirectTo?: string;
    setIsSubmitting?: (value: boolean) => void;
}

export const OTPForm = ({
    className,
    classNames,
    email,
    isSubmitting,
    otpSeparators = 0,
    redirectTo,
    setIsSubmitting,
}: EmailOTPFormProperties & {
    email: string;
}) => {
    const { t } = useLingui();
    const { authClient, toast } = useAuth();

    const { isPending: transitionPending, onSuccess } = useOnSuccessTransition({
        redirectTo,
    });

    const formSchema = z.strictObject({
        code: z
            .string()
            .min(1, {
                message: t`Verification code is required`,
            })
            .refine((value) => value.length >= 6, {
                error: t`Verification code is invalid`,
            }),
    });

    const form = useAppForm({
        defaultValues: {
            code: "",
        },
        onSubmit: async ({ value }: { value: { code: string } }) => {
            try {
                await authClient.signIn.emailOtp({
                    email,
                    fetchOptions: { throw: true },
                    otp: value.code,
                });

                await onSuccess();
            } catch {
                toast({
                    message: t`Invalid verification code`,
                    variant: "error",
                });

                form.reset();
            }
        },
        validators: {
            onChange: ({ value }: { value: { code: string } }) => {
                const result = formSchema.safeParse(value);

                if (!result.success) {
                    return result.error.flatten().fieldErrors;
                }

                return undefined;
            },
        },
    });

    const isOtpFormSubmitting = useStore(form.store, (state) => state.isSubmitting);

    useEffect(() => {
        setIsSubmitting?.(isOtpFormSubmitting || transitionPending);
    }, [isOtpFormSubmitting, transitionPending, setIsSubmitting]);

    return (
        <form.AppForm>
            <form
                className={cn("grid w-full gap-6", className, classNames?.base)}
                onSubmit={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    form.handleSubmit();
                }}
            >
                <form.AppField name="code">
                    {(field) => (
                        <field.FormItem>
                            <field.FormLabel className={classNames?.label}>{t`Verification Code`}</field.FormLabel>

                            <field.FormControl>
                                <InputOTP
                                    className={classNames?.otpInput}
                                    containerClassName={classNames?.otpInputContainer}
                                    disabled={isSubmitting}
                                    maxLength={6}
                                    onChange={(value) => {
                                        field.handleChange(value);

                                        if (value.length === 6) {
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

                <div className="grid gap-4">
                    <form.Subscribe selector={(state) => ({ canSubmit: state.canSubmit, isSubmitting: state.isSubmitting }) as unknown as typeof state}>
                        {({ canSubmit, isSubmitting: isFormSubmitting }) => (
                            <Button className={cn(classNames?.button, classNames?.primaryButton)} disabled={!canSubmit || isSubmitting} type="submit">
                                {(isFormSubmitting || isSubmitting) && <Loader2 className="animate-spin" />}
                                {t`Verify Code`}
                            </Button>
                        )}
                    </form.Subscribe>
                </div>
            </form>
        </form.AppForm>
    );
};

const EmailForm = ({
    className,
    classNames,
    isSubmitting,
    setEmail,
    setIsSubmitting,
}: Pick<EmailOTPFormProperties, "className" | "classNames" | "isSubmitting" | "setIsSubmitting"> & {
    setEmail: (email: string) => void;
}) => {
    const { t } = useLingui();
    const isHydrated = useIsHydrated();

    const { authClient, toast } = useAuth();

    const formSchema = z.strictObject({
        email: emailSchema,
    });

    const form = useAppForm({
        defaultValues: {
            email: "",
        },
        onSubmit: async ({ value }) => {
            try {
                await authClient.emailOtp.sendVerificationOtp({
                    email: value.email,
                    fetchOptions: { throw: true },
                    type: "sign-in",
                });

                toast({
                    message: t`Verification code sent to your email`,
                    variant: "success",
                });

                setEmail(value.email);
            } catch {
                toast({
                    message: t`Failed to send verification code`,
                    variant: "error",
                });
            }
        },
        validators: {
            onChange: ({ value }) => {
                const result = formSchema.safeParse(value);

                if (!result.success) {
                    return result.error.flatten().fieldErrors;
                }

                return undefined;
            },
        },
    });

    const isFormSubmitting = useStore(form.store, (state) => state.isSubmitting);

    useEffect(() => {
        setIsSubmitting?.(isFormSubmitting);
    }, [isFormSubmitting, setIsSubmitting]);

    return (
        <form.AppForm>
            <form
                className={cn("grid w-full gap-6", className, classNames?.base)}
                noValidate={isHydrated}
                onSubmit={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    form.handleSubmit();
                }}
                suppressHydrationWarning
            >
                <form.AppField name="email">
                    {(field) => (
                        <field.FormItem>
                            <field.FormLabel className={classNames?.label}>{t`Email`}</field.FormLabel>

                            <field.FormControl>
                                <Input
                                    autoComplete="email"
                                    className={classNames?.input}
                                    disabled={isSubmitting}
                                    onBlur={field.handleBlur}
                                    onChange={(e) => {
                                        field.handleChange(e.target.value);
                                    }}
                                    placeholder={t`Enter your email address`}
                                    type="email"
                                    value={field.state.value}
                                />
                            </field.FormControl>

                            <field.FormMessage className={classNames?.error} />
                        </field.FormItem>
                    )}
                </form.AppField>

                <form.Subscribe selector={(state) => ({ canSubmit: state.canSubmit, isSubmitting: state.isSubmitting }) as unknown as typeof state}>
                    {({ canSubmit, isSubmitting: isSubmittingState }) => (
                        <Button className={cn("w-full", classNames?.button, classNames?.primaryButton)} disabled={!canSubmit || isSubmitting} type="submit">
                            {isSubmittingState || isSubmitting ? <Loader2 className="animate-spin" /> : t`Send Verification Code`}
                        </Button>
                    )}
                </form.Subscribe>
            </form>
        </form.AppForm>
    );
};

export const EmailOTPForm = (properties: EmailOTPFormProperties) => {
    const [email, setEmail] = useState<string | undefined>();

    if (!email) {
        return <EmailForm {...properties} setEmail={setEmail} />;
    }

    return <OTPForm {...properties} email={email} />;
};
