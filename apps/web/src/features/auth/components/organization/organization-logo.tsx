"use client";

import { useLingui } from "@lingui/react/macro";
import { Avatar, AvatarFallback, AvatarImage } from "@neore/ui/components/avatar";
import { Skeleton } from "@neore/ui/components/skeleton";
import cn from "@neore/ui/utils/cn";
import type { Organization } from "better-auth/plugins/organization";
import { BuildingIcon } from "lucide-react";
import type { ComponentProps } from "react";

export interface OrganizationLogoClassNames {
    base?: string;
    fallback?: string;
    fallbackIcon?: string;
    image?: string;
    skeleton?: string;
}

export interface OrganizationLogoProperties {
    classNames?: OrganizationLogoClassNames;
    isPending?: boolean;
    organization?: Partial<Organization> | null;
    size?: "sm" | "default" | "lg" | "xl" | null;
}

const SIZE_CLASSES = {
    default: "size-8",
    lg: "size-10",
    sm: "size-6",
    xl: "size-12",
} as const;

const sizeClass = (size: OrganizationLogoProperties["size"]): string => (size ? SIZE_CLASSES[size] : SIZE_CLASSES.default);

/**
 * Displays an organization logo with image and fallback support
 *
 * Renders an organization's logo image when available, with appropriate fallbacks:
 * - Shows a skeleton when isPending is true
 * - Falls back to a building icon when no logo is available.
 */
const OrganizationLogo = ({
    className,
    classNames,
    isPending,
    organization,
    size,
    ...properties
}: ComponentProps<typeof Avatar> & OrganizationLogoProperties) => {
    const { t } = useLingui();

    if (isPending) {
        return <Skeleton className={cn("shrink-0 rounded-full", sizeClass(size), className, classNames?.base, classNames?.skeleton)} />;
    }

    const name = organization?.name;

    const source = organization?.logo;

    return (
        <Avatar className={cn("bg-muted", sizeClass(size), className, classNames?.base)} {...properties}>
            <AvatarImage alt={name || t`Organization`} className={classNames?.image} src={source || undefined} />

            <AvatarFallback className={cn("text-foreground", classNames?.fallback)} delay={source ? 600 : undefined}>
                <BuildingIcon className={cn("size-[50%]", classNames?.fallbackIcon)} />
            </AvatarFallback>
        </Avatar>
    );
};

export default OrganizationLogo;
