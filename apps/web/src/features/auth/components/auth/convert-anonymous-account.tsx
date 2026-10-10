"use client";

import { useLingui } from "@lingui/react/macro";
import { Alert, AlertDescription } from "@neore/ui/components/alert";
import { Button } from "@neore/ui/components/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@neore/ui/components/card";
import { useAppForm } from "@neore/ui/components/form";
import PasswordInput from "@neore/ui/components/form/password-input";
import { Input } from "@neore/ui/components/input";
import useIsHydrated from "@neore/ui/hooks/use-hydrated";
import cn from "@neore/ui/utils/cn";
import { useStore } from "@tanstack/react-form";
import { AlertCircle, Loader2 } from "lucide-react";
import { strictObject, string } from "zod";

import { useAuth } from "@/features/auth/lib/auth-ui-provider";
import { withInviteToken } from "@/features/auth/lib/invite-token";
import { getLocalizedError } from "@/features/auth/lib/utilities";
import type { PasswordValidation } from "@/features/auth/types/form-validation-types";
import emailSchema from "@/features/auth/validators/email-schema";
import { trackEvent } from "@/lib/analytics";

export interface ConvertAnonymousAccountProperties {
    className?: string;
    classNames?: {
        alert?: string;
        base?: string;
        button?: string;
        card?: string;
        cardContent?: string;
        cardDescription?: string;
        cardHeader?: string;
        cardTitle?: string;
        error?: string;
        form?: string;
        input?: string;
        label?: string;
    };
    onSuccess?: () => void;
    passwordValidation?: PasswordValidation;
}

const ConvertAnonymousAccount = ({ className, classNames, onSuccess, passwordValidation }: ConvertAnonymousAccountProperties) => {
    const isHydrated = useIsHydrated();
    const { authClient, toast } = useAuth();
    const { t } = useLingui();

    const formSchema = strictObject({
        confirmPassword: string().min(1, {
            message: t`Please confirm your password`,
        }),
        email: emailSchema,
        password: (() => {
            let schema = string()
                .trim()
                .min(1, {
                    message: t`Password is required`,
                });

            if (passwordValidation?.minLength) {
                schema = schema.min(passwordValidation.minLength, {
                    message: t`Password is too short`,
                });
            }

            if (passwordValidation?.maxLength) {
                schema = schema.max(passwordValidation.maxLength, {
                    message: t`Password is too long`,
                });
            }

            if (passwordValidation?.regex) {
                schema = schema.regex(passwordValidation.regex, {
                    message: t`Invalid password`,
                });
            }

            return schema;
        })(),
    }).refine((data) => data.password === data.confirmPassword, {
        error: t`Passwords do not match`,
        path: ["confirmPassword"],
    });

    const form = useAppForm({
        defaultValues: {
            confirmPassword: "",
            email: "",
            password: "",
        },
        onSubmit: async ({ value }) => {
            const defaultName = value.email.split("@", 1)[0] ?? ""; // Use email prefix as default name

            try {
                // Converting creates a NEW user (better-auth links the anonymous one
                // afterwards), so it goes through the same invite-only gate as any
                // other registration. The token is only present when the visitor
                // arrived on an invitation link.
                await authClient.signUp.email(
                    withInviteToken({
                        email: value.email,
                        fetchOptions: { throw: true },
                        name: defaultName,
                        password: value.password,
                    }),
                );

                trackEvent("anonymous_converted", { provider: "email" });

                toast({
                    message: t`Account converted successfully! Please check your email to verify your account.`,
                    variant: "default",
                });

                if (onSuccess) {
                    onSuccess();
                }
            } catch (error) {
                toast({
                    message: getLocalizedError({ error, t }),
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

    // The form store already tracks the in-flight submit; mirroring it into
    // local state via an effect only bought an extra render.
    const isSubmitting = useStore(form.store, (state) => state.isSubmitting);

    return (
        <Card className={cn("w-full max-w-md", className, classNames?.base)}>
            <CardHeader className={classNames?.cardHeader}>
                <CardTitle className={cn("text-lg", classNames?.cardTitle)}>{t`Convert to Full Account`}</CardTitle>
                <CardDescription className={classNames?.cardDescription}>
                    {t`Create a permanent account to save your data and access it from any device.`}
                </CardDescription>
            </CardHeader>

            <CardContent className={cn("grid gap-4", classNames?.cardContent)}>
                <Alert className={cn("text-sm", classNames?.alert)}>
                    <AlertCircle className="h-4 w-4" />
                    <AlertDescription>{t`Your current anonymous session will be converted to a permanent account.`}</AlertDescription>
                </Alert>

                <form.AppForm>
                    <form
                        className={cn("grid gap-4", classNames?.form)}
                        noValidate={isHydrated}
                        onSubmit={(e) => {
                            e.preventDefault();
                            e.stopPropagation();
                            form.handleSubmit();
                        }}
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
                                            placeholder={t`Enter your email`}
                                            type="email"
                                            value={field.state.value}
                                        />
                                    </field.FormControl>
                                    <field.FormMessage className={classNames?.error} />
                                </field.FormItem>
                            )}
                        </form.AppField>

                        <form.AppField name="password">
                            {(field) => (
                                <field.FormItem>
                                    <field.FormLabel className={classNames?.label}>{t`Password`}</field.FormLabel>
                                    <field.FormControl>
                                        <PasswordInput
                                            className={classNames?.input}
                                            disabled={isSubmitting}
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

                        <form.AppField name="confirmPassword">
                            {(field) => (
                                <field.FormItem>
                                    <field.FormLabel className={classNames?.label}>{t`Confirm Password`}</field.FormLabel>
                                    <field.FormControl>
                                        <PasswordInput
                                            className={classNames?.input}
                                            disabled={isSubmitting}
                                            onBlur={field.handleBlur}
                                            onChange={(e) => {
                                                field.handleChange(e.target.value);
                                            }}
                                            placeholder={t`Confirm your password`}
                                            value={field.state.value}
                                        />
                                    </field.FormControl>
                                    <field.FormMessage className={classNames?.error} />
                                </field.FormItem>
                            )}
                        </form.AppField>

                        <Button className={cn("w-full", classNames?.button)} disabled={isSubmitting} type="submit">
                            {isSubmitting ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
                            {t`Convert Account`}
                        </Button>
                    </form>
                </form.AppForm>
            </CardContent>
        </Card>
    );
};

export default ConvertAnonymousAccount;
