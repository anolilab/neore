import { useReactFlow, useViewport } from "@xyflow/react";
import { useEffect, useRef, useState } from "react";

import type { PresenceUser } from "../../hooks/use-workflow-presence";

interface CollaboratorCursorsProps {
    users: PresenceUser[];
}

/**
 * Single cursor component that converts flow coordinates to screen coordinates.
 */
const CursorMarker = ({ containerOffset, user }: { containerOffset: { x: number; y: number }; user: PresenceUser }) => {
    const { flowToScreenPosition } = useReactFlow();

    // Subscribe to viewport changes so cursors update when canvas pans/zooms
    useViewport();

    if (!user.cursorPosition) {
        return null;
    }

    // Convert flow coordinates to viewport screen coordinates
    const screenPos = flowToScreenPosition({
        x: user.cursorPosition.x,
        y: user.cursorPosition.y,
    });

    // Adjust for container offset (since cursors are positioned relative to container)
    const adjustedX = screenPos.x - containerOffset.x;
    const adjustedY = screenPos.y - containerOffset.y;

    return (
        <div
            className="pointer-events-none absolute top-0 left-0 z-50 transition-transform duration-75 ease-out"
            style={{
                transform: `translate(${adjustedX}px, ${adjustedY}px)`,
            }}
        >
            {/* Cursor arrow */}
            <svg className="drop-shadow-sm" fill="none" height="20" viewBox="0 0 16 20" width="16">
                <path d="M0.93 0.52L15.03 9.53L8.03 11.03L5.53 19.03L0.93 0.52Z" fill={user.userColor} stroke="white" strokeWidth="1" />
            </svg>

            {/* Name label */}
            <div
                className="absolute top-4 left-4 rounded-full px-2 py-0.5 text-xs font-medium whitespace-nowrap text-white shadow-sm"
                style={{ backgroundColor: user.userColor }}
            >
                {user.userName}
            </div>
        </div>
    );
};

/**
 * Renders remote collaborator cursors on the workflow canvas.
 * Each cursor shows the user's name and is colored with their assigned color.
 *
 * Must be rendered inside ReactFlowProvider to access viewport transforms.
 * Uses a container ref to calculate proper offset for cursor positioning.
 */
const CollaboratorCursors = ({ users }: CollaboratorCursorsProps) => {
    const containerRef = useRef<HTMLDivElement>(null);
    const [containerOffset, setContainerOffset] = useState({ x: 0, y: 0 });

    // Update container offset on mount and resize
    useEffect(() => {
        const updateOffset = () => {
            if (!containerRef.current) {
                return;
            }

            const rect = containerRef.current.getBoundingClientRect();

            setContainerOffset({ x: rect.left, y: rect.top });
        };

        updateOffset();
        window.addEventListener("resize", updateOffset);
        window.addEventListener("scroll", updateOffset);

        return () => {
            window.removeEventListener("resize", updateOffset);
            window.removeEventListener("scroll", updateOffset);
        };
    }, []);

    return (
        <div className="pointer-events-none absolute inset-0 overflow-hidden" ref={containerRef}>
            {users.map((user) => (
                <CursorMarker containerOffset={containerOffset} key={user.sessionId} user={user} />
            ))}
        </div>
    );
};

export default CollaboratorCursors;
