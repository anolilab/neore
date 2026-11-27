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

const ORGANIZATION_SLUG_RE = /^[a-z0-9-]+$/;

const OrganizationSlugForm = ({ className, classNames, ...properties }: SettingsCardProperties) => {
    const { authClient, toast } = useAuth();
    const { t } = useLingui();

    const formSchema = z.strictObject({
        slug: z
            .string()
            .min(1, { message: t`Organization slug is required` })
            .regex(ORGANIZATION_SLUG_RE, { message: t`Organization slug is invalid` }),
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
            slug: activeOrganization?.slug || "",
        },
        onSubmit: async ({ value }) => {
            if (!activeOrganization) {
                return;
            }

            if (activeOrganization.slug === value.slug) {
                toast({
                    message: t`Organization slug is the same`,
                    variant: "error",
                });

                return;
            }

            try {
                await authClient.organization.update({
                    data: { slug: value.slug },
                    fetchOptions: {
                        throw: true,
                    },
                });

                await refetchActiveOrganization?.();
                await refetchOrganizations?.();

                toast({
                    message: t`Organization slug updated successfully`,
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
                            description={t`Change your organization's unique identifier`}
                            instructions={t`This is your organization's URL namespace`}
                            title={t`Organization Slug`}
                        >
                            {isPending ? (
                                <Skeleton className={cn("h-9 w-full", classNames?.skeleton)} />
                            ) : (
                                <form.AppField name="slug">
                                    {(field) => (
                                        <field.FormItem>
                                            <field.FormControl>
                                                <Input
                                                    aria-label={t`Organization Slug`}
                                                    className={classNames?.input}
                                                    disabled={isSubmitting || !hasPermission?.success}
                                                    onBlur={field.handleBlur}
                                                    onChange={(e) => {
                                                        field.handleChange(e.target.value);
                                                    }}
                                                    placeholder={t`Enter organization slug`}
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

const OrganizationSlugCard = ({ className, classNames, ...properties }: SettingsCardProperties) => {
    const { authClient } = useAuth();
    const { t } = useLingui();

    const { data: activeOrganization } = useActiveOrganization(authClient);

    if (!activeOrganization) {
        return (
            <SettingsCard actionLabel={t`Save`} className={className} classNames={hideCardHeader(classNames)} isPending {...properties}>
                <CardContent className={classNames?.content}>
                    <SettingsFieldRow
                        description={t`Change your organization's unique identifier`}
                        instructions={t`This is your organization's URL namespace`}
                        title={t`Organization Slug`}
                    >
                        <Skeleton className={cn("h-9 w-full", classNames?.skeleton)} />
                    </SettingsFieldRow>
                </CardContent>
            </SettingsCard>
        );
    }

    return <OrganizationSlugForm className={className} classNames={classNames} {...properties} />;
};

export default OrganizationSlugCard;
