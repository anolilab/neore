"use client";

import { useLingui } from "@lingui/react/macro";
import { Badge } from "@neore/ui/components/badge";
import cn from "@neore/ui/utils/cn";
import { UserX } from "lucide-react";

import useIsAnonymous from "../../hooks/use-is-anonymous";

export interface AnonymousUserIndicatorProperties {
    className?: string;
    classNames?: {
        badge?: string;
        base?: string;
        icon?: string;
        text?: string;
    };
    showIcon?: boolean;
    size?: "sm" | "default";
    variant?: "default" | "secondary" | "destructive" | "outline";
}

const AnonymousUserIndicator = ({ className, classNames, showIcon = true, size = "default", variant = "secondary" }: AnonymousUserIndicatorProperties) => {
    const { isAnonymous } = useIsAnonymous();
    const { t } = useLingui();

    if (!isAnonymous) {
        return null;
    }

    return (
        <Badge className={cn(size === "sm" ? "px-1 py-0.5 text-xs" : "text-xs", className, classNames?.base)} variant={variant}>
            {showIcon && <UserX className={cn(size === "sm" ? "mr-0.5 h-2.5 w-2.5" : "mr-1 h-3 w-3", classNames?.icon)} />}
            <span className={classNames?.text}>{t`Guest`}</span>
        </Badge>
    );
};

export default AnonymousUserIndicator;
