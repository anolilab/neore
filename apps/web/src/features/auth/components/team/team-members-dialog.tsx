"use client";

import { Trans, useLingui } from "@lingui/react/macro";
import { Button } from "@neore/ui/components/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@neore/ui/components/responsive-dialog";
import { Skeleton } from "@neore/ui/components/skeleton";
import cn from "@neore/ui/utils/cn";
import { useQuery } from "@tanstack/react-query";
import { PlusIcon } from "lucide-react";
import type { ComponentProps } from "react";
import { useState } from "react";

import type { SettingsCardClassNames } from "@/components/settings/settings-card";
import { useActiveOrganization } from "@/features/auth/hooks/organization-management";
import { useAuth } from "@/features/auth/lib/auth-ui-provider";
import { useCRPC } from "@/lib/lunora/crpc";

import AddTeamMemberDialog from "./add-team-member-dialog";
import type { Team } from "./team-cell";
import type { TeamMember } from "./team-member-cell";
import TeamMemberCell from "./team-member-cell";

export interface TeamMembersDialogProperties extends ComponentProps<typeof Dialog> {
    className?: string;
    classNames?: SettingsCardClassNames;
    refetchTeams?: () => void;
    team: Team;
}

const TeamMembersDialog = ({ className: _className, classNames, onOpenChange, refetchTeams, team, ...properties }: TeamMembersDialogProperties) => {
    const { authClient } = useAuth();
    const { t } = useLingui();
    const crpc = useCRPC();

    const { data: activeOrganization } = useActiveOrganization(authClient);
    const isOwner = activeOrganization?.members?.some((m) => m.role === "owner");

    const {
        data: members,
        isPending,
        refetch: refetchMembers,
    } = useQuery({
        ...crpc.auth.team.listTeamMembers.queryOptions({ teamId: team.id }),
        enabled: properties.open,
    });

    const [isAddMemberDialogOpen, setIsAddMemberDialogOpen] = useState(false);

    const handleRefetch = () => {
        refetchMembers();
        refetchTeams?.();
    };

    return (
        <>
            <Dialog onOpenChange={onOpenChange} {...properties}>
                <DialogContent className={cn("max-w-lg", classNames?.dialog?.content)}>
                    <DialogHeader className={classNames?.dialog?.header}>
                        <DialogTitle className={cn("text-lg md:text-xl", classNames?.title)}>{t`Team Members`}</DialogTitle>

                        <DialogDescription className={cn("text-xs md:text-sm", classNames?.description)}>
                            <Trans>
                                Manage members of <strong>{team.name}</strong>
                            </Trans>
                        </DialogDescription>
                    </DialogHeader>

                    <div className="flex flex-col gap-4">
                        {isOwner && (
                            <Button className="w-full" onClick={() => setIsAddMemberDialogOpen(true)} variant="outline">
                                <PlusIcon className="mr-2 size-4" />
                                {t`Add Member`}
                            </Button>
                        )}

                        {isPending && (
                            <div className="flex flex-col gap-2">
                                <Skeleton className="h-16 w-full" />
                                <Skeleton className="h-16 w-full" />
                            </div>
                        )}
                        {!isPending &&
                            (members && members.length > 0 ? (
                                <div className="flex max-h-80 flex-col gap-2 overflow-y-auto">
                                    {members.map((member: TeamMember) => (
                                        <TeamMemberCell
                                            classNames={classNames}
                                            isOwner={isOwner}
                                            key={member.id}
                                            member={member}
                                            refetchMembers={handleRefetch}
                                            teamId={team.id}
                                        />
                                    ))}
                                </div>
                            ) : (
                                <p className="text-muted-foreground py-4 text-center text-sm">{t`No members in this team yet`}</p>
                            ))}
                    </div>
                </DialogContent>
            </Dialog>

            <AddTeamMemberDialog
                classNames={classNames}
                onOpenChange={setIsAddMemberDialogOpen}
                open={isAddMemberDialogOpen}
                refetchMembers={handleRefetch}
                team={team}
            />
        </>
    );
};

export default TeamMembersDialog;
