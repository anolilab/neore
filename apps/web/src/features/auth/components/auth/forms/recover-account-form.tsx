"use client";

import { useLingui } from "@lingui/react/macro";
import { Button } from "@neore/ui/components/button";
import { useAppForm } from "@neore/ui/components/form";
import { InputOTP } from "@neore/ui/components/input-otp";
import useIsHydrated from "@neore/ui/hooks/use-hydrated";
import cn from "@neore/ui/utils/cn";
import { useStore } from "@tanstack/react-form";
import { Loader2 } from "lucide-react";
import { useEffect } from "react";
import * as z from "zod";

import useOnSuccessTransition from "@/features/auth/hooks/use-success-transition";
import { useAuth } from "@/features/auth/lib/auth-ui-provider";
import { getLocalizedError } from "@/features/auth/lib/utilities";

import type { AuthFormClassNames } from "../auth-form";
import OTPInputGroup from "../otp-input-group";

export interface RecoverAccountFormProperties {
    className?: string;
    classNames?: AuthFormClassNames;
    isSubmitting?: boolean;
    otpSeparators?: 0 | 1 | 2;
    redirectTo?: string;
    setIsSubmitting?: (value: boolean) => void;
}

const RecoverAccountForm = ({ className, classNames, isSubmitting, otpSeparators = 0, redirectTo, setIsSubmitting }: RecoverAccountFormProperties) => {
    const { t } = useLingui();
    const isHydrated = useIsHydrated();

    const { authClient, toast } = useAuth();

    const { isPending: transitionPending, onSuccess } = useOnSuccessTransition({
        redirectTo,
    });

    const formSchema = z.strictObject({
        code: z
            .string()
            .min(1, {
                message: t`Backup code is required`,
            })
            .refine((value) => value.length >= 6, {
                error: t`Backup code is invalid`,
            }),
    });

    const form = useAppForm({
        defaultValues: {
            code: "",
        },
        onSubmit: async ({ value }: { value: { code: string } }) => {
            try {
                await authClient.twoFactor.verifyBackupCode({
                    code: value.code,
                    fetchOptions: { throw: true },
                });

                await onSuccess();
            } catch (error) {
                toast({
                    message: getLocalizedError({ error, t }),
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

    const isFormSubmitting = useStore(form.store, (state) => state.isSubmitting);

    useEffect(() => {
        setIsSubmitting?.(Boolean(isFormSubmitting || transitionPending));
    }, [isFormSubmitting, transitionPending, setIsSubmitting]);

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
                <form.AppField name="code">
                    {(field) => (
                        <field.FormItem>
                            <field.FormLabel className={classNames?.label}>{t`Backup Code`}</field.FormLabel>

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
                        {({ canSubmit, isSubmitting: isSubmittingState }) => (
                            <Button className={cn(classNames?.button, classNames?.primaryButton)} disabled={!canSubmit || isSubmitting} type="submit">
                                {(isSubmittingState || isSubmitting) && <Loader2 className="animate-spin" />}
                                {t`Recover account`}
                            </Button>
                        )}
                    </form.Subscribe>
                </div>
            </form>
        </form.AppForm>
    );
};

export default RecoverAccountForm;
