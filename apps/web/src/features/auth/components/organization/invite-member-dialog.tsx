"use client";

import { useLingui } from "@lingui/react/macro";
import { Button } from "@neore/ui/components/button";
import { useAppForm } from "@neore/ui/components/form";
import { Input } from "@neore/ui/components/input";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@neore/ui/components/responsive-dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@neore/ui/components/select";
import cn from "@neore/ui/utils/cn";
import { Loader2 } from "lucide-react";
import type { ComponentProps } from "react";
import * as z from "zod";

import type { SettingsCardClassNames } from "@/components/settings/settings-card";
import { useActiveOrganization } from "@/features/auth/hooks/organization-management";
import { useSession } from "@/features/auth/hooks/session-user-management";
import { useAuth } from "@/features/auth/lib/auth-ui-provider";
import emailSchema from "@/features/auth/validators/email-schema";

import { getLocalizedError } from "../../lib/utilities";

export interface InviteMemberDialogProperties extends ComponentProps<typeof Dialog> {
    classNames?: SettingsCardClassNames;
}

const InviteMemberDialog = ({ classNames, onOpenChange, ...properties }: InviteMemberDialogProperties) => {
    const { authClient, organization, toast } = useAuth();
    const { t } = useLingui();

    const { data: activeOrganization, refetch: refetchActiveOrganization } = useActiveOrganization(authClient);
    const { data: sessionData } = useSession(authClient);
    const membership = activeOrganization?.members.find((m) => m.userId === sessionData?.user.id);

    const builtInRoles = [
        { label: t`Owner`, role: "owner" },
        { label: t`Admin`, role: "admin" },
        { label: t`Member`, role: "member" },
    ] as const;

    const roles = [...builtInRoles, ...(organization?.customRoles || [])];
    const availableRoles = roles.filter((role) => membership?.role === "owner" || role.role !== "owner");

    const formSchema = z.strictObject({
        email: emailSchema,
        role: z.string().min(1, {
            message: t`Role is required`,
        }),
    });

    const form = useAppForm({
        defaultValues: {
            email: "",
            role: "member",
        },
        onSubmit: async ({ value }) => {
            try {
                await authClient.organization.inviteMember({
                    email: value.email,
                    fetchOptions: { throw: true },
                    organizationId: activeOrganization?.id,
                    role: value.role as (typeof builtInRoles)[number]["role"],
                });

                await refetchActiveOrganization?.();

                onOpenChange?.(false);
                form.reset();

                toast({
                    message: t`Invitation sent successfully`,
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
            onChange: ({ value }) => formSchema.safeParse(value),
        },
    });

    return (
        <Dialog onOpenChange={onOpenChange} {...properties}>
            <DialogContent className={classNames?.dialog?.content}>
                <DialogHeader className={classNames?.dialog?.header}>
                    <DialogTitle className={cn("text-lg md:text-xl", classNames?.title)}>{t`Invite Member`}</DialogTitle>

                    <DialogDescription className={cn("text-xs md:text-sm", classNames?.description)}>
                        {t`Invite a new member to join your organization`}
                    </DialogDescription>
                </DialogHeader>

                <form.AppForm>
                    <form
                        className="space-y-6"
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
                                            onBlur={field.handleBlur}
                                            onChange={(e) => {
                                                field.handleChange(e.target.value);
                                            }}
                                            placeholder={t`Enter email address`}
                                            type="email"
                                            value={field.state.value}
                                        />
                                    </field.FormControl>

                                    <field.FormMessage />
                                </field.FormItem>
                            )}
                        </form.AppField>

                        <form.AppField name="role">
                            {(field) => (
                                <field.FormItem>
                                    <field.FormLabel className={classNames?.label}>{t`Role`}</field.FormLabel>

                                    <Select onValueChange={(value) => field.handleChange(value ?? "")} value={field.state.value}>
                                        <field.FormControl>
                                            <SelectTrigger>
                                                <SelectValue />
                                            </SelectTrigger>
                                        </field.FormControl>

                                        <SelectContent>
                                            {availableRoles.map((role) => (
                                                <SelectItem key={role.role} value={role.role}>
                                                    {role.label}
                                                </SelectItem>
                                            ))}
                                        </SelectContent>
                                    </Select>

                                    <field.FormMessage />
                                </field.FormItem>
                            )}
                        </form.AppField>

                        <DialogFooter className={classNames?.dialog?.footer}>
                            <form.Subscribe selector={(state) => ({ canSubmit: state.canSubmit, isSubmitting: state.isSubmitting }) as unknown as typeof state}>
                                {({ canSubmit, isSubmitting }) => (
                                    <Button className={classNames?.button} disabled={!canSubmit} type="submit">
                                        {isSubmitting && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                                        {t`Send Invitation`}
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

export default InviteMemberDialog;
