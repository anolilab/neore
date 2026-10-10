"use client";

import { Dialog as CommandDialogPrimitive } from "@base-ui/react/dialog";
import {
    Autocomplete,
    AutocompleteCollection,
    AutocompleteEmpty,
    AutocompleteGroup,
    AutocompleteGroupLabel,
    AutocompleteInput,
    AutocompleteItem,
    AutocompleteList,
    AutocompleteSeparator,
} from "@ui/components/autocomplete";
import cn from "@ui/utils/cn";
import { SearchIcon } from "lucide-react";
import * as React from "react";

const CommandInputContext = React.createContext<{
    inputRef: React.RefObject<HTMLInputElement | null> | null;
}>({
    inputRef: null,
});

const CommandDialog = CommandDialogPrimitive.Root;

const CommandDialogPortal = CommandDialogPrimitive.Portal;

const CommandDialogTrigger = (props: CommandDialogPrimitive.Trigger.Props) => <CommandDialogPrimitive.Trigger data-slot="command-dialog-trigger" {...props} />;

const CommandDialogBackdrop = ({ className, ...props }: CommandDialogPrimitive.Backdrop.Props) => (
    <CommandDialogPrimitive.Backdrop
        className={cn(
            "fixed inset-0 z-50 bg-black/32 backdrop-blur-sm transition-all duration-200 data-ending-style:opacity-0 data-starting-style:opacity-0",
            className,
        )}
        data-slot="command-dialog-backdrop"
        {...props}
    />
);

const CommandDialogViewport = ({ className, ...props }: CommandDialogPrimitive.Viewport.Props) => (
    <CommandDialogPrimitive.Viewport
        className={cn("fixed inset-0 z-50 flex flex-col items-center px-4 py-[max(--spacing(4),4vh)] sm:py-[10vh]", className)}
        data-slot="command-dialog-viewport"
        {...props}
    />
);

const CommandDialogPopup = ({ children, className, ...props }: CommandDialogPrimitive.Popup.Props) => {
    const inputRef = React.useRef<HTMLInputElement>(null);
    const contextValue = React.useMemo(() => {
        return { inputRef };
    }, [inputRef]);

    return (
        <CommandDialogPortal>
            <CommandDialogBackdrop />
            <CommandDialogViewport>
                <CommandDialogPrimitive.Popup
                    className={cn(
                        "bg-popover text-popover-foreground before:bg-muted/50 relative row-start-2 flex max-h-100 min-h-0 w-full max-w-xl min-w-0 -translate-y-[calc(1.25rem*var(--nested-dialogs))] scale-[calc(1-0.1*var(--nested-dialogs))] flex-col rounded-2xl border bg-clip-padding opacity-[calc(1-0.1*var(--nested-dialogs))] shadow-lg transition-[scale,opacity,translate,max-width] duration-300 ease-in-out will-change-transform before:pointer-events-none before:absolute before:inset-0 before:rounded-[calc(var(--radius-2xl)-1px)] before:shadow-[0_1px_--theme(--color-black/4%)] data-ending-style:scale-98 data-ending-style:opacity-0 data-nested:data-ending-style:translate-y-8 data-nested-dialog-open:origin-top data-starting-style:scale-98 data-starting-style:opacity-0 data-nested:data-starting-style:translate-y-8 **:data-[slot=scroll-area-viewport]:data-has-overflow-y:pe-1 dark:bg-clip-border dark:before:shadow-[0_-1px_--theme(--color-white/8%)]",
                        className,
                    )}
                    data-slot="command-dialog-popup"
                    initialFocus={inputRef}
                    {...props}
                >
                    <CommandInputContext value={contextValue}>{children}</CommandInputContext>
                </CommandDialogPrimitive.Popup>
            </CommandDialogViewport>
        </CommandDialogPortal>
    );
};

const Command = ({ autoHighlight = "always", keepHighlight = true, open = true, ...props }: React.ComponentProps<typeof Autocomplete>) => (
    <Autocomplete autoHighlight={autoHighlight} keepHighlight={keepHighlight} open={open} {...props} />
);

const CommandInput = ({ className, placeholder = undefined, ...props }: React.ComponentProps<typeof AutocompleteInput>) => {
    const { inputRef } = React.use(CommandInputContext);

    return (
        <div className="px-2.5 py-1.5">
            <AutocompleteInput
                className={cn("border-transparent! bg-transparent! shadow-none before:hidden has-focus-visible:ring-0", className)}
                placeholder={placeholder}
                ref={inputRef}
                size="lg"
                startAddon={<SearchIcon />}
                {...props}
            />
        </div>
    );
};

const CommandList = ({ className, ...props }: React.ComponentProps<typeof AutocompleteList>) => (
    <AutocompleteList className={cn("not-empty:scroll-py-2 not-empty:p-2", className)} data-slot="command-list" {...props} />
);

const CommandEmpty = ({ className, ...props }: React.ComponentProps<typeof AutocompleteEmpty>) => (
    <AutocompleteEmpty className={cn("not-empty:py-6", className)} data-slot="command-empty" {...props} />
);

const CommandPanel = ({ className, ...props }: React.ComponentProps<"div">) => (
    <div
        className={cn(
            "bg-popover relative -mx-px min-h-0 rounded-t-xl border bg-clip-padding shadow-xs [clip-path:inset(0_1px)] before:pointer-events-none before:absolute before:inset-0 before:rounded-t-[calc(var(--radius-xl)-1px)] **:data-[slot=scroll-area-scrollbar]:mt-2 dark:bg-clip-border dark:before:shadow-[0_-1px_--theme(--color-white/8%)]",
            className,
        )}
        {...props}
    />
);

const CommandGroup = ({ className, ...props }: React.ComponentProps<typeof AutocompleteGroup>) => (
    <AutocompleteGroup className={className} data-slot="command-group" {...props} />
);

const CommandGroupLabel = ({ className, ...props }: React.ComponentProps<typeof AutocompleteGroupLabel>) => (
    <AutocompleteGroupLabel className={className} data-slot="command-group-label" {...props} />
);

const CommandCollection = ({ ...props }: React.ComponentProps<typeof AutocompleteCollection>) => (
    <AutocompleteCollection data-slot="command-collection" {...props} />
);

const CommandItem = ({ className, ...props }: React.ComponentProps<typeof AutocompleteItem>) => (
    <AutocompleteItem className={cn("py-1.5", className)} data-slot="command-item" {...props} />
);

const CommandSeparator = ({ className, ...props }: React.ComponentProps<typeof AutocompleteSeparator>) => (
    <AutocompleteSeparator className={cn("my-2", className)} data-slot="command-separator" {...props} />
);

const CommandShortcut = ({ className, ...props }: React.ComponentProps<"kbd">) => (
    <span className={cn("text-muted-foreground/72 ms-auto text-xs font-medium tracking-widest", className)} data-slot="command-shortcut" {...props} />
);

const CommandFooter = ({ className, ...props }: React.ComponentProps<"div">) => (
    <div
        className={cn("text-muted-foreground flex items-center justify-between gap-2 rounded-b-[calc(var(--radius-2xl)-1px)] px-5 py-3 text-xs", className)}
        data-slot="command-footer"
        {...props}
    />
);

export {
    Command,
    CommandCollection,
    CommandDialog,
    CommandDialogPopup,
    CommandDialogTrigger,
    CommandEmpty,
    CommandFooter,
    CommandGroup,
    CommandGroupLabel,
    CommandInput,
    CommandItem,
    CommandList,
    CommandPanel,
    CommandSeparator,
    CommandShortcut,
};
