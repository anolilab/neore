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

import { useThreadFollow } from "../follows/use-thread-follow";
import { useOpenChatClick } from "../split/use-open-chat";

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
    /** Opens the chat as a pane of the split view. Given only while the split view preference is on; absent hides the item. */
    onOpenInSplitView?: () => void;
    onRename: () => void;
    open: boolean;
    threadId: string;
}

/** The row's options menu. Holds the thread-level actions that have no row control of their own. */
const ThreadOptionsMenu = ({ className, isHostRun, isLocked, label, onOpenChange, onOpenInSplitView, onRename, open, threadId }: ThreadOptionsMenuProps) => {
    const { t } = useLingui();
    // The action client: a regenerate must fail now when offline, not replay later from a queue, and is one request, not retried.
    const { isPending, mutate: regenerateTitle } = useMutation({
        ...useLunoraActionOptions(api.chat.functions.regenerateThreadTitle),
        networkMode: "always",
        retry: 0,
    });
    // The follow state is read only while the menu is open, so a list of rows opens no subscription per thread.
    const openChat = useOpenChatClick();
    const { isPending: isStartingSideChat, mutate: startSideChat } = useMutation({
        ...useLunoraActionOptions(api.chat.side_chat.createSideChat),
        networkMode: "always",
        retry: 0,
    });
    const follow = useThreadFollow(threadId, { enabled: open && !isLocked });

    // A locked row keeps only the split-view item: the server refuses its rename and its regenerate.
    if (isLocked && !onOpenInSplitView) {
        return null;
    }

    const sideChatRefusal = (reason: string): string => {
        switch (reason) {
            case "archived": {
                return t`An archived chat cannot start a side chat.`;
            }
            case "custom_endpoint": {
                return t`A chat on a custom endpoint cannot start a side chat.`;
            }
            case "empty": {
                return t`Send a message and wait for the reply before starting a side chat.`;
            }
            case "group_or_shared":
            case "shared":
            case "shared_or_temporary": {
                return t`A shared or temporary chat cannot start a side chat.`;
            }
            case "host_run": {
                return t`A chat that runs on your computer cannot start a side chat.`;
            }
            case "locked": {
                return t`Unlock this chat to start a side chat.`;
            }
            default: {
                return t`This chat cannot start a side chat.`;
            }
        }
    };

    const showFollowChoices = !isLocked && follow.error === null && follow.state !== undefined;

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
                    {!isLocked && <DropdownMenuItem onClick={onRename}>{t`Rename`}</DropdownMenuItem>}
                    {onOpenInSplitView && <DropdownMenuItem onClick={onOpenInSplitView}>{t`Open in split view`}</DropdownMenuItem>}
                    {!isHostRun && !isLocked && (
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
                    {!isHostRun && !isLocked && (
                        <DropdownMenuItem
                            disabled={isStartingSideChat}
                            onClick={(event) => {
                                // Copied now: the event is spent when the action answers. The click and the saved setting pick where the chat opens.
                                const click = { button: event.button, ctrlKey: event.ctrlKey, detail: event.detail, metaKey: event.metaKey };

                                startSideChat(
                                    { threadId },
                                    {
                                        onError: (error: Error) => {
                                            console.error("Failed to start a side chat:", error);
                                            showError(error);
                                        },
                                        onSuccess: (result) => {
                                            if (result.status === "ok") {
                                                openChat(result.threadId, click, threadId);
                                            } else {
                                                showError(sideChatRefusal(result.reason));
                                            }
                                        },
                                    },
                                );
                            }}
                        >
                            {t`Side chat`}
                        </DropdownMenuItem>
                    )}
                    {!isLocked && follow.error !== null && <DropdownMenuItem disabled>{t`Couldn't load follow state`}</DropdownMenuItem>}
                    {/* Disabled while a change is in flight: a second choice made then could reach the server first. None while the
                        lookup fails: a cached state may predate the last change. */}
                    {showFollowChoices && follow.state !== "on" && (
                        <DropdownMenuItem disabled={follow.isPending} onClick={() => follow.setState("on")}>
                            {t`Follow thread`}
                        </DropdownMenuItem>
                    )}
                    {showFollowChoices && follow.state !== "off" && (
                        <DropdownMenuItem disabled={follow.isPending} onClick={() => follow.setState("off")}>
                            {t`Unfollow thread`}
                        </DropdownMenuItem>
                    )}
                    {showFollowChoices && follow.state !== "muted" && (
                        <DropdownMenuItem disabled={follow.isPending} onClick={() => follow.setState("muted")}>
                            {t`Mute thread`}
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
