"use client";

import { useLingui } from "@lingui/react/macro";
import { CardContent } from "@neore/ui/components/card";
import useIsHydrated from "@neore/ui/hooks/use-hydrated";
import cn from "@neore/ui/utils/cn";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";

import type { SettingsCardProperties } from "@/components/settings/settings-card";
import SettingsCard from "@/components/settings/settings-card";
import { useActiveOrganization } from "@/features/auth/hooks/organization-management";
import { useAuth } from "@/features/auth/lib/auth-ui-provider";
import { useCRPC } from "@/lib/lunora/crpc";

import CreateTeamDialog from "./create-team-dialog";
import type { Team } from "./team-cell";
import TeamCell from "./team-cell";

const TeamsCard = ({ className, classNames, ...properties }: SettingsCardProperties) => {
    const { authClient } = useAuth();
    const { t } = useLingui();
    const crpc = useCRPC();

    const isHydrated = useIsHydrated();
    const { data: activeOrganization } = useActiveOrganization(authClient);
    const { data: teams, isPending: teamsPending, refetch: refetchTeams } = useQuery(crpc.auth.team.listTeams.queryOptions({}));

    const isPending = !isHydrated || teamsPending;

    const [createDialogOpen, setCreateDialogOpen] = useState(false);

    // Only show teams for organizations
    if (!activeOrganization) {
        return (
            <SettingsCard
                className={className}
                classNames={classNames}
                description={t`Teams are only available within organizations`}
                instructions={t`Select an organization to manage teams`}
                isPending={isPending}
                title={t`Teams`}
                {...properties}
            />
        );
    }

    return (
        <>
            <SettingsCard
                action={() => {
                    setCreateDialogOpen(true);
                }}
                actionLabel={t`Create Team`}
                className={className}
                classNames={classNames}
                description={t`Manage teams within your organization`}
                instructions={t`Create teams to organize members into groups`}
                isPending={isPending}
                title={t`Teams`}
                {...properties}
            >
                {teams && teams.length > 0 && (
                    <CardContent className={cn("grid gap-4", classNames?.content)}>
                        {teams.map((team: Team) => (
                            <TeamCell classNames={classNames} key={team.id} refetchTeams={refetchTeams} team={team} />
                        ))}
                    </CardContent>
                )}
            </SettingsCard>

            <CreateTeamDialog classNames={classNames} onOpenChange={setCreateDialogOpen} open={createDialogOpen} refetchTeams={refetchTeams} />
        </>
    );
};

export default TeamsCard;
