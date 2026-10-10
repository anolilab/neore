"use client";

import { Trans, useLingui } from "@lingui/react/macro";
import { Avatar, AvatarFallback, AvatarImage } from "@neore/ui/components/avatar";
import { Button } from "@neore/ui/components/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@neore/ui/components/responsive-dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@neore/ui/components/select";
import { Skeleton } from "@neore/ui/components/skeleton";
import cn from "@neore/ui/utils/cn";
import { useMutation } from "@tanstack/react-query";
import { Loader2 } from "lucide-react";
import type { ComponentProps } from "react";
import { useState } from "react";

import type { SettingsCardClassNames } from "@/components/settings/settings-card";
import { useActiveOrganization } from "@/features/auth/hooks/organization-management";
import { useAuth } from "@/features/auth/lib/auth-ui-provider";
import { useCRPC } from "@/lib/lunora/crpc";

import { getLocalizedError } from "../../lib/utilities";
import type { Team } from "./team-cell";

export interface AddTeamMemberDialogProperties extends ComponentProps<typeof Dialog> {
    className?: string;
    classNames?: SettingsCardClassNames;
    refetchMembers?: () => void;
    team: Team;
}

const AddTeamMemberDialog = ({ className: _className, classNames, onOpenChange, refetchMembers, team, ...properties }: AddTeamMemberDialogProperties) => {
    const { authClient, toast } = useAuth();
    const { t } = useLingui();
    const crpc = useCRPC();

    const { data: activeOrganization, isPending: isOrgPending } = useActiveOrganization(authClient);
    const [selectedUserId, setSelectedUserId] = useState<string | null>(null);
    const [isSubmitting, setIsSubmitting] = useState(false);

    const addTeamMemberMutation = useMutation(crpc.auth.team.addTeamMember.mutationOptions());

    // Get organization members that can be added to the team
    const organizationMembers = activeOrganization?.members || [];

    const handleAddMember = async () => {
        if (!selectedUserId) {
            return;
        }

        setIsSubmitting(true);

        try {
            await addTeamMemberMutation.mutateAsync({
                teamId: team.id,
                userId: selectedUserId,
            });

            refetchMembers?.();
            onOpenChange?.(false);
            setSelectedUserId(null);

            toast({
                message: t`Member added to team`,
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
                    <DialogTitle className={cn("text-lg md:text-xl", classNames?.title)}>{t`Add Team Member`}</DialogTitle>

                    <DialogDescription className={cn("text-xs md:text-sm", classNames?.description)}>
                        <Trans>
                            Add a member from your organization to <strong>{team.name}</strong>
                        </Trans>
                    </DialogDescription>
                </DialogHeader>

                <div className="space-y-4">
                    {isOrgPending ? (
                        <Skeleton className="h-10 w-full" />
                    ) : (
                        <Select onValueChange={setSelectedUserId} value={selectedUserId || undefined}>
                            <SelectTrigger>
                                <SelectValue placeholder={t`Select a member`} />
                            </SelectTrigger>
                            <SelectContent>
                                {organizationMembers.map((member) => {
                                    const initials = member.user.name
                                        ? member.user.name
                                              .split(" ")
                                              .map((n) => n[0])
                                              .join("")
                                              .toUpperCase()
                                              .slice(0, 2)
                                        : (member.user.email[0]?.toUpperCase() ?? "");

                                    return (
                                        <SelectItem key={member.id} value={member.userId}>
                                            <div className="flex items-center gap-2">
                                                <Avatar className="size-6">
                                                    <AvatarImage alt={member.user.name || member.user.email} src={member.user.image || undefined} />
                                                    <AvatarFallback className="text-xs" name={member.user.name || member.user.email}>
                                                        {initials}
                                                    </AvatarFallback>
                                                </Avatar>
                                                <span>{member.user.name || member.user.email}</span>
                                            </div>
                                        </SelectItem>
                                    );
                                })}
                            </SelectContent>
                        </Select>
                    )}
                </div>

                <DialogFooter className={classNames?.dialog?.footer}>
                    <Button
                        className={cn(classNames?.button, classNames?.outlineButton)}
                        onClick={() => {
                            onOpenChange?.(false);
                            setSelectedUserId(null);
                        }}
                        type="button"
                        variant="outline"
                    >
                        {t`Cancel`}
                    </Button>

                    <Button
                        className={cn(classNames?.button, classNames?.primaryButton)}
                        disabled={!selectedUserId || isSubmitting}
                        onClick={handleAddMember}
                        type="button"
                    >
                        {isSubmitting && <Loader2 className="animate-spin" />}
                        {t`Add Member`}
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
};

export default AddTeamMemberDialog;
