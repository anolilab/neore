import { useLingui } from "@lingui/react/macro";
import { api } from "@neore/backend/api";
import type { Id } from "@neore/backend/dataModel";
import { Button } from "@neore/ui/components/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@neore/ui/components/responsive-dropdown-menu";
import { Tooltip, TooltipContent, TooltipTrigger } from "@neore/ui/components/tooltip";
import { useMutation } from "@tanstack/react-query";
import { MoreHorizontal } from "lucide-react";

import { useLunoraActionOptions } from "@/lib/lunora/crpc";
import { showError, showSuccess } from "@/lib/toast";

interface ThreadOptionsMenuProps {
    /** A host-run chat's title is not generated in the cloud, so the server refuses a regenerate; the item is not offered. */
    isHostRun: boolean;
    /** A locked chat keeps its title, so the server refuses a regenerate; the item is not offered. */
    isLocked: boolean;
    /** The row's accessible name, from the thread title. */
    label: string;
    threadId: string;
}

/** The row's options menu. Holds the thread-level actions that have no row control of their own. */
const ThreadOptionsMenu = ({ isHostRun, isLocked, label, threadId }: ThreadOptionsMenuProps) => {
    const { t } = useLingui();
    // The action client: a regenerate must fail now when offline, not replay later from a queue, and is one request, not retried.
    const { isPending, mutate: regenerateTitle } = useMutation({
        ...useLunoraActionOptions(api.chat.functions.regenerateThreadTitle),
        networkMode: "always",
        retry: 0,
    });

    // A host-run chat has no regenerate here and a locked one has none: with neither, the row has no menu to offer.
    if (isLocked || isHostRun) {
        return null;
    }

    // The menu's items are portaled; a click in them bubbles through React to the row, which must not open.
    return (
        <span className="contents" onClick={(event) => event.stopPropagation()} role="presentation">
            <DropdownMenu>
                <Tooltip>
                    <TooltipTrigger
                        render={
                            <DropdownMenuTrigger
                                render={
                                    <Button
                                        aria-busy={isPending}
                                        aria-label={t`Thread options: ${label}`}
                                        className="hover:text-primary h-6 w-6 p-0"
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
