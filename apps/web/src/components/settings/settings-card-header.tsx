"use client";

import { CardDescription, CardHeader, CardTitle } from "@neore/ui/components/card";
import { Skeleton } from "@neore/ui/components/skeleton";
import cn from "@neore/ui/utils/cn";
import type { ReactNode } from "react";

import type { SettingsCardClassNames } from "./settings-card";

export interface SettingsCardHeaderProperties {
    className?: string;
    classNames?: SettingsCardClassNames;
    description?: ReactNode;
    isPending?: boolean;
    title: ReactNode;
}

const SettingsCardHeader = ({ className, classNames, description, isPending, title }: SettingsCardHeaderProperties) => {
    // A section with neither (a single-field card whose row carries the title) draws no header, not an empty heading.
    if (!isPending && !title && !description) {
        return null;
    }

    return (
        <CardHeader className={cn(classNames?.header, className)}>
            {isPending ? (
                <>
                    {/* The heading stays for the outline while it loads: a row's heading under it would otherwise skip a level. */}
                    {title && <CardTitle className="sr-only">{title}</CardTitle>}
                    <Skeleton className={cn("my-0.5 h-5 w-1/3 md:h-5.5", classNames?.skeleton)} />

                    {description && <Skeleton className={cn("mt-1.5 mb-0.5 h-3 w-2/3 md:h-3.5", classNames?.skeleton)} />}
                </>
            ) : (
                <>
                    <CardTitle className={cn("text-[15px] font-semibold", classNames?.title)}>{title}</CardTitle>

                    {description && <CardDescription className={cn("text-sm", classNames?.description)}>{description}</CardDescription>}
                </>
            )}
        </CardHeader>
    );
};

export default SettingsCardHeader;
