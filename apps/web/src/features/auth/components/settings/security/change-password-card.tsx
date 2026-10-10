"use client";

import { useLingui } from "@lingui/react/macro";
import { CardContent } from "@neore/ui/components/card";
import { useAppForm } from "@neore/ui/components/form";
import PasswordInput from "@neore/ui/components/form/password-input";
import { Skeleton } from "@neore/ui/components/skeleton";
import cn from "@neore/ui/utils/cn";
import * as z from "zod";

import type { SettingsCardClassNames } from "@/components/settings/settings-card";
import SettingsCard from "@/components/settings/settings-card";
import { useListAccounts } from "@/features/auth/hooks/account-management";
import { useSession } from "@/features/auth/hooks/session-user-management";
import { useAuth } from "@/features/auth/lib/auth-ui-provider";
import { getLocalizedError } from "@/features/auth/lib/utilities";

import type { PasswordValidation } from "../../../types/form-validation-types";

export interface ChangePasswordCardProperties {
    accounts?: { providerId: string }[] | null;
    className?: string;
    classNames?: SettingsCardClassNames;
    isPending?: boolean;
    passwordValidation?: PasswordValidation;
    skipHook?: boolean;
}

type ChangePasswordCardContentProperties = Omit<ChangePasswordCardProperties, "skipHook">;

const ChangePasswordCardContent = ({
    accounts,
    className,
    classNames,
    isPending,
    passwordValidation: passwordValidationProperty,
}: ChangePasswordCardContentProperties) => {
    const { authClient, basePath, baseURL, credentials, toast, viewPaths } = useAuth();
    const { t } = useLingui();

    const confirmPasswordEnabled = credentials?.confirmPassword;
    const contextPasswordValidation = credentials?.passwordValidation;

    const passwordValidation = { ...contextPasswordValidation, ...passwordValidationProperty };

    const { data: sessionData } = useSession(authClient);

    const formSchema = z
        .object({
            confirmPassword: confirmPasswordEnabled
                ? (() => {
                      let schema = z.string().min(1, {
                          message: t`Confirm password is required`,
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
                  })()
                : z.string().optional(),
            currentPassword: (() => {
                let schema = z.string().min(1, {
                    message: t`Current password is required`,
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
            newPassword: (() => {
                let schema = z.string().min(1, {
                    message: t`New password is required`,
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
        })
        .refine((data) => !confirmPasswordEnabled || data.newPassword === data.confirmPassword, {
            error: t`Passwords do not match`,
            path: ["confirmPassword"],
        });

    const form = useAppForm({
        defaultValues: {
            confirmPassword: "",
            currentPassword: "",
            newPassword: "",
        },
        onSubmit: async ({ value }) => {
            try {
                await authClient.changePassword({
                    currentPassword: value.currentPassword,
                    fetchOptions: { throw: true },
                    newPassword: value.newPassword,
                    revokeOtherSessions: true,
                });

                toast({
                    message: t`Password changed successfully`,
                    variant: "success",
                });

                form.reset();
            } catch (error) {
                toast({
                    message: getLocalizedError({ error, t }),
                    variant: "error",
                });
            }
        },
        validators: {
            onChange: ({ value }) => formSchema.safeParse(value),
        },
    });

    const setPasswordForm = useAppForm({
        defaultValues: {},
        onSubmit: async () => {
            if (!sessionData) {
                return;
            }

            const email = sessionData?.user.email;

            try {
                await authClient.requestPasswordReset({
                    email,
                    fetchOptions: { throw: true },
                    redirectTo: `${baseURL}${basePath}/${viewPaths.RESET_PASSWORD}`,
                });

                toast({
                    message: t`Password reset email sent`,
                    variant: "success",
                });
            } catch (error) {
                toast({
                    message: getLocalizedError({ error, t }),
                    variant: "error",
                });
            }
        },
        validators: {
            onChange: () => {
                return { data: {}, success: true };
            },
        },
    });

    const credentialsLinked = accounts?.some((accumulator) => accumulator.providerId === "credential");

    if (!isPending && !credentialsLinked) {
        return (
            <setPasswordForm.AppForm>
                <form
                    onSubmit={(e) => {
                        e.preventDefault();
                        e.stopPropagation();
                        setPasswordForm.handleSubmit();
                    }}
                >
                    <SettingsCard
                        actionLabel={t`Set Password`}
                        className={className}
                        classNames={classNames}
                        description={t`Set a password for your account`}
                        isPending={isPending}
                        title={t`Set Password`}
                    />
                </form>
            </setPasswordForm.AppForm>
        );
    }

    return (
        <form.AppForm>
            <form
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
                    description={t`Change your account password`}
                    instructions={t`Enter your current password and choose a new one`}
                    isPending={isPending}
                    title={t`Change Password`}
                >
                    <CardContent className={cn("grid gap-6", classNames?.content)}>
                        {isPending || !accounts ? (
                            <>
                                <div className="flex flex-col gap-1.5">
                                    <Skeleton className={cn("h-4 w-32", classNames?.skeleton)} />
                                    <Skeleton className={cn("h-9 w-full", classNames?.skeleton)} />
                                </div>
                                <div className="flex flex-col gap-1.5">
                                    <Skeleton className={cn("h-4 w-32", classNames?.skeleton)} />
                                    <Skeleton className={cn("h-9 w-full", classNames?.skeleton)} />
                                </div>

                                {confirmPasswordEnabled && (
                                    <div className="flex flex-col gap-1.5">
                                        <Skeleton className={cn("h-4 w-32", classNames?.skeleton)} />
                                        <Skeleton className={cn("h-9 w-full", classNames?.skeleton)} />
                                    </div>
                                )}
                            </>
                        ) : (
                            <>
                                <form.AppField name="currentPassword">
                                    {(field) => (
                                        <field.FormItem>
                                            <field.FormLabel className={classNames?.label}>{t`Current Password`}</field.FormLabel>

                                            <field.FormControl>
                                                <PasswordInput
                                                    autoComplete="current-password"
                                                    className={classNames?.input}
                                                    onBlur={field.handleBlur}
                                                    onChange={(e) => {
                                                        field.handleChange(e.target.value);
                                                    }}
                                                    placeholder={t`Enter current password`}
                                                    value={field.state.value}
                                                />
                                            </field.FormControl>

                                            <field.FormMessage className={classNames?.error} />
                                        </field.FormItem>
                                    )}
                                </form.AppField>

                                <form.AppField name="newPassword">
                                    {(field) => (
                                        <field.FormItem>
                                            <field.FormLabel className={classNames?.label}>{t`New Password`}</field.FormLabel>

                                            <field.FormControl>
                                                <PasswordInput
                                                    autoComplete="new-password"
                                                    className={classNames?.input}
                                                    enableToggle
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
                                                <field.FormLabel className={classNames?.label}>{t`Confirm Password`}</field.FormLabel>

                                                <field.FormControl>
                                                    <PasswordInput
                                                        autoComplete="new-password"
                                                        className={classNames?.input}
                                                        enableToggle
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
                            </>
                        )}
                    </CardContent>
                </SettingsCard>
            </form>
        </form.AppForm>
    );
};

const ChangePasswordCardWithAccounts = (properties: Omit<ChangePasswordCardContentProperties, "accounts" | "isPending">) => {
    const { authClient } = useAuth();
    const { data, isPending } = useListAccounts(authClient);

    return <ChangePasswordCardContent {...properties} accounts={data} isPending={isPending} />;
};

const ChangePasswordCard = ({ skipHook, ...properties }: ChangePasswordCardProperties) =>
    skipHook ? <ChangePasswordCardContent {...properties} /> : <ChangePasswordCardWithAccounts {...properties} />;

export default ChangePasswordCard;
