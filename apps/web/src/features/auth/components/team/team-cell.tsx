"use client";

import { Plural, useLingui } from "@lingui/react/macro";
import { Button } from "@neore/ui/components/button";
import { Card } from "@neore/ui/components/card";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@neore/ui/components/responsive-dropdown-menu";
import cn from "@neore/ui/utils/cn";
import { EllipsisIcon, LogOutIcon, TrashIcon, UsersIcon } from "lucide-react";
import { useState } from "react";

import type { SettingsCardClassNames } from "@/components/settings/settings-card";
import { useActiveOrganization } from "@/features/auth/hooks/organization-management";
import { useAuth } from "@/features/auth/lib/auth-ui-provider";

import DeleteTeamDialog from "./delete-team-dialog";
import LeaveTeamDialog from "./leave-team-dialog";
import TeamMembersDialog from "./team-members-dialog";

export interface Team {
    createdAt: number;
    id: string;
    memberCount: number;
    name: string;
    updatedAt?: number | null;
}

export interface TeamCellProperties {
    className?: string;
    classNames?: SettingsCardClassNames;
    refetchTeams?: () => void;
    team: Team;
}

const TeamCell = ({ className, classNames, refetchTeams, team }: TeamCellProperties) => {
    const { authClient } = useAuth();
    const { t } = useLingui();

    const { data: activeOrganization } = useActiveOrganization(authClient);
    const isOwner = activeOrganization?.members?.some((m) => m.role === "owner");

    const [isMembersDialogOpen, setIsMembersDialogOpen] = useState(false);
    const [isLeaveDialogOpen, setIsLeaveDialogOpen] = useState(false);
    const [isDeleteDialogOpen, setIsDeleteDialogOpen] = useState(false);

    return (
        <>
            <Card className={cn("flex-row items-center p-4", className, classNames?.cell)}>
                <div className="flex flex-col gap-1">
                    <span className="font-medium">{team.name}</span>
                    <span className="text-muted-foreground text-sm">
                        <Plural one="# member" other="# members" value={team.memberCount} />
                    </span>
                </div>

                <DropdownMenu>
                    <DropdownMenuTrigger
                        render={
                            <Button
                                className={cn("relative ms-auto", classNames?.button, classNames?.outlineButton)}
                                size="icon"
                                type="button"
                                variant="outline"
                            >
                                <EllipsisIcon className={classNames?.icon} />
                            </Button>
                        }
                    />

                    <DropdownMenuContent>
                        <DropdownMenuItem onClick={() => setIsMembersDialogOpen(true)}>
                            <UsersIcon className={classNames?.icon} />
                            {t`Manage Members`}
                        </DropdownMenuItem>

                        <DropdownMenuItem onClick={() => setIsLeaveDialogOpen(true)} variant="destructive">
                            <LogOutIcon className={classNames?.icon} />
                            {t`Leave Team`}
                        </DropdownMenuItem>

                        {isOwner && (
                            <DropdownMenuItem onClick={() => setIsDeleteDialogOpen(true)} variant="destructive">
                                <TrashIcon className={classNames?.icon} />
                                {t`Delete Team`}
                            </DropdownMenuItem>
                        )}
                    </DropdownMenuContent>
                </DropdownMenu>
            </Card>

            <TeamMembersDialog
                classNames={classNames}
                onOpenChange={setIsMembersDialogOpen}
                open={isMembersDialogOpen}
                refetchTeams={refetchTeams}
                team={team}
            />

            <LeaveTeamDialog classNames={classNames} onOpenChange={setIsLeaveDialogOpen} open={isLeaveDialogOpen} refetchTeams={refetchTeams} team={team} />

            <DeleteTeamDialog classNames={classNames} onOpenChange={setIsDeleteDialogOpen} open={isDeleteDialogOpen} refetchTeams={refetchTeams} team={team} />
        </>
    );
};

export default TeamCell;
