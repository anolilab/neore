"use client";

import { Button } from "@neore/ui/components/button";
import cn from "@neore/ui/utils/cn";
import { Loader2 } from "lucide-react";
import type { ComponentProps, ReactNode } from "react";

import type { SettingsCardClassNames } from "./settings-card";

interface SettingsActionButtonProperties extends ComponentProps<typeof Button> {
    actionLabel: ReactNode;
    classNames?: SettingsCardClassNames;
    disabled?: boolean;
    isSubmitting?: boolean;
}

const SettingsActionButton = ({ actionLabel, classNames, disabled, isSubmitting = false, onClick, variant, ...properties }: SettingsActionButtonProperties) => (
    <Button
        className={cn(
            "md:ms-auto",
            classNames?.button,
            variant === "default" && classNames?.primaryButton,
            variant === "destructive" && classNames?.destructiveButton,
        )}
        disabled={isSubmitting || disabled}
        onClick={onClick}
        size="sm"
        type={onClick ? "button" : "submit"}
        variant={variant}
        {...properties}
    >
        {isSubmitting && <Loader2 className="animate-spin" />}
        {actionLabel}
    </Button>
);

export default SettingsActionButton;
