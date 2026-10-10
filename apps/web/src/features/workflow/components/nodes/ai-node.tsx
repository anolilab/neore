import { Trans, useLingui } from "@lingui/react/macro";
import { Label } from "@ui/components/label";
import { Textarea } from "@ui/components/textarea";
import type { Node, NodeProps } from "@xyflow/react";
import { Brain } from "lucide-react";
import { memo } from "react";

import { ModelPicker } from "@/components/model-picker";

import { useWorkflowStore } from "../../stores/workflow-store";
import type { AINodeData } from "../../types";
import NODE_CONFIGS from "../../types";
import BaseNode from "./base-node";

const AINodeComponent = (props: NodeProps<Node<AINodeData>>) => {
    const { data, id } = props;
    const updateNode = useWorkflowStore((state) => state.updateNode);
    const config = NODE_CONFIGS.ai;
    const { t } = useLingui();

    const handleModelChange = (model: string) => {
        updateNode(id, { model });
    };

    const handleSystemPromptChange = (systemPrompt: string) => {
        updateNode(id, { systemPrompt });
    };

    return (
        <BaseNode {...props} color={config.color} icon={<Brain className="size-4" />} inputs={config.handles.inputs} outputs={config.handles.outputs}>
            <div className="space-y-3">
                <div className="space-y-1.5">
                    <Label className="text-muted-foreground text-xs">
                        <Trans>Model</Trans>
                    </Label>
                    <div className="nodrag">
                        <ModelPicker footer={null} initialModelId={data.model} onSelect={handleModelChange} />
                    </div>
                </div>

                <div className="space-y-1.5">
                    <Label className="text-muted-foreground text-xs" htmlFor={`${id}-system`}>
                        <Trans>System Prompt (optional)</Trans>
                    </Label>
                    <Textarea
                        className="nodrag min-h-[60px] resize-none text-sm"
                        id={`${id}-system`}
                        onChange={(e) => handleSystemPromptChange(e.target.value)}
                        placeholder={t`Instructions for the AI...`}
                        rows={2}
                        value={data.systemPrompt ?? ""}
                    />
                </div>
            </div>
        </BaseNode>
    );
};

const AINode = memo(AINodeComponent);

export default AINode;
