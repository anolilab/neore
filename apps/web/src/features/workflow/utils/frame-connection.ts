import { isFrameHandleId, parseFrameHandle } from "@neore/backend/workflow/mentions";

/**
 * Which edges a video frame may feed. A `frame-<kind>` source handle is a frame the run extracts
 * from its clip, and the backend reads it only into a video or image-to-video node, so any other
 * target is refused. A frame handle the backend no longer supports (a saved `frame-picked`) is
 * refused too: it is shown on its node so the wire can be removed, but nothing new is drawn to it.
 */

/** Node types that read a frame from a `frame-<kind>` handle. */
const FRAME_CONSUMER_TYPES: ReadonlySet<string> = new Set(["image-to-video", "video"]);

export const canConnectFrom = (sourceHandle: string | null | undefined, targetType: string | undefined): boolean =>
    !isFrameHandleId(sourceHandle) || (parseFrameHandle(sourceHandle) !== undefined && FRAME_CONSUMER_TYPES.has(targetType ?? ""));
