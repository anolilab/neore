import { parseFrameHandle } from "@neore/backend/workflow/mentions";

/**
 * Which edges a captured video frame may feed. A `frame-<kind>` source handle carries a frame
 * the backend reads only in a video or image-to-video node, so any other target is refused.
 */

/** Node types that read a frame from a `frame-<kind>` handle. */
const FRAME_CONSUMER_TYPES: ReadonlySet<string> = new Set(["image-to-video", "video"]);

export const isFrameHandle = (handleId: string | null | undefined): boolean => parseFrameHandle(handleId) !== undefined;

export const canConnectFrom = (sourceHandle: string | null | undefined, targetType: string | undefined): boolean =>
    !isFrameHandle(sourceHandle) || FRAME_CONSUMER_TYPES.has(targetType ?? "");
