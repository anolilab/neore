import { Plural, Trans } from "@lingui/react/macro";
import { Tooltip, TooltipContent, TooltipTrigger } from "@ui/components/tooltip";
import { Users } from "lucide-react";
import { memo } from "react";

import type { PresenceUser } from "../../hooks/use-workflow-presence";

const WHITESPACE_RE = /\s+/;

interface CollaboratorFacepileProps {
    maxVisible?: number;
    users: PresenceUser[];
}

/**
 * Displays a horizontal stack of user avatars showing who is currently
 * editing the workflow. Each avatar shows initials and the user's assigned color.
 */
const getInitials = (name: string): string => {
    const trimmed = name.trim();

    if (!trimmed) {
        return "?";
    }

    const parts = trimmed.split(WHITESPACE_RE).filter(Boolean);

    if (parts.length >= 2 && parts[0]?.[0] && parts.at(-1)?.[0]) {
        return (parts[0][0] + parts.at(-1)![0]).toUpperCase();
    }

    return trimmed.slice(0, 2).toUpperCase() || "?";
};

const CollaboratorFacepileComponent = ({ maxVisible = 5, users }: CollaboratorFacepileProps) => {
    if (users.length === 0) {
        return null;
    }

    const visibleUsers = users.slice(0, maxVisible);
    const overflowCount = users.length - maxVisible;
    const onlineCount = users.length;

    return (
        <div className="flex items-center gap-2">
            <Users className="text-muted-foreground size-4" />
            <div className="flex items-center -space-x-2">
                {visibleUsers.map((user) => {
                    const initials = getInitials(user.userName);
                    const { editingNodeId, selectedNodeId } = user;

                    return (
                        <Tooltip key={user.sessionId}>
                            <TooltipTrigger
                                render={
                                    <div
                                        className="border-background flex size-7 cursor-default items-center justify-center rounded-full border-2 text-xs font-medium text-white"
                                        style={{ backgroundColor: user.userColor }}
                                    >
                                        {initials}
                                    </div>
                                }
                            />
                            <TooltipContent>
                                <p className="font-medium">{user.userName}</p>
                                {user.editingNodeId && (
                                    <p className="text-muted-foreground text-xs">
                                        <Trans>Editing: {editingNodeId}</Trans>
                                    </p>
                                )}
                                {user.selectedNodeId && !user.editingNodeId && (
                                    <p className="text-muted-foreground text-xs">
                                        <Trans>Viewing: {selectedNodeId}</Trans>
                                    </p>
                                )}
                            </TooltipContent>
                        </Tooltip>
                    );
                })}

                {overflowCount > 0 && (
                    <Tooltip>
                        <TooltipTrigger
                            render={
                                <div className="border-background bg-muted text-muted-foreground flex size-7 cursor-default items-center justify-center rounded-full border-2 text-xs font-medium">
                                    +{overflowCount}
                                </div>
                            }
                        />
                        <TooltipContent>
                            <p>
                                <Plural one="# more user" other="# more users" value={overflowCount} />
                            </p>
                        </TooltipContent>
                    </Tooltip>
                )}
            </div>
            <span className="text-muted-foreground text-xs">
                <Trans>{onlineCount} online</Trans>
            </span>
        </div>
    );
};

const CollaboratorFacepile = memo(CollaboratorFacepileComponent);

export default CollaboratorFacepile;
