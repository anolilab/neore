"use client";

import type { FC } from "react";
import { memo } from "react";

import OrganizationSwitcher from "@/features/auth/components/organization/organization-switcher";
import TeamSwitcher from "@/features/auth/components/team/team-switcher";
import { useAuthActiveOrganization, useAuthOrganizationList } from "@/features/auth/hooks/use-auth-session";

const SWITCHER_CLASS =
    "text-foreground hover:bg-surface-row-hover data-[active]:bg-surface-row-hover h-8 w-full justify-start gap-2 rounded-lg px-2 text-[13px] font-medium";

/** The top of the thread sidebar: the organization and team switchers, for those who have more than one. The rest lives in the dock. */
const ThreadListHeader: FC = memo(() => {
    const { data: organizations } = useAuthOrganizationList();
    const { data: activeOrganization } = useAuthActiveOrganization();
    const hasMultipleOrganizations = organizations && organizations.length > 1;
    const hasActiveOrganization = !!activeOrganization;

    if (!hasMultipleOrganizations && !hasActiveOrganization) {
        return null;
    }

    return (
        <div className="flex flex-col gap-0.5">
            {hasMultipleOrganizations && <OrganizationSwitcher className={SWITCHER_CLASS} />}
            {hasActiveOrganization && <TeamSwitcher className={SWITCHER_CLASS} variant="ghost" />}
        </div>
    );
});

export default ThreadListHeader;
