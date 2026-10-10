import { Trans, useLingui } from "@lingui/react/macro";
import { Input } from "@ui/components/input";
import { Label } from "@ui/components/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@ui/components/select";
import { Textarea } from "@ui/components/textarea";
import type { Node, NodeProps } from "@xyflow/react";
import { Image as ImageIcon } from "lucide-react";
import { memo } from "react";

import { useWorkflowStore } from "../../stores/workflow-store";
import type { ImageNodeData } from "../../types";
import NODE_CONFIGS from "../../types";
import BaseNode from "./base-node";

const ImageNodeComponent = (props: NodeProps<Node<ImageNodeData>>) => {
    const { data, id } = props;
    const updateNode = useWorkflowStore((state) => state.updateNode);
    const config = NODE_CONFIGS.image;
    const { t } = useLingui();

    const handleModeChange = (mode: string | null) => {
        if (mode === null) {
            return;
        }

        updateNode(id, { mode: mode as ImageNodeData["mode"] });
    };

    const handleImageUrlChange = (imageUrl: string) => {
        updateNode(id, { imageUrl });
    };

    const handlePromptChange = (prompt: string) => {
        updateNode(id, { prompt });
    };

    return (
        <BaseNode {...props} color={config.color} icon={<ImageIcon className="size-4" />} inputs={config.handles.inputs} outputs={config.handles.outputs}>
            <div className="space-y-3">
                <div className="space-y-1.5">
                    <Label className="text-muted-foreground text-xs">
                        <Trans>Mode</Trans>
                    </Label>
                    <Select onValueChange={handleModeChange} value={data.mode}>
                        <SelectTrigger className="nodrag h-8 text-sm">
                            <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                            <SelectItem value="input">
                                <Trans>Input (URL)</Trans>
                            </SelectItem>
                            <SelectItem value="generate">
                                <Trans>Generate</Trans>
                            </SelectItem>
                        </SelectContent>
                    </Select>
                </div>

                {data.mode === "input" ? (
                    <div className="space-y-1.5">
                        <Label className="text-muted-foreground text-xs" htmlFor={`${id}-url`}>
                            <Trans>Image URL</Trans>
                        </Label>
                        <Input
                            className="nodrag h-8 text-sm"
                            id={`${id}-url`}
                            onChange={(e) => handleImageUrlChange(e.target.value)}
                            placeholder="https://..."
                            value={data.imageUrl ?? ""}
                        />
                        {data.imageUrl && (
                            <div className="mt-2 overflow-hidden rounded-md border">
                                <img alt={t`Preview`} className="max-h-[100px] w-full object-contain" src={data.imageUrl} />
                            </div>
                        )}
                    </div>
                ) : (
                    <div className="space-y-1.5">
                        <Label className="text-muted-foreground text-xs" htmlFor={`${id}-prompt`}>
                            <Trans>Generation Prompt</Trans>
                        </Label>
                        <Textarea
                            className="nodrag min-h-[60px] resize-none text-sm"
                            id={`${id}-prompt`}
                            onChange={(e) => handlePromptChange(e.target.value)}
                            placeholder={t`Describe the image to generate...`}
                            rows={2}
                            value={data.prompt ?? ""}
                        />
                    </div>
                )}
            </div>
        </BaseNode>
    );
};

const ImageNode = memo(ImageNodeComponent);

export default ImageNode;
