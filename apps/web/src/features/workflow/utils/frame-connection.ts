import { isFrameHandleId, parseFrameHandle } from "@neore/backend/workflow/mentions";

/**
 * Which edges a video frame may feed. A `frame-<kind>` source handle is a frame the run extracts
 * from its clip, and the backend reads it only into a video or image-to-video node, so any other
 * target is refused. A frame handle the backend no longer supports (a saved `frame-picked`) is
 * refused too: it is shown on its node so the wire can be removed, but nothing new is drawn to it.
 * A node takes one start or end frame, so a frame is refused into a target that already has one.
 */

/** Node types that read a frame from a `frame-<kind>` handle. */
const FRAME_CONSUMER_TYPES: ReadonlySet<string> = new Set(["image-to-video", "video"]);

export const canConnectFrom = (sourceHandle: string | null | undefined, targetType: string | undefined, targetHasFrame = false): boolean =>
    !isFrameHandleId(sourceHandle) || (parseFrameHandle(sourceHandle) !== undefined && FRAME_CONSUMER_TYPES.has(targetType ?? "") && !targetHasFrame);

/** Whether `targetId` already has an incoming frame wire, of any kind (the backend preflight counts the same). */
export const hasFrameEdgeInto = (edges: ReadonlyArray<{ sourceHandle?: string | null; target: string }>, targetId: string): boolean =>
    edges.some((edge) => edge.target === targetId && isFrameHandleId(edge.sourceHandle));
