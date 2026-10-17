import { Trans, useLingui } from "@lingui/react/macro";
import { frameHandleId } from "@neore/backend/workflow/mentions";
import { Button } from "@ui/components/button";
import { Input } from "@ui/components/input";
import { Label } from "@ui/components/label";
import { Handle, Position } from "@xyflow/react";
import { useEffect, useRef, useState } from "react";

import { useLunora } from "@/lib/lunora/crpc";

import { useWorkflowStore } from "../../stores/workflow-store";
import type { FrameKind, VideoFrameFileIds } from "../../types";
import { captureVideoFrame, clipIdentity, FrameCaptureError, frameFileIdsOf, frameTimeFor, videoUrlOfOutput } from "../../utils/video-frame";
import { storeWorkflowImage } from "../../utils/workflow-image";

interface VideoFramesSectionProps {
    frameFileIds?: VideoFrameFileIds;
    nodeId: string;
    pickedTime?: number;
}

/**
 * Captures start, end and picked frames of a node's clip, so they can be wired into
 * another node. Each row has its own source handle (`frame-<kind>`), rendered
 * unconditionally so React Flow never needs its internals refreshed.
 */
export const VideoFramesSection = ({ frameFileIds, nodeId, pickedTime }: VideoFramesSectionProps) => {
    const { t } = useLingui();
    const lunora = useLunora();
    const updateNode = useWorkflowStore((state) => state.updateNode);
    const videoUrl = useWorkflowStore((state) => videoUrlOfOutput(state.execution.nodeStates[nodeId]?.output));
    const [busy, setBusy] = useState<FrameKind | null>(null);
    const [error, setError] = useState<string | null>(null);
    // The clip the frames were captured from. Starts at the mounted clip, so a remount keeps its frames.
    const clip = videoUrl === undefined ? undefined : clipIdentity(videoUrl);
    const clipRef = useRef(clip);
    const hasFrames = frameFileIds !== undefined && Object.keys(frameFileIds).length > 0;

    // A new clip makes the captured frames stale: clear them so a run never seeds from the previous clip.
    useEffect(() => {
        if (clip === clipRef.current) return;

        clipRef.current = clip;

        if (clip && hasFrames) {
            updateNode(nodeId, { frameFileIds: undefined });
        }
    }, [clip, hasFrames, nodeId, updateNode]);

    const capture = async (kind: FrameKind) => {
        if (!videoUrl) {
            return;
        }

        setBusy(kind);
        setError(null);

        try {
            const blob = await captureVideoFrame(videoUrl, (duration) => frameTimeFor(kind, duration, pickedTime));
            const fileId = await storeWorkflowImage(lunora, new File([blob], `${kind}-frame.png`, { type: "image/png" }));
            // Read the current map: the capture took a while, and another frame may have landed meanwhile.
            const current = frameFileIdsOf(useWorkflowStore.getState().nodes.find((node) => node.id === nodeId));

            updateNode(nodeId, { frameFileIds: { ...current, [kind]: fileId } });
        } catch (error_) {
            setError(
                error_ instanceof FrameCaptureError && error_.reason === "cors"
                    ? t`The browser cannot read this video to capture a frame`
                    : t`Frame capture failed`,
            );
        } finally {
            setBusy(null);
        }
    };

    const rows: { kind: FrameKind; label: string }[] = [
        { kind: "start", label: t`Start frame` },
        { kind: "end", label: t`Last frame` },
        { kind: "picked", label: t`Picked frame` },
    ];

    return (
        <div className="nodrag space-y-1.5">
            <Label className="text-muted-foreground text-xs">
                <Trans>Frames</Trans>
            </Label>

            {rows.map(({ kind, label }) => (
                <div className="relative flex items-center justify-between gap-2 rounded-md border px-2 py-1 text-xs" key={kind}>
                    <span className="truncate">
                        {label}
                        {frameFileIds?.[kind] && <span className="text-muted-foreground"> · {t`captured`}</span>}
                    </span>
                    <Button
                        aria-label={t`Capture ${label}`}
                        disabled={!videoUrl || busy !== null}
                        onClick={() => capture(kind)}
                        size="sm"
                        type="button"
                        variant="outline"
                    >
                        {busy === kind ? <Trans>Capturing…</Trans> : <Trans>Capture</Trans>}
                    </Button>
                    <Handle className="!bg-muted-foreground !border-background !h-3 !w-3" id={frameHandleId(kind)} position={Position.Right} type="source" />
                </div>
            ))}

            <div className="flex items-center gap-2">
                <Label className="text-muted-foreground text-xs" htmlFor={`${nodeId}-picked-time`}>
                    <Trans>Picked at (s)</Trans>
                </Label>
                <Input
                    className="nodrag h-7 w-20 text-xs"
                    id={`${nodeId}-picked-time`}
                    min={0}
                    onChange={(event) => updateNode(nodeId, { pickedTime: Math.max(0, Number(event.target.value) || 0) })}
                    step={0.1}
                    type="number"
                    value={pickedTime ?? 0}
                />
            </div>

            {!videoUrl && (
                <p className="text-muted-foreground text-xs">
                    <Trans>Run the node to capture its frames</Trans>
                </p>
            )}
            {/* Always mounted: a live region that appears together with its text is often not announced. */}
            <p aria-live="polite" className="text-destructive text-xs" role="status">
                {error}
            </p>
        </div>
    );
};
