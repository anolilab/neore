"use client";

import cn from "@neore/ui/utils/cn";
import { useEffect } from "react";

import { useActiveOrganization } from "@/features/auth/hooks/organization-management";
import { useAuth } from "@/features/auth/lib/auth-ui-provider";
import { ORGANIZATIONS_SETTINGS_PATH } from "@/features/auth/lib/auth-view-paths";

import type { AuthCardProps } from "../../types/ui-config-types";
import DeleteOrganizationCard from "../organization/delete-organization-card";
import OrganizationLogoCard from "../organization/organization-logo-card";
import OrganizationNameCard from "../organization/organization-name-card";
import OrganizationSlugCard from "../organization/organization-slug-card";

const OrganizationSettingsCards = ({ className, classNames }: AuthCardProps) => {
    const { authClient, organization, replace } = useAuth();

    const { data: activeOrganization, isFetching: organizationFetching, isSuccess: organizationLoaded } = useActiveOrganization(authClient);

    useEffect(() => {
        // Only a lookup that SUCCEEDED and found nothing means "no organization". A
        // failed one (a 429 from the auth rate limit, a network blip) is not an
        // answer, and redirecting on it bounced users who have one.
        if (!organizationLoaded || organizationFetching) {
            return;
        }

        // No organization to show: send the user to the list, where one is created or chosen.
        if (!activeOrganization) replace(ORGANIZATIONS_SETTINGS_PATH);
    }, [activeOrganization, organizationLoaded, organizationFetching, replace]);

    return (
        <div className={cn("flex w-full flex-col gap-4 md:gap-6", className, classNames?.card)}>
            {organization?.logo && <OrganizationLogoCard classNames={classNames} />}

            <OrganizationNameCard classNames={classNames} />

            <OrganizationSlugCard classNames={classNames} />

            <DeleteOrganizationCard classNames={classNames} />
        </div>
    );
};

export default OrganizationSettingsCards;
