import { Trans, useLingui } from "@lingui/react/macro";
import { Button } from "@ui/components/button";
import type { Node, NodeProps } from "@xyflow/react";
import { File, Loader2, Upload, X } from "lucide-react";
import { memo, useCallback, useState } from "react";
import { useDropzone } from "react-dropzone";

import { uploadChatAttachment } from "@/features/chat/core/adapters/lunora-attachment-adapter";
import { useLunora } from "@/lib/lunora/crpc";

import { useWorkflowStore } from "../../stores/workflow-store";
import type { FileNodeData } from "../../types";
import NODE_CONFIGS from "../../types";
import BaseNode from "./base-node";

const FileNodeComponent = (props: NodeProps<Node<FileNodeData>>) => {
    const { data, id } = props;
    const updateNode = useWorkflowStore((state) => state.updateNode);
    const config = NODE_CONFIGS.file;
    const { t } = useLingui();
    const [isUploading, setIsUploading] = useState(false);
    const lunora = useLunora();

    const onDrop = useCallback(
        async (acceptedFiles: File[]) => {
            const file = acceptedFiles[0];

            if (!file) {
                return;
            }

            setIsUploading(true);

            try {
                // The same signed-URL upload as a chat attachment, with its limits.
                const result = await uploadChatAttachment(lunora, file);

                updateNode(id, {
                    fileId: result.fileId,
                    fileName: file.name,
                    fileType: file.type,
                    fileUrl: result.url,
                });
            } catch {
                // Fallback to blob URL if upload fails
                updateNode(id, {
                    fileName: file.name,
                    fileType: file.type,
                    fileUrl: URL.createObjectURL(file),
                });
            }

            setIsUploading(false);
        },
        [id, lunora, updateNode],
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
            </div>
        </BaseNode>
    );
};

const FileNode = memo(FileNodeComponent);

export default FileNode;
