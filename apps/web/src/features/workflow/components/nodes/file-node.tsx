import { Trans, useLingui } from "@lingui/react/macro";
import { api } from "@neore/backend/api";
import { MAX_REFERENCE_AUDIO_BYTES, MAX_REFERENCE_VIDEO_BYTES, referenceMediaLimitFor, referenceMediaTypeOf } from "@neore/backend/document-limits";
import { Button } from "@ui/components/button";
import type { Node, NodeProps } from "@xyflow/react";
import { File, Loader2, Upload, X } from "lucide-react";
import { memo, useCallback, useEffect, useRef, useState } from "react";
import { useDropzone } from "react-dropzone";

import { uploadChatAttachment } from "@/features/chat/core/adapters/lunora-attachment-adapter";
import { useLunora } from "@/lib/lunora/crpc";
import { uploadFile } from "@/lib/upload/upload-file";

import { useWorkflowStore } from "../../stores/workflow-store";
import type { FileNodeData } from "../../types";
import NODE_CONFIGS from "../../types";
import { canTrimVideo } from "../../utils/video-trim";
import BaseNode from "./base-node";
import VideoTrimDialog from "./video-trim-dialog";

const MEGABYTE = 1024 * 1024;

/**
 * A workflow's video or audio: the same TUS upload, declared for the
 * reference-media purpose, then its own finalize (a chat file a media node can
 * point at by `fileId`).
 */
const uploadReferenceMedia = async (lunora: ReturnType<typeof useLunora>, file: File, contentType: string): Promise<{ fileId: string; url: string }> => {
    const uploadId = await uploadFile(file, { contentType, purpose: "reference-media" });

    return await lunora.action(api.file.finalizeReferenceMedia, { filename: file.name, uploadId });
};

const FileNodeComponent = (props: NodeProps<Node<FileNodeData>>) => {
    const { data, id } = props;
    const updateNode = useWorkflowStore((state) => state.updateNode);
    const config = NODE_CONFIGS.file;
    const { t } = useLingui();
    const [isUploading, setIsUploading] = useState(false);
    const [uploadError, setUploadError] = useState<string | null>(null);
    const [trimCandidate, setTrimCandidate] = useState<{ file: File; url: string } | null>(null);
    const [canTrim, setCanTrim] = useState(false);
    const lunora = useLunora();

    useEffect(() => {
        void canTrimVideo().then(setCanTrim);
    }, []);

    // The preview url is a blob of the whole video (up to 50 MB): revoke it when the node goes away with the dialog open.
    const trimUrlRef = useRef<string | null>(null);

    useEffect(() => {
        trimUrlRef.current = trimCandidate?.url ?? null;
    }, [trimCandidate]);

    useEffect(
        () => () => {
            if (trimUrlRef.current) {
                URL.revokeObjectURL(trimUrlRef.current);
            }
        },
        [],
    );

    const closeTrim = () => {
        if (trimCandidate) {
            URL.revokeObjectURL(trimCandidate.url);
        }

        setTrimCandidate(null);
    };

    const upload = useCallback(
        async (file: File) => {
            // Video and audio a media node can reference take their own caps; everything else is a chat attachment.
            const referenceType = referenceMediaTypeOf(file.name, file.type);
            const limit = referenceType ? referenceMediaLimitFor(referenceType) : undefined;

            if (limit !== undefined && file.size > limit) {
                setUploadError(
                    t`Video can be at most ${String(MAX_REFERENCE_VIDEO_BYTES / MEGABYTE)} MB and audio at most ${String(MAX_REFERENCE_AUDIO_BYTES / MEGABYTE)} MB.`,
                );

                return;
            }

            setIsUploading(true);
            setUploadError(null);

            try {
                const result = referenceType ? await uploadReferenceMedia(lunora, file, referenceType) : await uploadChatAttachment(lunora, file);

                updateNode(id, {
                    fileId: result.fileId,
                    fileName: file.name,
                    fileType: referenceType ?? file.type,
                    fileUrl: result.url,
                });
            } catch {
                // No local fallback: a blob URL is not reachable from another node or a later run.
                setUploadError(t`This file could not be uploaded. Check its type and size, then try again.`);
            } finally {
                setIsUploading(false);
            }
        },
        [id, lunora, t, updateNode],
    );

    const onDrop = useCallback(
        async (acceptedFiles: File[]) => {
            const file = acceptedFiles[0];

            if (!file) {
                return;
            }

            // A video is trimmed first, so its size limit applies to the kept part, not the source.
            if (canTrim && referenceMediaTypeOf(file.name, file.type)?.startsWith("video/")) {
                setTrimCandidate({ file, url: URL.createObjectURL(file) });

                return;
            }

            await upload(file);
        },
        [canTrim, upload],
    );

    const { getInputProps, getRootProps, isDragActive } = useDropzone({
        disabled: isUploading,
        multiple: false,
        onDrop,
    });

    const handleClear = (e: React.MouseEvent) => {
        e.stopPropagation();
        updateNode(id, {
            fileId: undefined,
            fileName: undefined,
            fileType: undefined,
            fileUrl: undefined,
        });
    };

    return (
        <BaseNode
            {...props}
            color={config.color}
            icon={<File className="size-4" />}
            inputs={0} // File node has no inputs
            outputs={config.handles.outputs}
        >
            <div className="nodrag">
                {data.fileName ? (
                    <div className="bg-muted flex items-center gap-2 rounded-md p-2">
                        <File className="text-muted-foreground size-4 shrink-0" />
                        <span className="flex-1 truncate text-sm">{data.fileName}</span>
                        <Button aria-label={t`Remove file`} className="size-6 shrink-0" onClick={handleClear} size="icon" variant="ghost">
                            <X className="size-3" />
                        </Button>
                    </div>
                ) : (
                    <div
                        {...getRootProps()}
                        className={`flex cursor-pointer flex-col items-center justify-center gap-2 rounded-md border-2 border-dashed p-4 transition-colors ${
                            isDragActive ? "border-primary bg-primary/5" : "border-muted-foreground/25 hover:border-muted-foreground/50"
                        }`}
                    >
                        <input {...getInputProps()} />
                        {isUploading ? (
                            <>
                                <Loader2 className="text-muted-foreground size-6 animate-spin" />
                                <p className="text-muted-foreground text-center text-xs">
                                    <Trans>Uploading...</Trans>
                                </p>
                            </>
                        ) : (
                            <>
                                <Upload className="text-muted-foreground size-6" />
                                <p className="text-muted-foreground text-center text-xs">
                                    {isDragActive ? <Trans>Drop file here</Trans> : <Trans>Drop file or click to upload</Trans>}
                                </p>
                            </>
                        )}
                    </div>
                )}
                {trimCandidate && (
                    <VideoTrimDialog
                        file={trimCandidate.file}
                        onCancel={closeTrim}
                        onConfirm={(file) => {
                            closeTrim();
                            void upload(file);
                        }}
                        src={trimCandidate.url}
                    />
                )}
                {/* Always mounted, so the error is announced when it appears. */}
                <p aria-live="polite" className="text-destructive mt-1 text-xs" role="status">
                    {uploadError}
                </p>
            </div>
        </BaseNode>
    );
};

const FileNode = memo(FileNodeComponent);

export default FileNode;
