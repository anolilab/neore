import { Trans, useLingui } from "@lingui/react/macro";
import { Input } from "@ui/components/input";
import { Label } from "@ui/components/label";
import type { Node, NodeProps } from "@xyflow/react";
import { GitBranch } from "lucide-react";
import { memo } from "react";

import { useWorkflowStore } from "../../stores/workflow-store";
import type { BranchNodeData } from "../../types";
import NODE_CONFIGS from "../../types";
import BaseNode from "./base-node";

const BranchNodeComponent = (props: NodeProps<Node<BranchNodeData>>) => {
    const { data, id } = props;
    const updateNode = useWorkflowStore((state) => state.updateNode);
    const config = NODE_CONFIGS.branch;
    const { t } = useLingui();
    // The default branches are stored with English labels; show them translated.
    const branchLabel = (branch: { id: string; label: string }) => {
        if (branch.id === "true" && branch.label === "True") return t`True`;

        if (branch.id === "false" && branch.label === "False") return t`False`;

        return branch.label;
    };

    const handleConditionChange = (condition: string) => {
        updateNode(id, { condition });
    };

    return (
        <BaseNode {...props} color={config.color} icon={<GitBranch className="size-4" />} inputs={config.handles.inputs} outputs={data.branches?.length ?? 2}>
            <div className="space-y-3">
                <div className="space-y-1.5">
                    <Label className="text-muted-foreground text-xs" htmlFor={`${id}-condition`}>
                        <Trans>Condition (JavaScript expression)</Trans>
                    </Label>
                    <Input
                        className="nodrag h-8 font-mono text-sm"
                        id={`${id}-condition`}
                        onChange={(e) => handleConditionChange(e.target.value)}
                        placeholder="input.length > 0"
                        value={data.condition ?? ""}
                    />
                </div>

                <div className="space-y-1.5">
                    <Label className="text-muted-foreground text-xs">
                        <Trans>Branches</Trans>
                    </Label>
                    <div className="space-y-1">
                        {data.branches?.map((branch, index) => {
                            const outputNumber = index + 1;
                            const label = branchLabel(branch);

                            return (
                                <div className="flex items-center gap-2 text-xs" key={branch.id}>
                                    <div
                                        className="h-2 w-2 rounded-full"
                                        style={{
                                            backgroundColor: index === 0 ? "#22c55e" : "#ef4444",
                                        }}
                                    />
                                    <span className="text-muted-foreground">
                                        <Trans>
                                            Output {outputNumber}: {label}
                                        </Trans>
                                    </span>
                                </div>
                            );
                        })}
                    </div>
                </div>
            </div>
        </BaseNode>
    );
};

const BranchNode = memo(BranchNodeComponent);

export default BranchNode;
