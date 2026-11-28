"use client";

import { CardDescription, CardFooter } from "@neore/ui/components/card";
import { Skeleton } from "@neore/ui/components/skeleton";
import cn from "@neore/ui/utils/cn";
import type { ReactNode } from "react";

import SettingsActionButton from "./settings-action-button";
import type { SettingsCardClassNames } from "./settings-card";

export interface SettingsCardFooterProperties {
    action?: () => Promise<unknown> | unknown;
    actionLabel?: ReactNode;
    className?: string;
    classNames?: SettingsCardClassNames;
    disabled?: boolean;
    instructions?: ReactNode;
    isPending?: boolean;
    isSubmitting?: boolean;
    variant?: "default" | "destructive";
}

const SettingsCardFooter = ({
    action,
    actionLabel,
    className,
    classNames,
    disabled,
    instructions,
    isPending,
    isSubmitting,
    variant,
}: SettingsCardFooterProperties) => (
    <CardFooter
        className={cn(
            // The box's last row: a hairline above it when rows come first (`styles.css`), none when it is the only row.
            "flex flex-col justify-between gap-3 px-4 py-3 md:flex-row md:items-center",
            className,
            classNames?.footer,
        )}
    >
        {isPending ? (
            <>
                {instructions && <Skeleton className={cn("my-0.5 h-3 w-48 max-w-full md:h-4 md:w-56", classNames?.skeleton)} />}

                {actionLabel && <Skeleton className={cn("h-8 w-14 md:ms-auto", classNames?.skeleton)} />}
            </>
        ) : (
            <>
                {instructions && (
                    <CardDescription className={cn("text-muted-foreground text-start text-sm", classNames?.instructions)}>{instructions}</CardDescription>
                )}

                {actionLabel && (
                    <SettingsActionButton
                        actionLabel={actionLabel}
                        classNames={classNames}
                        disabled={disabled}
                        isSubmitting={isSubmitting}
                        onClick={action}
                        variant={variant}
                    />
                )}
            </>
        )}
    </CardFooter>
);

export default SettingsCardFooter;
