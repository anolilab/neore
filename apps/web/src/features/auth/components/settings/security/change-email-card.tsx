"use client";

import { useLingui } from "@lingui/react/macro";
import { CardContent } from "@neore/ui/components/card";
import { useAppForm } from "@neore/ui/components/form";
import { Input } from "@neore/ui/components/input";
import { Skeleton } from "@neore/ui/components/skeleton";
import cn from "@neore/ui/utils/cn";
import { useLocation } from "@tanstack/react-router";
import { useState } from "react";
import * as z from "zod";

import type { SettingsCardProperties } from "@/components/settings/settings-card";
import SettingsCard from "@/components/settings/settings-card";
import { useSession } from "@/features/auth/hooks/session-user-management";
import { useAuth } from "@/features/auth/lib/auth-ui-provider";
import emailSchema from "@/features/auth/validators/email-schema";

const ChangeEmailCard = ({ className, classNames, ...properties }: SettingsCardProperties) => {
    const { authClient, emailVerification, toast } = useAuth();
    const { t } = useLingui();
    const location = useLocation();

    const formSchema = z.strictObject({
        email: emailSchema,
    });

    const { data: sessionData, isPending, refetch } = useSession(authClient);
    const [resendDisabled, setResendDisabled] = useState(false);

    const form = useAppForm({
        defaultValues: {
            email: sessionData?.user.email || "",
        },
        onSubmit: async ({ value }) => {
            if (value.email === sessionData?.user.email) {
                await new Promise((resolve) => {
                    setTimeout(resolve, 0);
                });
                toast({
                    message: t`Email is the same`,
                    variant: "error",
                });

                return;
            }

            try {
                await authClient.changeEmail({
                    callbackURL: location.pathname,
                    fetchOptions: { throw: true },
                    newEmail: value.email,
                });

                if (sessionData?.user.emailVerified) {
                    toast({
                        message: t`Please verify your new email address`,
                        variant: "success",
                    });
                } else {
                    await refetch?.();
                    toast({
                        message: t`Email updated successfully`,
                        variant: "success",
                    });
                }
            } catch {
                toast({
                    message: t`Failed to update email address`,
                    variant: "error",
                });
            }
        },
        validators: {
            onChange: ({ value }) => {
                const result = formSchema.safeParse(value);

                if (!result.success) {
                    return { email: result.error.issues[0]?.message };
                }

                return undefined;
            },
        },
    });

    const resendForm = useAppForm({
        defaultValues: {},
        onSubmit: async () => {
            if (!sessionData) {
                return;
            }

            const { email } = sessionData.user;

            setResendDisabled(true);

            try {
                await authClient.sendVerificationEmail({
                    email,
                    fetchOptions: { throw: true },
                });

                toast({
                    message: t`Verification email sent`,
                    variant: "success",
                });
            } catch (error) {
                toast({
                    message: t`Failed to send verification email`,
                    variant: "error",
                });
                setResendDisabled(false);
                throw error;
            }
        },
    });

    const { isSubmitting } = form.state;

    return (
        <>
            <form.AppForm>
                <form
                    noValidate
                    onSubmit={(e) => {
                        e.preventDefault();
                        e.stopPropagation();
                        form.handleSubmit();
                    }}
                >
                    <SettingsCard
                        actionLabel={t`Save`}
                        className={className}
                        classNames={classNames}
                        description={t`Update your account email address`}
                        instructions={t`Enter your new email address below`}
                        isPending={isPending}
                        title={t`Email Address`}
                        {...properties}
                    >
                        <CardContent className={classNames?.content}>
                            {isPending ? (
                                <Skeleton className={cn("h-9 w-full", classNames?.skeleton)} />
                            ) : (
                                <form.AppField name="email">
                                    {(field) => (
                                        <field.FormItem>
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
                            )}
                        </CardContent>
                    </SettingsCard>
                </form>
            </form.AppForm>

            {emailVerification && sessionData?.user && !sessionData?.user.emailVerified && (
                <resendForm.AppForm>
                    <form
                        onSubmit={(e) => {
                            e.preventDefault();
                            e.stopPropagation();
                            resendForm.handleSubmit();
                        }}
                    >
                        <SettingsCard
                            actionLabel={t`Resend Verification Email`}
                            className={className}
                            classNames={classNames}
                            description={t`Please check your email and click the verification link`}
                            disabled={resendDisabled}
                            title={t`Verify Your Email`}
                            {...properties}
                        />
                    </form>
                </resendForm.AppForm>
            )}
        </>
    );
};

export default ChangeEmailCard;
