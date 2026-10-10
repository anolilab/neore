"use client";

import { useLingui } from "@lingui/react/macro";
import { Avatar, AvatarFallback, AvatarImage } from "@neore/ui/components/avatar";
import { Skeleton } from "@neore/ui/components/skeleton";
import cn from "@neore/ui/utils/cn";

import type { UserViewProperties } from "../user-view";
import type { OrganizationViewClassNames } from "./organization-view";

interface PersonalAccountViewProperties extends UserViewProperties {
    classNames?: OrganizationViewClassNames;
}

/**
 * Displays user information with avatar and details in a compact view for personal accounts
 *
 * Renders a user's profile information with appropriate fallbacks:
 * - Shows avatar alongside user name and "Personal Account" subtitle when available
 * - Shows loading skeletons when isPending is true
 * - Falls back to generic "User" text when neither name nor email is available
 * - Always shows "Personal Account" as subtitle for default and lg sizes
 * - Supports customization through classNames prop.
 */
const PersonalAccountView = ({ className, classNames, isPending, size, user }: PersonalAccountViewProperties) => {
    const { t } = useLingui();

    return (
        <div className={cn("flex items-center gap-2", className, classNames?.base)}>
            <Avatar className="h-8 w-8 rounded-lg">
                {user?.image && <AvatarImage alt={user?.name || t`User`} src={user.image} />}
                <AvatarFallback className="rounded-lg" name={user?.name || user?.email || undefined}>
                    {user?.name?.charAt(0)?.toUpperCase() || "U"}
                </AvatarFallback>
            </Avatar>

            <div className={cn("grid flex-1 text-left leading-tight", classNames?.content)}>
                {isPending ? (
                    <>
                        <Skeleton className={cn("max-w-full", size === "lg" ? "h-4.5 w-32" : "h-3.5 w-24", classNames?.title, classNames?.skeleton)} />

                        {size !== "sm" && (
                            <Skeleton
                                className={cn("mt-1.5 max-w-full", size === "lg" ? "h-3.5 w-40" : "h-3 w-32", classNames?.subtitle, classNames?.skeleton)}
                            />
                        )}
                    </>
                ) : (
                    <>
                        <span className={cn("truncate font-semibold", size === "lg" ? "text-base" : "text-sm", classNames?.title)}>
                            {user?.displayUsername ||
                                user?.username ||
                                user?.displayName ||
                                user?.firstName ||
                                user?.name ||
                                user?.fullName ||
                                user?.email ||
                                t`User`}
                        </span>

                        {size !== "sm" && (
                            <span className={cn("truncate opacity-70", size === "lg" ? "text-sm" : "text-xs", classNames?.subtitle)}>
                                {t`Personal Account`}
                            </span>
                        )}
                    </>
                )}
            </div>
        </div>
    );
};

export default PersonalAccountView;
