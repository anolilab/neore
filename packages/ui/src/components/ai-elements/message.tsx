"use client";

import { useLingui } from "@lingui/react/macro";
import { Button } from "@ui/components/button";
import { ButtonGroup, ButtonGroupText } from "@ui/components/button-group";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@ui/components/tooltip";
import useStreamdownPlugins from "@ui/hooks/use-streamdown-plugins";
import cn from "@ui/utils/cn";
import type { UIMessage } from "ai";
import { ChevronLeftIcon, ChevronRightIcon } from "lucide-react";
import type { ComponentProps, HTMLAttributes, ReactElement } from "react";
import { createContext, memo, use, useCallback, useEffect, useMemo, useState } from "react";
import { Streamdown } from "streamdown";

export type MessageProps = HTMLAttributes<HTMLDivElement> & {
    from: UIMessage["role"];
};

export const Message = ({ className, from, ...props }: MessageProps) => (
    <div className={cn("group flex w-full flex-col", from === "user" ? "is-user ml-auto justify-end" : "is-assistant", className)} {...props} />
);

export type MessageContentProps = HTMLAttributes<HTMLDivElement>;

export const MessageContent = ({ children, className, ...props }: MessageContentProps) => (
    <div
        className={cn(
            "is-user:dark flex w-fit max-w-full min-w-0 flex-col gap-2 text-sm",
            "group-[.is-user]:bg-secondary group-[.is-user]:text-foreground group-[.is-user]:ml-auto group-[.is-user]:rounded-lg group-[.is-user]:px-4 group-[.is-user]:py-3",
            "group-[.is-assistant]:text-foreground",
            className,
        )}
        {...props}
    >
        {children}
    </div>
);

export type MessageActionsProps = ComponentProps<"div">;

export const MessageActions = ({ children, className, ...props }: MessageActionsProps) => (
    <div className={cn("flex items-center gap-1", className)} {...props}>
        {children}
    </div>
);

export type MessageActionProps = ComponentProps<typeof Button> & {
    label?: string;
    tooltip?: string;
};

export const MessageAction = ({ children, label, size = "icon-sm", tooltip, variant = "ghost", ...props }: MessageActionProps) => {
    if (tooltip) {
        return (
            <TooltipProvider>
                <Tooltip>
                    <TooltipTrigger
                        render={
                            <Button size={size} type="button" variant={variant} {...props}>
                                {children}
                                <span className="sr-only">{label || tooltip}</span>
                            </Button>
                        }
                    />
                    <TooltipContent>
                        <p>{tooltip}</p>
                    </TooltipContent>
                </Tooltip>
            </TooltipProvider>
        );
    }

    return (
        <Button size={size} type="button" variant={variant} {...props}>
            {children}
            <span className="sr-only">{label || tooltip}</span>
        </Button>
    );
};

interface MessageBranchContextType {
    branches: ReactElement[];
    currentBranch: number;
    goToNext: () => void;
    goToPrevious: () => void;
    setBranches: (branches: ReactElement[]) => void;
    totalBranches: number;
}

const MessageBranchContext = createContext<MessageBranchContextType | null>(null);

const useMessageBranch = () => {
    const context = use(MessageBranchContext);

    if (!context) {
        throw new Error("MessageBranch components must be used within MessageBranch");
    }

    return context;
};

export type MessageBranchProps = HTMLAttributes<HTMLDivElement> & {
    defaultBranch?: number;
    onBranchChange?: (branchIndex: number) => void;
};

export const MessageBranch = ({ className, defaultBranch = 0, onBranchChange, ...props }: MessageBranchProps) => {
    const [currentBranch, setCurrentBranch] = useState(defaultBranch);
    const [branches, setBranches] = useState<ReactElement[]>([]);

    const handleBranchChange = useCallback(
        (newBranch: number) => {
            setCurrentBranch(newBranch);
            onBranchChange?.(newBranch);
        },
        [onBranchChange],
    );

    const goToPrevious = useCallback(() => {
        const newBranch = (currentBranch > 0 ? currentBranch : branches.length) - 1;

        handleBranchChange(newBranch);
    }, [currentBranch, branches.length, handleBranchChange]);

    const goToNext = useCallback(() => {
        const newBranch = currentBranch < branches.length - 1 ? currentBranch + 1 : 0;

        handleBranchChange(newBranch);
    }, [currentBranch, branches.length, handleBranchChange]);

    const contextValue = useMemo<MessageBranchContextType>(() => {
        return {
            branches,
            currentBranch,
            goToNext,
            goToPrevious,
            setBranches,
            totalBranches: branches.length,
        };
    }, [branches, currentBranch, goToNext, goToPrevious]);

    return (
        <MessageBranchContext value={contextValue}>
            <div className={cn("grid w-full gap-2 [&>div]:pb-0", className)} {...props} />
        </MessageBranchContext>
    );
};

export type MessageBranchContentProps = HTMLAttributes<HTMLDivElement>;

export const MessageBranchContent = ({ children, ...props }: MessageBranchContentProps) => {
    const { branches, currentBranch, setBranches } = useMessageBranch();
    const childrenArray = useMemo(() => (Array.isArray(children) ? children : [children]), [children]);

    // Use useEffect to update branches when they change
    useEffect(() => {
        if (branches.length !== childrenArray.length) {
            setBranches(childrenArray);
        }
    }, [childrenArray, branches, setBranches]);

    return childrenArray.map((branch, index) => (
        <div
            aria-hidden={index !== currentBranch}
            className={cn("grid gap-2 overflow-hidden [&>div]:pb-0", index === currentBranch ? "block" : "hidden")}
            key={branch.key}
            {...props}
        >
            {branch}
        </div>
    ));
};

/**
 * `from` used to be a required member here and was read by nothing — every
 * consumer had to supply the message role and it changed no output. Removed
 * rather than left as a prop that lies about mattering; nothing in the repo
 * rendered this component.
 */
export type MessageBranchSelectorProps = HTMLAttributes<HTMLDivElement>;

export const MessageBranchSelector = ({ className, ...props }: MessageBranchSelectorProps) => {
    const { totalBranches } = useMessageBranch();

    // Don't render if there's only one branch
    if (totalBranches <= 1) {
        return null;
    }

    // Merged, not replaced: this component sets its own corner rounding and a
    // consumer's className has to compose with it rather than clobber it.
    return (
        <ButtonGroup
            className={cn("[&>*:not(:first-child)]:rounded-l-md [&>*:not(:last-child)]:rounded-r-md", className)}
            orientation="horizontal"
            {...props}
        />
    );
};

export type MessageBranchPreviousProps = ComponentProps<typeof Button>;

export const MessageBranchPrevious = ({ children, ...props }: MessageBranchPreviousProps) => {
    const { t } = useLingui();
    const { goToPrevious, totalBranches } = useMessageBranch();

    return (
        <Button aria-label={t`Previous branch`} disabled={totalBranches <= 1} onClick={goToPrevious} size="icon-sm" type="button" variant="ghost" {...props}>
            {children ?? <ChevronLeftIcon size={14} />}
        </Button>
    );
};

export type MessageBranchNextProps = ComponentProps<typeof Button>;

export const MessageBranchNext = ({ children, ...props }: MessageBranchNextProps) => {
    const { t } = useLingui();
    const { goToNext, totalBranches } = useMessageBranch();

    return (
        <Button aria-label={t`Next branch`} disabled={totalBranches <= 1} onClick={goToNext} size="icon-sm" type="button" variant="ghost" {...props}>
            {children ?? <ChevronRightIcon size={14} />}
        </Button>
    );
};

export type MessageBranchPageProps = HTMLAttributes<HTMLSpanElement>;

export const MessageBranchPage = ({ className, ...props }: MessageBranchPageProps) => {
    const { currentBranch, totalBranches } = useMessageBranch();

    return (
        <ButtonGroupText className={cn("text-muted-foreground border-none bg-transparent shadow-none", className)} {...props}>
            {currentBranch + 1} of {totalBranches}
        </ButtonGroupText>
    );
};

export type MessageResponseProps = ComponentProps<typeof Streamdown>;

export const MessageResponse = memo(
    ({ className, ...props }: MessageResponseProps) => {
        const plugins = useStreamdownPlugins(props.children);

        return <Streamdown className={cn("size-full [&>*:first-child]:mt-0 [&>*:last-child]:mb-0", className)} plugins={plugins} {...props} />;
    },
    (prevProps, nextProps) => prevProps.children === nextProps.children,
);

MessageResponse.displayName = "MessageResponse";

export type MessageToolbarProps = ComponentProps<"div">;

export const MessageToolbar = ({ children, className, ...props }: MessageToolbarProps) => (
    <div className={cn("mt-4 flex w-full items-center justify-between gap-4", className)} {...props}>
        {children}
    </div>
);
