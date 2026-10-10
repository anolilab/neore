"use client";

import { Card } from "@neore/ui/components/card";
import cn from "@neore/ui/utils/cn";
import type { ComponentProps, ReactNode } from "react";

import SettingsCardFooter from "./settings-card-footer";
import SettingsCardHeader from "./settings-card-header";

export type SettingsCardClassNames = {
    base?: string;
    button?: string;
    cell?: string;
    checkbox?: string;
    content?: string;
    description?: string;
    destructiveButton?: string;
    dialog?: {
        content?: string;
        footer?: string;
        header?: string;
    };
    error?: string;
    footer?: string;
    header?: string;
    icon?: string;
    input?: string;
    instructions?: string;
    label?: string;
    outlineButton?: string;
    primaryButton?: string;
    secondaryButton?: string;
    skeleton?: string;
    title?: string;
};

export interface SettingsCardProperties extends Omit<ComponentProps<typeof Card>, "title"> {
    action?: () => Promise<unknown> | unknown;
    actionLabel?: ReactNode;
    children?: ReactNode;
    className?: string;
    classNames?: SettingsCardClassNames;
    description?: ReactNode;
    disabled?: boolean;
    header?: ReactNode;
    instructions?: ReactNode;
    isPending?: boolean;
    isSubmitting?: boolean;
    title?: ReactNode;
    variant?: "default" | "destructive";
}

const SettingsCard = ({
    action,
    actionLabel,
    children,
    className,
    classNames,
    description,
    disabled,
    header,
    instructions,
    isPending,
    isSubmitting,
    title,
    variant,
    ...properties
}: SettingsCardProperties) => {
    const displayTitle = header || title;

    return (
        <Card className={cn("w-full pb-0 text-start", variant === "destructive" && "border-destructive/40", className, classNames?.base)} {...properties}>
            <SettingsCardHeader classNames={classNames} description={description} isPending={isPending} title={displayTitle} />

            {children && <div className="dark:bg-sidebar-foreground m-1 rounded-lg bg-white py-4 shadow-md">{children}</div>}

            {(actionLabel || action) && (
                <SettingsCardFooter
                    action={action}
                    actionLabel={actionLabel}
                    classNames={classNames}
                    disabled={disabled}
                    instructions={instructions}
                    isPending={isPending}
                    isSubmitting={isSubmitting}
                    variant={variant}
                />
            )}
        </Card>
    );
};

export default SettingsCard;
