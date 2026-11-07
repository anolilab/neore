import { useLingui } from "@lingui/react/macro";
import { api } from "@neore/backend/api";
import type { Id } from "@neore/backend/dataModel";
import { Button } from "@neore/ui/components/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@neore/ui/components/responsive-dropdown-menu";
import { Tooltip, TooltipContent, TooltipTrigger } from "@neore/ui/components/tooltip";
import cn from "@neore/ui/utils/cn";
import { useMutation } from "@tanstack/react-query";
import { MoreHorizontal } from "lucide-react";

import { useLunoraActionOptions } from "@/lib/lunora/crpc";
import { showError, showSuccess } from "@/lib/toast";

interface ThreadOptionsMenuProps {
    /** Where this copy of the menu shows: `className` for the wrapper, which is `display: contents` while it shows. */
    className?: string;
    /** A host-run chat's title is not generated in the cloud, so it gets no Regenerate; Rename still works. */
    isHostRun: boolean;
    /** A locked chat keeps its title (the server refuses a rename or regenerate), so it gets no menu. */
    isLocked: boolean;
    /** The row's accessible name, from the thread title. */
    label: string;
    onOpenChange: (open: boolean) => void;
    onRename: () => void;
    open: boolean;
    threadId: string;
}

/** The row's options menu. Holds the thread-level actions that have no row control of their own. */
const ThreadOptionsMenu = ({ className, isHostRun, isLocked, label, onOpenChange, onRename, open, threadId }: ThreadOptionsMenuProps) => {
    const { t } = useLingui();
    // The action client: a regenerate must fail now when offline, not replay later from a queue, and is one request, not retried.
    const { isPending, mutate: regenerateTitle } = useMutation({
        ...useLunoraActionOptions(api.chat.functions.regenerateThreadTitle),
        networkMode: "always",
        retry: 0,
    });

    // A locked row gets no menu: the server refuses both its rename and its regenerate.
    if (isLocked) {
        return null;
    }

    // The menu's items are portaled; a click in them bubbles through React to the row, which must not open.
    return (
        <span className={cn("contents", className)} onClick={(event) => event.stopPropagation()} role="presentation">
            <DropdownMenu onOpenChange={onOpenChange} open={open}>
                <Tooltip>
                    <TooltipTrigger
                        render={
                            <DropdownMenuTrigger
                                render={
                                    <Button
                                        aria-busy={isPending}
                                        aria-label={t`Thread options: ${label}`}
                                        className="hover:text-primary h-6 w-6 shrink-0 p-0"
                                        disabled={isPending}
                                        size="icon-sm"
                                        variant="ghost"
                                    >
                                        <MoreHorizontal aria-hidden="true" className="h-3 w-3" />
                                    </Button>
                                }
                            />
                        }
                    />
                    <TooltipContent>{t`Thread options`}</TooltipContent>
                </Tooltip>
                <DropdownMenuContent>
                    <DropdownMenuItem onClick={onRename}>{t`Rename`}</DropdownMenuItem>
                    {!isHostRun && (
                        <DropdownMenuItem
                            onClick={() =>
                                regenerateTitle(
                                    { threadId: threadId as Id<"threads"> },
                                    {
                                        onError: (error: Error) => {
                                            console.error("Failed to regenerate the thread title:", error);
                                            showError(error);
                                        },
                                        onSuccess: () => {
                                            showSuccess(t`Regenerating the title`);
                                        },
                                    },
                                )
                            }
                        >
                            {t`Regenerate title`}
                        </DropdownMenuItem>
                    )}
                </DropdownMenuContent>
            </DropdownMenu>
            {isPending && (
                <span className="sr-only" role="status">
                    {t`Regenerating the title`}
                </span>
            )}
        </span>
    );
};

export default ThreadOptionsMenu;
