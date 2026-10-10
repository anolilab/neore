"use client";

import { useLingui } from "@lingui/react/macro";
import { Button } from "@neore/ui/components/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@neore/ui/components/responsive-dropdown-menu";
import { Skeleton } from "@neore/ui/components/skeleton";
import cn from "@neore/ui/utils/cn";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Building, Check, ChevronsUpDown, Users } from "lucide-react";
import type { ComponentProps } from "react";
import { useCallback, useState } from "react";

import { useAuth } from "@/features/auth/lib/auth-ui-provider";
import { useCRPC } from "@/lib/lunora/crpc";

import { getLocalizedError } from "../../lib/utilities";

/**
 * An entry of `auth_team.getMyTeams`, mirroring the generated return type in
 * `@neore/backend/api`. Note this is NOT the `Team` of `team-cell.tsx` — that
 * one carries `memberCount` and no `role`.
 */
interface MyTeam {
    createdAt: number;
    id: string;
    name: string;
    role: "admin" | "member";
}

export interface TeamSwitcherProps extends Omit<ComponentProps<typeof Button>, "children"> {
    showAllOrganization?: boolean;
}

const TeamSwitcher = ({ className, showAllOrganization = true, ...props }: TeamSwitcherProps) => {
    const { hooks, toast } = useAuth();
    const { t } = useLingui();
    const crpc = useCRPC();
    const queryClient = useQueryClient();

    const { data: activeOrganization, isPending: isOrgPending } = hooks.useActiveOrganization();

    // Only fetch teams when in an organization
    const { data: myTeams, isPending: isTeamsPending } = useQuery(crpc.auth.team.getMyTeams.queryOptions(activeOrganization ? {} : undefined));

    const { mutateAsync: setActiveTeamAsync } = useMutation(crpc.auth.team.setActiveTeam.mutationOptions());

    const [activeTeamId, setActiveTeamId] = useState<string | null>(null);
    const [isChangingTeam, setIsChangingTeam] = useState(false);

    const isPending = isOrgPending || isTeamsPending || isChangingTeam;

    const activeTeam: MyTeam | undefined = myTeams?.find((team: MyTeam) => team.id === activeTeamId);

    const handleTeamChange = useCallback(
        async (teamId: string | null) => {
            if (teamId === activeTeamId) {
                return;
            }

            setIsChangingTeam(true);

            try {
                await setActiveTeamAsync({
                    teamId,
                });

                setActiveTeamId(teamId);

                // Invalidate thread queries to refetch with new team filter
                await queryClient.invalidateQueries({ queryKey: ["chat", "threads"] });

                toast({
                    message: teamId ? t`Switched to team view` : t`Switched to organization view`,
                    variant: "success",
                });
            } catch (error) {
                toast({
                    message: getLocalizedError({ error, t }),
                    variant: "error",
                });
            } finally {
                setIsChangingTeam(false);
            }
        },
        [activeTeamId, setActiveTeamAsync, queryClient, toast, t],
    );

    // Don't show if not in an organization
    if (!activeOrganization) {
        return null;
    }

    // Don't show if no teams exist
    if (!isTeamsPending && (!myTeams || myTeams.length === 0)) {
        return null;
    }

    return (
        <DropdownMenu>
            <DropdownMenuTrigger render={<Button className={cn("justify-start gap-2", className)} variant="ghost" {...props} />}>
                {isPending && <Skeleton className="h-4 w-24" />}
                {!isPending &&
                    (activeTeam ? (
                        <>
                            <Users className="size-4" />
                            <span className="truncate">{activeTeam.name}</span>
                        </>
                    ) : (
                        <>
                            <Building className="size-4" />
                            <span className="truncate">{t`All Organization`}</span>
                        </>
                    ))}
                <ChevronsUpDown className="ml-auto size-4 opacity-50" />
            </DropdownMenuTrigger>

            <DropdownMenuContent align="start" className="w-[--radix-dropdown-menu-trigger-width] min-w-56">
                {/* All Organization Option */}
                {showAllOrganization && (
                    <>
                        <DropdownMenuItem className="gap-2" onClick={() => handleTeamChange(null)}>
                            <Building className="size-4" />
                            <span className="flex-1">{t`All Organization`}</span>
                            {activeTeamId === null && <Check className="size-4" />}
                        </DropdownMenuItem>
                        <DropdownMenuSeparator />
                    </>
                )}

                {/* Team List */}
                {isTeamsPending && (
                    <div className="p-2">
                        <Skeleton className="h-8 w-full" />
                        <Skeleton className="mt-1 h-8 w-full" />
                    </div>
                )}
                {!isTeamsPending &&
                    (myTeams && myTeams.length > 0 ? (
                        myTeams.map((team: MyTeam) => (
                            <DropdownMenuItem className="gap-2" key={team.id} onClick={() => handleTeamChange(team.id)}>
                                <Users className="size-4" />
                                <span className="flex-1 truncate">{team.name}</span>
                                {team.role === "admin" && <span className="text-muted-foreground text-xs">{t`Admin`}</span>}
                                {activeTeamId === team.id && <Check className="size-4" />}
                            </DropdownMenuItem>
                        ))
                    ) : (
                        <div className="text-muted-foreground p-2 text-center text-sm">{t`No teams available`}</div>
                    ))}
            </DropdownMenuContent>
        </DropdownMenu>
    );
};

export default TeamSwitcher;
