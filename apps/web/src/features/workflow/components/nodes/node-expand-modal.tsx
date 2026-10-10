import { Dialog as DialogPrimitive } from "@base-ui/react/dialog";
import type { I18n, MessageDescriptor } from "@lingui/core";
import { msg } from "@lingui/core/macro";
import { Trans, useLingui } from "@lingui/react/macro";
import type { GatewayModel } from "@neore/ai/models";
import cn from "@ui/utils/cn";
import { AlertCircle, Code2, Download, FileText, ImageIcon, Video, X } from "lucide-react";

import useFeatureFlaggedModels from "@/hooks/use-feature-flagged-models";

import { useWorkflowStore } from "../../stores/workflow-store";
import type { AINodeData, CodeNodeData, ImageNodeData, TextNodeData, WorkflowNodeData, WorkflowNodeType } from "../../types";
import NODE_CONFIGS from "../../types";
import { getModelLabel } from "../../utils/model-options";

const modelLabel = (m: string | undefined, models: GatewayModel[]) => (m ? getModelLabel(m, models) : undefined);

// ─── Content resolver ─────────────────────────────────────────────────────────

type ContentInfo =
    | { kind: "image"; src: string }
    | { kind: "video"; src: string }
    | { kind: "text"; value: string }
    | { kind: "code"; language?: string; value: string }
    | { kind: "empty" };

/** Media keys a node's execution output may expose. */
interface ExecutionOutput {
    image_url?: unknown;
    imageUrl?: unknown;
    text?: unknown;
    videoUrl?: unknown;
}

const resolveContent = (nodeType: WorkflowNodeType, data: WorkflowNodeData, execOutput: unknown): ContentInfo => {
    // Prefer execution output if available
    if (execOutput && typeof execOutput === "object") {
        const out = execOutput as ExecutionOutput;

        if (typeof out.imageUrl === "string") return { kind: "image", src: out.imageUrl };

        if (typeof out.image_url === "string") return { kind: "image", src: out.image_url };

        if (typeof out.videoUrl === "string") return { kind: "video", src: out.videoUrl };

        if (typeof out.text === "string") return { kind: "text", value: out.text };
    }

    switch (nodeType) {
        case "ai": {
            const d = data as AINodeData;

            return { kind: "text", value: d.systemPrompt ?? "" };
        }
        case "background-removal":
        case "character-ref":
        case "img2img":
        case "inpaint":
        case "outpaint":
        case "style-ref":
        case "upscale": {
            const d = data as WorkflowNodeData & { imageUrl?: string };

            if (d.imageUrl) return { kind: "image", src: d.imageUrl };

            return { kind: "empty" };
        }
        case "code": {
            const d = data as CodeNodeData;

            return { kind: "code", language: d.language, value: d.code };
        }
        case "image": {
            const d = data as ImageNodeData;

            if (d.imageUrl) return { kind: "image", src: d.imageUrl };

            return { kind: "empty" };
        }
        case "image-to-video":
        case "video": {
            const d = data as WorkflowNodeData & { videoUrl?: string };

            if (d.videoUrl) return { kind: "video", src: d.videoUrl };

            return { kind: "empty" };
        }
        case "text": {
            const d = data as TextNodeData;

            return { kind: "text", value: d.content ?? d.template ?? "" };
        }
        default: {
            return { kind: "empty" };
        }
    }
};

// ─── Metadata builder ─────────────────────────────────────────────────────────

interface MetaField {
    label: MessageDescriptor;
    value: string;
}

const buildMetadata = (nodeType: WorkflowNodeType, data: WorkflowNodeData, models: GatewayModel[], i18n: I18n): MetaField[] => {
    const fields: MetaField[] = [{ label: msg`Name`, value: data.label }];
    const config = NODE_CONFIGS[nodeType];

    fields.push({ label: msg`Node type`, value: i18n._(config.label) });

    const d = data as WorkflowNodeData & {
        aspectRatio?: string;
        duration?: number;
        fps?: number;
        language?: string;
        mode?: string;
        model?: string;
        numImages?: number;
        strength?: number;
    };

    if (d.model) fields.push({ label: msg`Model`, value: modelLabel(d.model, models) ?? d.model });

    if (d.aspectRatio) fields.push({ label: msg`Aspect ratio`, value: d.aspectRatio });

    if (d.numImages) fields.push({ label: msg`Images`, value: String(d.numImages) });

    if (d.mode) fields.push({ label: msg`Mode`, value: d.mode });

    if (d.language) fields.push({ label: msg`Language`, value: d.language });

    if (d.duration) fields.push({ label: msg`Duration`, value: `${d.duration}s` });

    if (d.fps) fields.push({ label: msg`FPS`, value: String(d.fps) });

    if (d.strength !== undefined) fields.push({ label: msg`Strength`, value: `${Math.round(d.strength * 100)}%` });

    return fields;
};

// ─── Content display ──────────────────────────────────────────────────────────

const ContentDisplay = ({ content }: { content: ContentInfo }) => {
    const { t } = useLingui();

    if (content.kind === "image") {
        return <img alt={t`Node content`} className="max-h-full max-w-full rounded-lg object-contain select-none" draggable={false} src={content.src} />;
    }

    if (content.kind === "video") {
        return (
            <video className="max-h-full max-w-full rounded-lg" controls src={content.src}>
                <track kind="captions" />
            </video>
        );
    }

    if (content.kind === "text") {
        return (
            <div className="max-h-full w-full max-w-3xl overflow-y-auto">
                <div className="rounded-xl border border-white/10 bg-white/5 p-8 font-mono text-sm leading-relaxed whitespace-pre-wrap text-white/90">
                    {content.value || (
                        <span className="text-white/30 italic">
                            <Trans>No content</Trans>
                        </span>
                    )}
                </div>
            </div>
        );
    }

    if (content.kind === "code") {
        return (
            <div className="max-h-full w-full max-w-4xl overflow-auto">
                <div className="overflow-hidden rounded-xl border border-white/10 bg-white/5">
                    {content.language && (
                        <div className="flex items-center gap-2 border-b border-white/10 px-4 py-2 text-xs text-white/40">
                            <Code2 className="size-3" />
                            {content.language}
                        </div>
                    )}
                    <pre className="overflow-x-auto p-6 font-mono text-sm text-white/80">
                        <code>{content.value || t`// Empty`}</code>
                    </pre>
                </div>
            </div>
        );
    }

    // Empty state
    return (
        <div className="flex flex-col items-center gap-3 text-white/30">
            <AlertCircle className="size-12 opacity-40" />
            <p className="text-sm">
                <Trans>No content to display</Trans>
            </p>
            <p className="text-xs opacity-60">
                <Trans>Run the workflow to generate output</Trans>
            </p>
        </div>
    );
};

// ─── Content icon ──────────────────────────────────────────────────────────────

const contentIcon = (content: ContentInfo) => {
    if (content.kind === "image") {
        return <ImageIcon className="size-4" />;
    }

    if (content.kind === "video") {
        return <Video className="size-4" />;
    }

    if (content.kind === "code") {
        return <Code2 className="size-4" />;
    }

    return <FileText className="size-4" />;
};

// ─── Download helper ──────────────────────────────────────────────────────────

const downloadContent = async (content: ContentInfo, label: string) => {
    if (content.kind === "image" || content.kind === "video") {
        try {
            const response = await fetch(content.src);

            if (!response.ok) {
                throw new Error(`Download failed: ${response.status}`);
            }

            const blob = await response.blob();
            const url = URL.createObjectURL(blob);
            const extension = content.kind === "image" ? "png" : "mp4";
            const a = document.createElement("a");

            a.href = url;
            a.download = `${label.toLowerCase().replaceAll(/\s+/g, "-")}.${extension}`;
            a.click();
            URL.revokeObjectURL(url);
        } catch {
            window.open(content.src, "_blank", "noopener,noreferrer");
        }
    } else if (content.kind === "text" || content.kind === "code") {
        const blob = new Blob([content.value], { type: "text/plain" });
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");

        a.href = url;
        a.download = `${label.toLowerCase().replaceAll(/\s+/g, "-")}.txt`;
        a.click();
        URL.revokeObjectURL(url);
    }
};

// ─── Main component ────────────────────────────────────────────────────────────

export interface NodeExpandModalProps {
    data: WorkflowNodeData;
    nodeId: string;
    nodeType: WorkflowNodeType;
    onClose: () => void;
    open: boolean;
}

const NodeExpandModal = ({ data, nodeId, nodeType, onClose, open }: NodeExpandModalProps) => {
    const execution = useWorkflowStore((state) => state.execution);
    const execOutput = execution.nodeStates[nodeId]?.output;
    const models = useFeatureFlaggedModels();
    const { i18n, t } = useLingui();

    const content = resolveContent(nodeType, data, execOutput);
    const metadata = buildMetadata(nodeType, data, models, i18n);
    const canDownload = content.kind !== "empty";

    return (
        // Base UI Dialog handles Escape key natively
        <DialogPrimitive.Root onOpenChange={(isOpen) => !isOpen && onClose()} open={open}>
            <DialogPrimitive.Portal>
                {/* Backdrop */}
                <DialogPrimitive.Backdrop className="fixed inset-0 z-50 bg-black/90 backdrop-blur-md transition-all duration-250 data-ending-style:opacity-0 data-starting-style:opacity-0" />

                {/* Full-screen popup */}
                <DialogPrimitive.Popup
                    className={cn(
                        "fixed inset-0 z-50 flex outline-none",
                        "data-ending-style:scale-[0.98] data-ending-style:opacity-0",
                        "data-starting-style:scale-[0.98] data-starting-style:opacity-0",
                        "transition-[opacity,transform] duration-200 ease-out",
                    )}
                >
                    {/* Download button – top left */}
                    {canDownload && (
                        <button
                            aria-label={t`Download`}
                            className="absolute top-4 left-4 z-10 flex size-9 items-center justify-center rounded-xl bg-white/10 text-white/70 transition-colors hover:bg-white/20 hover:text-white"
                            onClick={() => downloadContent(content, data.label)}
                            title={t`Download`}
                            type="button"
                        >
                            <Download className="size-4" />
                        </button>
                    )}

                    {/* Close button – top right */}
                    <DialogPrimitive.Close
                        aria-label={t`Close`}
                        className="absolute top-4 right-4 z-10 flex size-9 items-center justify-center rounded-xl bg-white/10 text-white/70 transition-colors hover:bg-white/20 hover:text-white"
                    >
                        <X className="size-4" />
                    </DialogPrimitive.Close>

                    {/* Content area */}
                    <div className="flex min-w-0 flex-1 items-center justify-center p-16 pr-8">
                        <ContentDisplay content={content} />
                    </div>

                    {/* Metadata sidebar */}
                    <aside className="flex w-72 shrink-0 flex-col gap-0 overflow-y-auto border-l border-white/8 bg-white/3">
                        {/* Node type icon header */}
                        <div className="border-b border-white/8 px-6 pt-16 pb-6">
                            <div className="mb-1 flex items-center gap-2 text-white/40">
                                {contentIcon(content)}
                                <span className="text-xs tracking-widest uppercase">{i18n._(NODE_CONFIGS[nodeType].label)}</span>
                            </div>
                        </div>

                        {/* Metadata fields */}
                        <div className="flex flex-col divide-y divide-white/5">
                            {metadata.map((field) => (
                                <div className="px-6 py-4" key={field.label.id}>
                                    <p className="mb-1 text-[11px] tracking-wider text-white/40 uppercase">{i18n._(field.label)}</p>
                                    <p className="text-sm font-medium break-words text-white/85">{field.value}</p>
                                </div>
                            ))}
                        </div>
                    </aside>
                </DialogPrimitive.Popup>
            </DialogPrimitive.Portal>
        </DialogPrimitive.Root>
    );
};

export default NodeExpandModal;
