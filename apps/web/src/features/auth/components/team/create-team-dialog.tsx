"use client";

import { useLingui } from "@lingui/react/macro";
import { Button } from "@neore/ui/components/button";
import { useAppForm } from "@neore/ui/components/form";
import { Input } from "@neore/ui/components/input";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@neore/ui/components/responsive-dialog";
import cn from "@neore/ui/utils/cn";
import { useMutation } from "@tanstack/react-query";
import { Loader2 } from "lucide-react";
import type { ComponentProps } from "react";
import * as z from "zod";

import type { SettingsCardClassNames } from "@/components/settings/settings-card";
import { useAuth } from "@/features/auth/lib/auth-ui-provider";
import { useCRPC } from "@/lib/lunora/crpc";

import { getLocalizedError } from "../../lib/utilities";

export interface CreateTeamDialogProperties extends ComponentProps<typeof Dialog> {
    className?: string;
    classNames?: SettingsCardClassNames;
    refetchTeams?: () => void;
}

const CreateTeamDialog = ({ className: _className, classNames, onOpenChange, refetchTeams, ...properties }: CreateTeamDialogProperties) => {
    const { toast } = useAuth();
    const { t } = useLingui();
    const crpc = useCRPC();

    const createTeamMutation = useMutation(crpc.auth.team.createTeam.mutationOptions());

    const formSchema = z.strictObject({
        name: z.string().min(1, {
            message: t`Team name is required`,
        }),
    });

    const form = useAppForm({
        defaultValues: {
            name: "",
        },
        onSubmit: async ({ value }) => {
            try {
                await createTeamMutation.mutateAsync({
                    name: value.name,
                });

                await refetchTeams?.();
                onOpenChange?.(false);
                form.reset();

                toast({
                    message: t`Team created successfully`,
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
                    <DialogTitle className={cn("text-lg md:text-xl", classNames?.title)}>{t`Create Team`}</DialogTitle>

                    <DialogDescription className={cn("text-xs md:text-sm", classNames?.description)}>
                        {t`Create a new team to organize members within your organization`}
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
                        <form.AppField name="name">
                            {(field) => (
                                <field.FormItem>
                                    <field.FormLabel>{t`Team Name`}</field.FormLabel>

                                    <field.FormControl>
                                        <Input
                                            onBlur={field.handleBlur}
                                            onChange={(e) => {
                                                field.handleChange(e.target.value);
                                            }}
                                            placeholder={t`Enter team name`}
                                            value={field.state.value}
                                        />
                                    </field.FormControl>

                                    <field.FormMessage />
                                </field.FormItem>
                            )}
                        </form.AppField>

                        <DialogFooter className={classNames?.dialog?.footer}>
                            <Button
                                className={cn(classNames?.button, classNames?.outlineButton)}
                                onClick={() => onOpenChange?.(false)}
                                type="button"
                                variant="outline"
                            >
                                {t`Cancel`}
                            </Button>

                            <form.Subscribe selector={(state) => ({ canSubmit: state.canSubmit, isSubmitting: state.isSubmitting }) as unknown as typeof state}>
                                {({ canSubmit, isSubmitting }) => (
                                    <Button className={cn(classNames?.button, classNames?.primaryButton)} disabled={!canSubmit} type="submit">
                                        {isSubmitting && <Loader2 className="animate-spin" />}

                                        {t`Create Team`}
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

export default CreateTeamDialog;
