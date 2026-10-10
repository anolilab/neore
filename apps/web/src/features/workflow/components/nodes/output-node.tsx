import type { MessageDescriptor } from "@lingui/core";
import { msg } from "@lingui/core/macro";
import { Trans, useLingui } from "@lingui/react/macro";
import { Label } from "@ui/components/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@ui/components/select";
import type { Node, NodeProps } from "@xyflow/react";
import { Monitor } from "lucide-react";
import { memo } from "react";

import { useWorkflowStore } from "../../stores/workflow-store";
import type { OutputNodeData } from "../../types";
import NODE_CONFIGS from "../../types";
import BaseNode from "./base-node";

const OUTPUT_TYPES = [
    { label: msg`Text`, value: "text" },
    { label: msg`Markdown`, value: "markdown" },
    { label: msg`JSON`, value: "json" },
    { label: msg`Image`, value: "image" },
] as const satisfies ReadonlyArray<{ label: MessageDescriptor; value: OutputNodeData["outputType"] }>;

const OutputNodeComponent = (props: NodeProps<Node<OutputNodeData>>) => {
    const { data, id } = props;
    const updateNode = useWorkflowStore((state) => state.updateNode);
    const execution = useWorkflowStore((state) => state.execution);
    const config = NODE_CONFIGS.output;
    const { i18n, t } = useLingui();

    const nodeState = execution.nodeStates[id];
    const output = nodeState?.output;

    const handleOutputTypeChange = (outputType: string | null) => {
        if (outputType === null) {
            return;
        }

        updateNode(id, { outputType: outputType as OutputNodeData["outputType"] });
    };

    const renderOutput = () => {
        if (!output) {
            return (
                <p className="text-muted-foreground text-xs italic">
                    <Trans>No output yet. Run the workflow to see results.</Trans>
                </p>
            );
        }

        switch (data.outputType) {
            case "image": {
                return typeof output === "string" ? (
                    <img alt={t`Output`} className="max-h-[150px] w-full rounded object-contain" src={output} />
                ) : (
                    <p className="text-muted-foreground text-xs">
                        <Trans>Invalid image output</Trans>
                    </p>
                );
            }
            case "json": {
                return <pre className="bg-muted max-h-[150px] overflow-auto rounded p-2 text-xs">{JSON.stringify(output, null, 2)}</pre>;
            }
            default: {
                return <div className="max-h-[150px] overflow-auto text-sm whitespace-pre-wrap">{String(output)}</div>;
            }
        }
    };

    return (
        <BaseNode
            {...props}
            color={config.color}
            icon={<Monitor className="size-4" />}
            inputs={config.handles.inputs}
            outputs={0} // Output node has no outputs
        >
            <div className="space-y-3">
                <div className="space-y-1.5">
                    <Label className="text-muted-foreground text-xs">
                        <Trans>Output Type</Trans>
                    </Label>
                    <Select onValueChange={handleOutputTypeChange} value={data.outputType}>
                        <SelectTrigger className="nodrag h-8 text-sm">
                            <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                            {OUTPUT_TYPES.map((type) => (
                                <SelectItem key={type.value} value={type.value}>
                                    {i18n._(type.label)}
                                </SelectItem>
                            ))}
                        </SelectContent>
                    </Select>
                </div>

                <div className="space-y-1.5">
                    <Label className="text-muted-foreground text-xs">
                        <Trans>Result</Trans>
                    </Label>
                    <div className="bg-muted/50 min-h-[60px] rounded-md p-2">{renderOutput()}</div>
                </div>
            </div>
        </BaseNode>
    );
};

const OutputNode = memo(OutputNodeComponent);

export default OutputNode;
