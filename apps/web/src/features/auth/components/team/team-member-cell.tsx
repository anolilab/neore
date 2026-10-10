"use client";

import { useLingui } from "@lingui/react/macro";
import { Avatar, AvatarFallback, AvatarImage } from "@neore/ui/components/avatar";
import { Badge } from "@neore/ui/components/badge";
import { Button } from "@neore/ui/components/button";
import { Card } from "@neore/ui/components/card";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@neore/ui/components/responsive-dropdown-menu";
import cn from "@neore/ui/utils/cn";
import { useMutation } from "@tanstack/react-query";
import { ChevronDown, Loader2, Shield, User, XIcon } from "lucide-react";
import { useState } from "react";

import type { SettingsCardClassNames } from "@/components/settings/settings-card";
import { useAuth } from "@/features/auth/lib/auth-ui-provider";
import { useCRPC } from "@/lib/lunora/crpc";

import { getLocalizedError } from "../../lib/utilities";

export interface TeamMember {
    createdAt?: number | null;
    id: string;
    role: "admin" | "member";
    user: {
        email: string;
        id: string;
        image?: string | null;
        name: string | null;
    };
    userId: string;
}

export interface TeamMemberCellProperties {
    canManageRoles?: boolean;
    className?: string;
    classNames?: SettingsCardClassNames;
    isOwner?: boolean;
    member: TeamMember;
    refetchMembers?: () => void;
    teamId: string;
}

const TeamMemberCell = ({ canManageRoles, className, classNames, isOwner, member, refetchMembers, teamId }: TeamMemberCellProperties) => {
    const { toast } = useAuth();
    const { t } = useLingui();
    const crpc = useCRPC();

    const [isRemoving, setIsRemoving] = useState(false);
    const [isUpdatingRole, setIsUpdatingRole] = useState(false);

    const removeTeamMemberMutation = useMutation(crpc.auth.team.removeTeamMember.mutationOptions());
    const updateTeamMemberRoleMutation = useMutation(crpc.auth.team.updateTeamMemberRole.mutationOptions());

    const handleRemoveMember = async () => {
        setIsRemoving(true);

        try {
            await removeTeamMemberMutation.mutateAsync({
                teamId,
                userId: member.userId,
            });

            if (refetchMembers) {
                refetchMembers();
            }

            toast({
                message: t`Member removed from team`,
                variant: "success",
            });
        } catch (error) {
            toast({
                message: getLocalizedError({ error, t }),
                variant: "error",
            });
        }

        setIsRemoving(false);
    };

    const handleRoleChange = async (newRole: "admin" | "member") => {
        if (newRole === member.role) {
            return;
        }

        setIsUpdatingRole(true);

        try {
            await updateTeamMemberRoleMutation.mutateAsync({
                role: newRole,
                teamId,
                userId: member.userId,
            });

            if (refetchMembers) {
                refetchMembers();
            }

            toast({
                message: t`Member role updated successfully`,
                variant: "success",
            });
        } catch (error) {
            toast({
                message: getLocalizedError({ error, t }),
                variant: "error",
            });
        }

        setIsUpdatingRole(false);
    };

    const initials = member.user.name
        ? member.user.name
              .split(" ")
              .map((n) => n[0])
              .join("")
              .toUpperCase()
              .slice(0, 2)
        : (member.user.email[0]?.toUpperCase() ?? "");

    const currentRole = member.role;

    return (
        <Card className={cn("flex-row items-center gap-3 p-3", className, classNames?.cell)}>
            <Avatar className="size-10">
                <AvatarImage alt={member.user.name || member.user.email} src={member.user.image || undefined} />
                <AvatarFallback name={member.user.name || member.user.email}>{initials}</AvatarFallback>
            </Avatar>

            <div className="flex flex-1 flex-col">
                <span className="text-sm font-medium">{member.user.name || t`Unknown`}</span>
                <span className="text-muted-foreground text-xs">{member.user.email}</span>
            </div>

            {/* Role Badge/Dropdown */}
            {canManageRoles ? (
                <DropdownMenu>
                    <DropdownMenuTrigger render={<Button className="gap-1" disabled={isUpdatingRole} size="sm" variant="outline" />}>
                        {isUpdatingRole && <Loader2 className="size-3 animate-spin" />}
                        {!isUpdatingRole && (currentRole === "admin" ? <Shield className="size-3" /> : <User className="size-3" />)}
                        {currentRole === "admin" ? t`Admin` : t`Member`}
                        <ChevronDown className="size-3" />
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end">
                        <DropdownMenuItem className={cn(currentRole === "admin" && "bg-accent")} onClick={() => handleRoleChange("admin")}>
                            <Shield className="mr-2 size-4" />
                            {t`Admin`}
                            <span className="text-muted-foreground ml-2 text-xs">{t`Can manage team settings and members`}</span>
                        </DropdownMenuItem>
                        <DropdownMenuItem className={cn(currentRole === "member" && "bg-accent")} onClick={() => handleRoleChange("member")}>
                            <User className="mr-2 size-4" />
                            {t`Member`}
                            <span className="text-muted-foreground ml-2 text-xs">{t`Can use team resources`}</span>
                        </DropdownMenuItem>
                    </DropdownMenuContent>
                </DropdownMenu>
            ) : (
                <Badge variant={currentRole === "admin" ? "default" : "secondary"}>
                    {currentRole === "admin" ? (
                        <>
                            <Shield className="mr-1 size-3" />
                            {t`Admin`}
                        </>
                    ) : (
                        <>
                            <User className="mr-1 size-3" />
                            {t`Member`}
                        </>
                    )}
                </Badge>
            )}

            {isOwner && (
                <Button disabled={isRemoving} onClick={handleRemoveMember} size="icon" variant="ghost">
                    {isRemoving ? <Loader2 className="size-4 animate-spin" /> : <XIcon className="size-4" />}
                </Button>
            )}
        </Card>
    );
};

export default TeamMemberCell;
