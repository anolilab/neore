import { Trans } from "@lingui/react/macro";
import { Lock } from "lucide-react";
import type { FC } from "react";

import type { PresenceUser } from "../../hooks/use-workflow-presence";

interface NodeLockIndicatorProps {
    /** The user who is editing (locking) this node */
    lockedBy: PresenceUser;
}

/**
 * Shows a lock indicator on a node when another user is editing it.
 * Displays the user's name and a colored border to indicate the lock.
 */
const NodeLockIndicator: FC<NodeLockIndicatorProps> = ({ lockedBy }) => {
    const { userName } = lockedBy;

    return (
        <div className="pointer-events-none absolute -top-6 right-0 left-0 z-10 flex items-center justify-center">
            <div
                className="flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium text-white shadow-sm"
                style={{ backgroundColor: lockedBy.userColor }}
            >
                <Lock className="size-3" />
                <span>
                    <Trans>{userName} is editing</Trans>
                </span>
            </div>
        </div>
    );
};

interface NodeSelectionRingProps {
    /** The user who has this node selected */
    selectedBy: PresenceUser;
}

/**
 * Shows a colored ring around a node to indicate another user has it selected.
 */
const NodeSelectionRing: FC<NodeSelectionRingProps> = ({ selectedBy }) => (
    <div
        className="pointer-events-none absolute inset-[-3px] z-0 rounded-lg"
        style={{
            border: `2px solid ${selectedBy.userColor}`,
            opacity: 0.6,
        }}
    />
);

export { NodeLockIndicator, NodeSelectionRing };
