"use client";

import { useLingui } from "@lingui/react/macro";
import { Skeleton } from "@neore/ui/components/skeleton";
import cn from "@neore/ui/utils/cn";
import type { Organization } from "better-auth/plugins/organization";

import type { OrganizationLogoClassNames } from "./organization-logo";
import OrganizationLogo from "./organization-logo";

export interface OrganizationViewClassNames {
    avatar?: OrganizationLogoClassNames;
    base?: string;
    content?: string;
    skeleton?: string;
    subtitle?: string;
    title?: string;
}

export interface OrganizationViewProperties {
    className?: string;
    classNames?: OrganizationViewClassNames;
    isPending?: boolean;
    organization?: Organization | null;
    size?: "sm" | "default" | "lg" | null;
}

/**
 * Displays organization information with logo and details in a compact view
 *
 * Renders an organization's profile information with appropriate fallbacks:
 * - Shows logo alongside organization name and slug when available
 * - Shows loading skeletons when isPending is true
 * - Falls back to generic "Organization" text when neither name nor slug is available
 * - Supports customization through classNames prop.
 */
const OrganizationView = ({ className, classNames, isPending, organization, size }: OrganizationViewProperties) => {
    const { t } = useLingui();

    return (
        <div className={cn("flex items-center gap-2 truncate", className, classNames?.base)}>
            <OrganizationLogo
                className={cn(size !== "sm" && "my-0.5")}
                classNames={classNames?.avatar}
                isPending={isPending}
                organization={organization}
                size={size ?? undefined}
            />

            <div className={cn("flex flex-col truncate text-left leading-tight", classNames?.content)}>
                {isPending ? (
                    <>
                        <Skeleton className={cn("max-w-full", size === "lg" ? "h-4.5 w-32" : "h-3.5 w-24", classNames?.title, classNames?.skeleton)} />

                        {size !== "sm" && (
                            <Skeleton
                                className={cn("mt-1.5 max-w-full", size === "lg" ? "h-3.5 w-24" : "h-3 w-16", classNames?.subtitle, classNames?.skeleton)}
                            />
                        )}
                    </>
                ) : (
                    <>
                        <span className={cn("truncate font-semibold", size === "lg" ? "text-base" : "text-sm", classNames?.title)}>
                            {organization?.name || t`Organization`}
                        </span>

                        {size !== "sm" && organization?.slug && (
                            <span className={cn("truncate opacity-70", size === "lg" ? "text-sm" : "text-xs", classNames?.subtitle)}>{organization.slug}</span>
                        )}
                    </>
                )}
            </div>
        </div>
    );
};

export default OrganizationView;
