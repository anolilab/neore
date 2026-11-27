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

export interface SettingsCardProperties extends Omit<ComponentProps<typeof Card>, "title" | "variant"> {
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
    const hasFooter = Boolean(actionLabel || action);

    return (
        // A section: its heading above one box of rows, split by hairlines (`styles.css`), the action last.
        <Card className={cn("w-full text-start", className, classNames?.base)} variant="plain" {...properties}>
            <SettingsCardHeader className="px-1" classNames={classNames} description={description} isPending={isPending} title={displayTitle} />

            {(children || hasFooter) && (
                <div
                    className={cn("surface-raised overflow-hidden rounded-xl", variant === "destructive" && "ring-destructive/40 ring-1")}
                    data-slot="settings-card-body"
                >
                    {children && <div className="px-4 py-1 [&>[data-slot=card-content]]:px-0">{children}</div>}

                    {hasFooter && (
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
                </div>
            )}
        </Card>
    );
};

export default SettingsCard;
