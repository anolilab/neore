"use client";

import { Trans, useLingui } from "@lingui/react/macro";
import { Button } from "@neore/ui/components/button";
import { Card } from "@neore/ui/components/card";
import { useAppForm } from "@neore/ui/components/form";
import { Input } from "@neore/ui/components/input";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@neore/ui/components/responsive-dialog";
import cn from "@neore/ui/utils/cn";
import { Loader2 } from "lucide-react";
import type { ComponentProps } from "react";
import * as z from "zod";

import type { SettingsCardClassNames } from "@/components/settings/settings-card";
import { useActiveOrganization, useListOrganizations } from "@/features/auth/hooks/organization-management";
import { useAuth } from "@/features/auth/lib/auth-ui-provider";

import { getLocalizedError } from "../../lib/utilities";
import OrganizationView from "./organization-view";

export interface DeleteOrganizationDialogProperties extends ComponentProps<typeof Dialog> {
    classNames?: SettingsCardClassNames;
}

const DeleteOrganizationDialog = ({ classNames, onOpenChange, ...properties }: DeleteOrganizationDialogProperties) => {
    const { authClient, navigate, redirectTo, toast } = useAuth();
    const { t } = useLingui();

    const formSchema = z.strictObject({
        slug: z.string().min(1, { message: t`Organization slug is required` }),
    });

    const { data: activeOrganization, refetch: refetchActiveOrganization } = useActiveOrganization(authClient);
    const { refetch: refetchOrganizations } = useListOrganizations(authClient);

    const form = useAppForm({
        defaultValues: {
            slug: "",
        },
        onSubmit: async ({ value: _value }) => {
            if (!activeOrganization) {
                return;
            }

            try {
                await authClient.organization.delete({
                    fetchOptions: {
                        throw: true,
                    },
                    organizationId: activeOrganization.id,
                });

                await refetchOrganizations?.();
                await refetchActiveOrganization?.();

                toast({
                    message: t`Organization deleted successfully`,
                    variant: "success",
                });
                navigate(redirectTo);
                onOpenChange?.(false);
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

                if (value.slug !== activeOrganization?.slug) {
                    return t`Slug does not match`;
                }

                return undefined;
            },
        },
    });

    return (
        <Dialog onOpenChange={onOpenChange} {...properties}>
            <DialogContent className={cn("sm:max-w-md", classNames?.dialog?.content)}>
                <DialogHeader className={classNames?.dialog?.header}>
                    <DialogTitle className={cn("text-lg md:text-xl", classNames?.title)}>{t`Delete Organization`}</DialogTitle>

                    <DialogDescription className={cn("text-xs md:text-sm", classNames?.description)}>
                        {t`This action cannot be undone. This will permanently delete the organization and all associated data.`}
                    </DialogDescription>
                </DialogHeader>

                <Card className={cn("my-2 flex-row p-4", classNames?.cell)}>
                    <OrganizationView organization={activeOrganization} />
                </Card>

                <form.AppForm>
                    <form
                        className="grid gap-6"
                        onSubmit={(e) => {
                            e.preventDefault();
                            e.stopPropagation();
                            form.handleSubmit();
                        }}
                    >
                        <form.AppField name="slug">
                            {(field) => (
                                <field.FormItem>
                                    <field.FormLabel className={classNames?.label}>
                                        <Trans>
                                            Please type <span className="font-bold">{activeOrganization?.slug}</span> to confirm
                                        </Trans>
                                    </field.FormLabel>

                                    <field.FormControl>
                                        <Input
                                            autoComplete="off"
                                            className={classNames?.input}
                                            onBlur={field.handleBlur}
                                            onChange={(e) => {
                                                field.handleChange(e.target.value);
                                            }}
                                            placeholder={activeOrganization?.slug}
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

                            <form.Subscribe selector={(state) => ({ canSubmit: state.canSubmit, isSubmitting: state.isSubmitting }) as unknown as typeof state}>
                                {({ canSubmit, isSubmitting }) => (
                                    <Button
                                        className={cn(classNames?.button, classNames?.destructiveButton)}
                                        disabled={!canSubmit || isSubmitting}
                                        type="submit"
                                        variant="destructive"
                                    >
                                        {isSubmitting && <Loader2 className="animate-spin" />}
                                        {t`Delete Organization`}
                                    </Button>
                                )}
                            </form.Subscribe>
                        </DialogFooter>
                    </form>
                </form.AppForm>
            </DialogContent>
        </Dialog>
    );
};

export default DeleteOrganizationDialog;
