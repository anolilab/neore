"use client";

import { useLingui } from "@lingui/react/macro";
import { useControllableState } from "@radix-ui/react-use-controllable-state";
import { Badge } from "@ui/components/badge";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@ui/components/collapsible";
import cn from "@ui/utils/cn";
import type { LucideIcon } from "lucide-react";
import { BrainIcon, ChevronDownIcon, DotIcon } from "lucide-react";
import type { ComponentProps, ReactNode } from "react";
import { createContext, memo, use, useMemo } from "react";

interface ChainOfThoughtContextValue {
    isOpen: boolean;
    setIsOpen: (open: boolean) => void;
}

const ChainOfThoughtContext = createContext<ChainOfThoughtContextValue | null>(null);

const useChainOfThought = () => {
    const context = use(ChainOfThoughtContext);

    if (!context) {
        throw new Error("ChainOfThought components must be used within ChainOfThought");
    }

    return context;
};

export type ChainOfThoughtProps = ComponentProps<"div"> & {
    defaultOpen?: boolean;
    onOpenChange?: (open: boolean) => void;
    open?: boolean;
};

export const ChainOfThought = memo(({ children, className, defaultOpen = false, onOpenChange, open, ...props }: ChainOfThoughtProps) => {
    const [isOpen, setIsOpen] = useControllableState({
        defaultProp: defaultOpen,
        onChange: onOpenChange,
        prop: open,
    });

    const chainOfThoughtContext = useMemo(() => {
        return { isOpen, setIsOpen };
    }, [isOpen, setIsOpen]);

    return (
        <ChainOfThoughtContext value={chainOfThoughtContext}>
            <div className={cn("not-prose max-w-prose space-y-4", className)} {...props}>
                {children}
            </div>
        </ChainOfThoughtContext>
    );
});

export type ChainOfThoughtHeaderProps = ComponentProps<typeof CollapsibleTrigger>;

export const ChainOfThoughtHeader = memo(({ children, className, ...props }: ChainOfThoughtHeaderProps) => {
    const { t } = useLingui();
    const { isOpen, setIsOpen } = useChainOfThought();

    return (
        <Collapsible onOpenChange={setIsOpen} open={isOpen}>
            <CollapsibleTrigger
                aria-label={isOpen ? t`Collapse chain of thought` : t`Expand chain of thought`}
                className={cn("text-muted-foreground hover:text-foreground flex w-full items-center gap-2 text-sm transition-colors", className)}
                {...props}
            >
                <BrainIcon aria-hidden="true" className="size-4" />
                <span className="flex-1 text-left">{children ?? t`Chain of Thought`}</span>
                <ChevronDownIcon aria-hidden="true" className={cn("size-4 transition-transform", isOpen ? "rotate-180" : "rotate-0")} />
            </CollapsibleTrigger>
        </Collapsible>
    );
});

export type ChainOfThoughtStepProps = ComponentProps<"div"> & {
    description?: ReactNode;
    icon?: LucideIcon;
    label: ReactNode;
    status?: "complete" | "active" | "pending";
};

export const ChainOfThoughtStep = memo(
    ({ children, className, description, icon: Icon = DotIcon, label, status = "complete", ...props }: ChainOfThoughtStepProps) => {
        const statusStyles = {
            active: "text-foreground",
            complete: "text-muted-foreground",
            pending: "text-muted-foreground/50",
        };

        return (
            <div
                aria-label={typeof label === "string" ? label : undefined}
                className={cn("flex gap-2 text-sm", statusStyles[status], "fade-in-0 slide-in-from-top-2 animate-in", className)}
                role="listitem"
                {...props}
            >
                <div aria-hidden="true" className="relative mt-0.5">
                    <Icon className="size-4" />
                    <div className="bg-border absolute top-7 bottom-0 left-1/2 -mx-px w-px" />
                </div>
                <div className="flex-1 space-y-2 overflow-hidden">
                    <div>{label}</div>
                    {description && <div className="text-muted-foreground text-xs">{description}</div>}
                    {children}
                </div>
            </div>
        );
    },
);

export type ChainOfThoughtSearchResultsProps = ComponentProps<"div">;

export const ChainOfThoughtSearchResults = memo(({ className, ...props }: ChainOfThoughtSearchResultsProps) => (
    <div className={cn("flex flex-wrap items-center gap-2", className)} {...props} />
));

export type ChainOfThoughtSearchResultProps = ComponentProps<typeof Badge>;

export const ChainOfThoughtSearchResult = memo(({ children, className, ...props }: ChainOfThoughtSearchResultProps) => (
    <Badge className={cn("gap-1 px-2 py-0.5 text-xs font-normal", className)} variant="secondary" {...props}>
        {children}
    </Badge>
));

export type ChainOfThoughtContentProps = ComponentProps<typeof CollapsibleContent>;

export const ChainOfThoughtContent = memo(({ children, className, ...props }: ChainOfThoughtContentProps) => {
    const { isOpen } = useChainOfThought();

    return (
        <Collapsible open={isOpen}>
            <CollapsibleContent
                className={cn(
                    "mt-2 space-y-3",
                    "data-[state=closed]:fade-out-0 data-[state=closed]:slide-out-to-top-2 data-[state=open]:slide-in-from-top-2 text-popover-foreground data-[state=closed]:animate-out data-[state=open]:animate-in outline-none",
                    className,
                )}
                {...props}
            >
                {children}
            </CollapsibleContent>
        </Collapsible>
    );
});

export type ChainOfThoughtImageProps = ComponentProps<"div"> & {
    caption?: string;
};

export const ChainOfThoughtImage = memo(({ caption, children, className, ...props }: ChainOfThoughtImageProps) => (
    <div className={cn("mt-2 space-y-2", className)} {...props}>
        <div className="bg-muted relative flex max-h-[22rem] items-center justify-center overflow-hidden rounded-lg p-3">{children}</div>
        {caption && <p className="text-muted-foreground text-xs">{caption}</p>}
    </div>
));

ChainOfThought.displayName = "ChainOfThought";
ChainOfThoughtHeader.displayName = "ChainOfThoughtHeader";
ChainOfThoughtStep.displayName = "ChainOfThoughtStep";
ChainOfThoughtSearchResults.displayName = "ChainOfThoughtSearchResults";
ChainOfThoughtSearchResult.displayName = "ChainOfThoughtSearchResult";
ChainOfThoughtContent.displayName = "ChainOfThoughtContent";
ChainOfThoughtImage.displayName = "ChainOfThoughtImage";
