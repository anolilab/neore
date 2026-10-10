"use client";

import { Button } from "@ui/components/button";
import { Separator } from "@ui/components/separator";
import { Tooltip, TooltipContent, TooltipTrigger } from "@ui/components/tooltip";
import cn from "@ui/utils/cn";
import type { LucideProps } from "lucide-react";
import { BookmarkIcon } from "lucide-react";
import type { ComponentProps, HTMLAttributes } from "react";

export type CheckpointProps = HTMLAttributes<HTMLDivElement>;

export const Checkpoint = ({ children, className, ...props }: CheckpointProps) => (
    <div className={cn("text-muted-foreground flex items-center gap-0.5 overflow-hidden", className)} {...props}>
        {children}
        <Separator />
    </div>
);

export type CheckpointIconProps = LucideProps;

export const CheckpointIcon = ({ children, className, ...props }: CheckpointIconProps) =>
    children ?? <BookmarkIcon className={cn("size-4 shrink-0", className)} {...props} />;

export type CheckpointTriggerProps = ComponentProps<typeof Button> & {
    tooltip?: string;
};

export const CheckpointTrigger = ({ children, size = "sm", tooltip, variant = "ghost", ...props }: CheckpointTriggerProps) =>
    tooltip ? (
        <Tooltip>
            <TooltipTrigger render={<Button size={size} type="button" variant={variant} {...props} />}>{children}</TooltipTrigger>
            <TooltipContent align="start" side="bottom">
                {tooltip}
            </TooltipContent>
        </Tooltip>
    ) : (
        <Button size={size} type="button" variant={variant} {...props}>
            {children}
        </Button>
    );
