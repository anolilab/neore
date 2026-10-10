"use client";

import { Trans, useLingui } from "@lingui/react/macro";
import { Button } from "@neore/ui/components/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@neore/ui/components/responsive-dialog";
import cn from "@neore/ui/utils/cn";
import { useMutation } from "@tanstack/react-query";
import { Loader2 } from "lucide-react";
import type { ComponentProps } from "react";
import { useState } from "react";

import type { SettingsCardClassNames } from "@/components/settings/settings-card";
import { useAuth } from "@/features/auth/lib/auth-ui-provider";
import { useCRPC } from "@/lib/lunora/crpc";

import { getLocalizedError } from "../../lib/utilities";
import type { Team } from "./team-cell";

export interface DeleteTeamDialogProperties extends ComponentProps<typeof Dialog> {
    className?: string;
    classNames?: SettingsCardClassNames;
    refetchTeams?: () => void;
    team: Team;
}

const DeleteTeamDialog = ({ className: _className, classNames, onOpenChange, refetchTeams, team, ...properties }: DeleteTeamDialogProperties) => {
    const { toast } = useAuth();
    const { t } = useLingui();
    const crpc = useCRPC();

    const [isSubmitting, setIsSubmitting] = useState(false);

    const deleteTeamMutation = useMutation(crpc.auth.team.deleteTeam.mutationOptions());

    const handleDeleteTeam = async () => {
        setIsSubmitting(true);

        try {
            await deleteTeamMutation.mutateAsync({
                teamId: team.id,
            });

            refetchTeams?.();
            onOpenChange?.(false);

            toast({
                message: t`Team deleted successfully`,
                variant: "success",
            });
        } catch (error) {
            toast({
                message: getLocalizedError({ error, t }),
                variant: "error",
            });
        } finally {
            setIsSubmitting(false);
        }
    };

    return (
        <Dialog onOpenChange={onOpenChange} {...properties}>
            <DialogContent className={classNames?.dialog?.content}>
                <DialogHeader className={classNames?.dialog?.header}>
                    <DialogTitle className={cn("text-lg md:text-xl", classNames?.title)}>{t`Delete Team`}</DialogTitle>

                    <DialogDescription className={cn("text-xs md:text-sm", classNames?.description)}>
                        <Trans>
                            Are you sure you want to delete <strong>{team.name}</strong>?
                        </Trans>{" "}
                        {t`This action cannot be undone. All team members will be removed.`}
                    </DialogDescription>
                </DialogHeader>

                <DialogFooter className={classNames?.dialog?.footer}>
                    <Button className={cn(classNames?.button, classNames?.outlineButton)} onClick={() => onOpenChange?.(false)} type="button" variant="outline">
                        {t`Cancel`}
                    </Button>

                    <Button
                        className={cn(classNames?.button, classNames?.destructiveButton)}
                        disabled={isSubmitting}
                        onClick={handleDeleteTeam}
                        type="button"
                        variant="destructive"
                    >
                        {isSubmitting && <Loader2 className="animate-spin" />}
                        {t`Delete Team`}
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
};

export default DeleteTeamDialog;
