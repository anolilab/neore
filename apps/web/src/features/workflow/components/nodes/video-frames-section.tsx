import { Trans, useLingui } from "@lingui/react/macro";
import type { FrameKind } from "@neore/backend/workflow/mentions";
import { frameHandleId } from "@neore/backend/workflow/mentions";
import { Button } from "@ui/components/button";
import { Input } from "@ui/components/input";
import { Label } from "@ui/components/label";
import { Handle, Position } from "@xyflow/react";
import { useState } from "react";

import { useLunora } from "@/lib/lunora/crpc";

import { useWorkflowStore } from "../../stores/workflow-store";
import NODE_CONFIGS from "../../types";
import { captureVideoFrame, FrameCaptureError, pickedFrameTime, videoUrlOfOutput } from "../../utils/video-frame";
import { storeWorkflowImage } from "../../utils/workflow-image";

/** Where the picked-frame image node lands, to the right of its video node (the connect button's offset). */
const IMAGE_NODE_OFFSET_X = 360;

interface VideoFramesSectionProps {
    nodeId: string;
    pickedTime?: number;
}

/**
 * The frames a node's clip can hand to another video node. Start and last frames are extracted by
 * the run from the clip, so each is only a source handle here. A picked frame (any second of the
 * clip) is captured in the browser into an image node, which the user wires like any other image.
 */
export const VideoFramesSection = ({ nodeId, pickedTime }: VideoFramesSectionProps) => {
    const { i18n, t } = useLingui();
    const lunora = useLunora();
    const addNode = useWorkflowStore((state) => state.addNode);
    const updateNode = useWorkflowStore((state) => state.updateNode);
    const videoUrl = useWorkflowStore((state) => videoUrlOfOutput(state.execution.nodeStates[nodeId]?.output));
    // A saved `frame-picked` wire is no longer a handle. Its handle stays drawn, so the wire can be removed.
    const hasLegacyPickedWire = useWorkflowStore((state) => state.edges.some((edge) => edge.source === nodeId && edge.sourceHandle === "frame-picked"));
    const frameRows: { kind: FrameKind; label: string }[] = [
        { kind: "start", label: t`Start frame` },
        { kind: "end", label: t`Last frame` },
    ];
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const addPickedFrame = async () => {
        if (!videoUrl) {
            return;
        }

        setBusy(true);
        setError(null);

        try {
            const blob = await captureVideoFrame(videoUrl, (duration) => pickedFrameTime(duration, pickedTime ?? 0));
            const imageFileId = await storeWorkflowImage(lunora, new File([blob], "picked-frame.png", { type: "image/png" }));
            const video = useWorkflowStore.getState().nodes.find((node) => node.id === nodeId);

            addNode(
                "image",
                { x: (video?.position.x ?? 0) + IMAGE_NODE_OFFSET_X, y: video?.position.y ?? 0 },
                { imageFileId, imageUrl: undefined, label: i18n._(NODE_CONFIGS.image.defaultLabel), mode: "input" },
            );
        } catch (error_) {
            setError(
                error_ instanceof FrameCaptureError && error_.reason === "cors"
                    ? t`The browser cannot read this video to capture a frame`
                    : t`Frame capture failed`,
            );
        } finally {
            setBusy(false);
        }
    };

    return (
        <div className="nodrag space-y-1.5">
            <Label className="text-muted-foreground text-xs">
                <Trans>Frames</Trans>
            </Label>

            {/* Always mounted, one handle per frame kind: React Flow needs each handle to exist before a wire can attach to it. */}
            {frameRows.map(({ kind, label }) => (
                <div className="relative flex items-center justify-between gap-2 rounded-md border px-2 py-1 text-xs" key={kind}>
                    <span className="truncate">{label}</span>
                    <Handle className="!bg-muted-foreground !border-background !h-3 !w-3" id={frameHandleId(kind)} position={Position.Right} type="source" />
                </div>
            ))}

            {hasLegacyPickedWire && (
                <div className="relative flex items-center justify-between gap-2 rounded-md border border-dashed px-2 py-1 text-xs">
                    <span className="text-muted-foreground truncate">
                        <Trans>Picked frame wire (remove it)</Trans>
                    </span>
                    <Handle
                        className="!bg-muted-foreground !border-background !h-3 !w-3"
                        id="frame-picked"
                        isConnectable={false}
                        position={Position.Right}
                        type="source"
                    />
                </div>
            )}

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

            <Button className="w-full" disabled={!videoUrl || busy} onClick={addPickedFrame} size="sm" type="button" variant="outline">
                {busy ? <Trans>Capturing…</Trans> : <Trans>Add picked frame as image node</Trans>}
            </Button>

            {!videoUrl && (
                <p className="text-muted-foreground text-xs">
                    <Trans>Run the node first to pick a frame</Trans>
                </p>
            )}
            {/* Always mounted: a live region that appears together with its text is often not announced. */}
            <p aria-live="polite" className="text-destructive text-xs" role="status">
                {error}
            </p>
        </div>
    );
};
