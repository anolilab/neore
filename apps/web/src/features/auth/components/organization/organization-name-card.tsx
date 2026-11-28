"use client";

import { useLingui } from "@lingui/react/macro";
import { CardContent } from "@neore/ui/components/card";
import { useAppForm } from "@neore/ui/components/form";
import { Input } from "@neore/ui/components/input";
import { Skeleton } from "@neore/ui/components/skeleton";
import cn from "@neore/ui/utils/cn";
import * as z from "zod";

import type { SettingsCardProperties } from "@/components/settings/settings-card";
import SettingsCard from "@/components/settings/settings-card";
import { useActiveOrganization, useHasPermission, useListOrganizations } from "@/features/auth/hooks/organization-management";
import { useAuth } from "@/features/auth/lib/auth-ui-provider";

import { getLocalizedError } from "../../lib/utilities";
import SettingsFieldRow, { hideCardHeader } from "../settings/settings-field-row";

const OrganizationNameForm = ({ className, classNames, ...properties }: SettingsCardProperties) => {
    const { authClient, toast } = useAuth();
    const { t } = useLingui();

    const formSchema = z.strictObject({
        name: z.string().min(1, { message: t`Organization name is required` }),
    });

    const { data: activeOrganization, refetch: refetchActiveOrganization } = useActiveOrganization(authClient);
    const { refetch: refetchOrganizations } = useListOrganizations(authClient);
    const { data: hasPermission, isPending } = useHasPermission(authClient, {
        permissions: {
            organization: ["update"],
        },
    });

    const form = useAppForm({
        defaultValues: {
            name: activeOrganization?.name || "",
        },
        onSubmit: async ({ value }) => {
            if (!activeOrganization) {
                return;
            }

            if (activeOrganization.name === value.name) {
                toast({
                    message: t`Organization name is the same`,
                    variant: "error",
                });

                return;
            }

            try {
                await authClient.organization.update({
                    data: { name: value.name },
                    fetchOptions: {
                        throw: true,
                    },
                });

                await refetchActiveOrganization?.();
                await refetchOrganizations?.();

                toast({
                    message: t`Organization name updated successfully`,
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
                    classNames={hideCardHeader(classNames)}
                    disabled={!hasPermission?.success}
                    isPending={isPending}
                    {...properties}
                >
                    <CardContent className={classNames?.content}>
                        <SettingsFieldRow
                            description={t`Change your organization's display name`}
                            instructions={t`This is how your organization appears to members`}
                            title={t`Organization Name`}
                        >
                            {isPending ? (
                                <Skeleton className={cn("h-9 w-full", classNames?.skeleton)} />
                            ) : (
                                <form.AppField name="name">
                                    {(field) => (
                                        <field.FormItem>
                                            <field.FormControl>
                                                <Input
                                                    aria-label={t`Organization Name`}
                                                    autoComplete="organization"
                                                    className={classNames?.input}
                                                    disabled={isSubmitting || !hasPermission?.success}
                                                    onBlur={field.handleBlur}
                                                    onChange={(e) => {
                                                        field.handleChange(e.target.value);
                                                    }}
                                                    placeholder={t`Enter organization name`}
                                                    value={field.state.value}
                                                />
                                            </field.FormControl>

                                            <field.FormMessage className={classNames?.error} />
                                        </field.FormItem>
                                    )}
                                </form.AppField>
                            )}
                        </SettingsFieldRow>
                    </CardContent>
                </SettingsCard>
            </form>
        </form.AppForm>
    );
};

const OrganizationNameCard = ({ className, classNames, ...properties }: SettingsCardProperties) => {
    const { authClient } = useAuth();
    const { t } = useLingui();

    const { data: activeOrganization } = useActiveOrganization(authClient);

    if (!activeOrganization) {
        return (
            <SettingsCard actionLabel={t`Save`} className={className} classNames={hideCardHeader(classNames)} isPending {...properties}>
                <CardContent className={classNames?.content}>
                    <SettingsFieldRow
                        description={t`Change your organization's display name`}
                        instructions={t`This is how your organization appears to members`}
                        title={t`Organization Name`}
                    >
                        <Skeleton className={cn("h-9 w-full", classNames?.skeleton)} />
                    </SettingsFieldRow>
                </CardContent>
            </SettingsCard>
        );
    }

    return <OrganizationNameForm className={className} classNames={classNames} {...properties} />;
};

export default OrganizationNameCard;
