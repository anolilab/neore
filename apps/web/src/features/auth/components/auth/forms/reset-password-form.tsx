"use client";

import { useLingui } from "@lingui/react/macro";
import { Button } from "@neore/ui/components/button";
import { useAppForm } from "@neore/ui/components/form";
import PasswordInput from "@neore/ui/components/form/password-input";
import cn from "@neore/ui/utils/cn";
import { Loader2 } from "lucide-react";
import { useEffect, useRef } from "react";
import * as z from "zod";

import { useAuth } from "@/features/auth/lib/auth-ui-provider";
import { getLocalizedError } from "@/features/auth/lib/utilities";
import type { PasswordValidation } from "@/features/auth/types/form-validation-types";

import type { AuthFormClassNames } from "../auth-form";

export interface ResetPasswordFormProperties {
    className?: string;
    classNames?: AuthFormClassNames;
    passwordValidation?: PasswordValidation;
}

const ResetPasswordForm = ({ className, classNames, passwordValidation }: ResetPasswordFormProperties) => {
    const { t } = useLingui();
    const tokenChecked = useRef(false);

    const { authClient, basePath, credentials, navigate, toast, viewPaths } = useAuth();

    const confirmPasswordEnabled = credentials?.confirmPassword;
    const contextPasswordValidation = credentials?.passwordValidation;

    const passwordRules = { ...contextPasswordValidation, ...passwordValidation };

    const formSchema = z
        .object({
            confirmPassword: confirmPasswordEnabled
                ? (() => {
                      let schema = z.string().min(1, {
                          message: t`Confirm password is required`,
                      });

                      if (passwordRules?.minLength) {
                          schema = schema.min(passwordRules.minLength, {
                              message: t`Password is too short`,
                          });
                      }

                      if (passwordRules?.maxLength) {
                          schema = schema.max(passwordRules.maxLength, {
                              message: t`Password is too long`,
                          });
                      }

                      if (passwordRules?.regex) {
                          schema = schema.regex(passwordRules.regex, {
                              message: t`Invalid password`,
                          });
                      }

                      return schema;
                  })()
                : z.string().optional(),
            newPassword: (() => {
                let schema = z.string().min(1, {
                    message: t`New password is required`,
                });

                if (passwordRules?.minLength) {
                    schema = schema.min(passwordRules.minLength, {
                        message: t`Password is too short`,
                    });
                }

                if (passwordRules?.maxLength) {
                    schema = schema.max(passwordRules.maxLength, {
                        message: t`Password is too long`,
                    });
                }

                if (passwordRules?.regex) {
                    schema = schema.regex(passwordRules.regex, {
                        message: t`Invalid password`,
                    });
                }

                return schema;
            })(),
        })
        .refine((data) => !confirmPasswordEnabled || data.newPassword === data.confirmPassword, {
            error: t`Passwords do not match`,
            path: ["confirmPassword"],
        });

    const form = useAppForm({
        defaultValues: {
            confirmPassword: "",
            newPassword: "",
        },
        onSubmit: async ({ value }) => {
            try {
                const searchParameters = new URLSearchParams(globalThis.location.search);
                const token = searchParameters.get("token") as string;

                await authClient.resetPassword({
                    fetchOptions: { throw: true },
                    newPassword: value.newPassword,
                    token,
                });

                toast({
                    message: t`Password reset successful`,
                    variant: "success",
                });

                navigate(`${basePath}/${viewPaths.SIGN_IN}${globalThis.location.search}`);
            } catch (error) {
                toast({
                    message: getLocalizedError({ error, t }),
                    variant: "error",
                });

                form.reset();
            }
        },
        validators: {
            onChange: ({ value }) => {
                const result = formSchema.safeParse(value);

                if (!result.success) {
                    return result.error.issues[0]?.message;
                }

                return undefined;
            },
        },
    });

    const { isSubmitting } = form.state;

    useEffect(() => {
        if (tokenChecked.current) {
            return;
        }

        tokenChecked.current = true;

        const searchParameters = new URLSearchParams(globalThis.location.search);
        const token = searchParameters.get("token");

        if (!token || token === "INVALID_TOKEN") {
            navigate(`${basePath}/${viewPaths.SIGN_IN}${globalThis.location.search}`);
            toast({ message: t`Invalid token`, variant: "error" });
        }
    }, [basePath, navigate, t, toast, viewPaths]);

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
                <form.AppField name="newPassword">
                    {(field) => (
                        <field.FormItem>
                            <field.FormLabel className={classNames?.label}>{t`New password`}</field.FormLabel>

                            <field.FormControl>
                                <PasswordInput
                                    autoComplete="new-password"
                                    className={classNames?.input}
                                    disabled={isSubmitting}
                                    onBlur={field.handleBlur}
                                    onChange={(e) => {
                                        field.handleChange(e.target.value);
                                    }}
                                    placeholder={t`Enter new password`}
                                    value={field.state.value}
                                />
                            </field.FormControl>

                            <field.FormMessage className={classNames?.error} />
                        </field.FormItem>
                    )}
                </form.AppField>

                {confirmPasswordEnabled && (
                    <form.AppField name="confirmPassword">
                        {(field) => (
                            <field.FormItem>
                                <field.FormLabel className={classNames?.label}>{t`Confirm password`}</field.FormLabel>

                                <field.FormControl>
                                    <PasswordInput
                                        autoComplete="new-password"
                                        className={classNames?.input}
                                        disabled={isSubmitting}
                                        onBlur={field.handleBlur}
                                        onChange={(e) => {
                                            field.handleChange(e.target.value);
                                        }}
                                        placeholder={t`Confirm new password`}
                                        value={field.state.value}
                                    />
                                </field.FormControl>

                                <field.FormMessage className={classNames?.error} />
                            </field.FormItem>
                        )}
                    </form.AppField>
                )}

                <form.Subscribe selector={(state) => ({ canSubmit: state.canSubmit, isSubmitting: state.isSubmitting }) as unknown as typeof state}>
                    {({ canSubmit, isSubmitting: isSubmittingState }) => (
                        <Button className={cn(classNames?.button, classNames?.primaryButton)} disabled={!canSubmit || isSubmittingState} type="submit">
                            {isSubmittingState ? <Loader2 className="animate-spin" /> : t`Reset password`}
                        </Button>
                    )}
                </form.Subscribe>
            </form>
        </form.AppForm>
    );
};

export default ResetPasswordForm;
