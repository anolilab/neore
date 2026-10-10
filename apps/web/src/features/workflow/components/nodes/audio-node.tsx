import type { MessageDescriptor } from "@lingui/core";
import { msg } from "@lingui/core/macro";
import { Trans, useLingui } from "@lingui/react/macro";
import { Label } from "@ui/components/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@ui/components/select";
import { Textarea } from "@ui/components/textarea";
import type { Node, NodeProps } from "@xyflow/react";
import { Volume2 } from "lucide-react";
import { memo } from "react";

import { useWorkflowStore } from "../../stores/workflow-store";
import type { AudioNodeData } from "../../types";
import NODE_CONFIGS from "../../types";
import BaseNode from "./base-node";

const VOICE_OPTIONS: { label: MessageDescriptor; value: string }[] = [
    { label: msg`Alloy (Neutral)`, value: "alloy" },
    { label: msg`Echo (Male)`, value: "echo" },
    { label: msg`Fable (British)`, value: "fable" },
    { label: msg`Onyx (Deep)`, value: "onyx" },
    { label: msg`Nova (Female)`, value: "nova" },
    { label: msg`Shimmer (Warm)`, value: "shimmer" },
];

const AudioNodeComponent = (props: NodeProps<Node<AudioNodeData>>) => {
    const { data, id } = props;
    const updateNode = useWorkflowStore((state) => state.updateNode);
    const config = NODE_CONFIGS.audio;
    const { i18n, t } = useLingui();

    const handleTextChange = (text: string) => {
        updateNode(id, { text });
    };

    const handleVoiceChange = (voice: string | null) => {
        if (voice === null) {
            return;
        }

        updateNode(id, { voice });
    };

    return (
        <BaseNode {...props} color={config.color} icon={<Volume2 className="size-4" />} inputs={config.handles.inputs} outputs={config.handles.outputs}>
            <div className="space-y-3">
                <div className="space-y-1.5">
                    <Label className="text-muted-foreground text-xs" htmlFor={`${id}-text`}>
                        <Trans>Text to Speak</Trans>
                    </Label>
                    <Textarea
                        className="nodrag min-h-[60px] resize-none text-sm"
                        id={`${id}-text`}
                        onChange={(e) => handleTextChange(e.target.value)}
                        placeholder={t`Enter text or leave empty to use input from previous node...`}
                        rows={2}
                        value={data.text ?? ""}
                    />
                    <p className="text-muted-foreground text-xs">
                        <Trans>Leave empty to use input from connected node</Trans>
                    </p>
                </div>

                <div className="space-y-1.5">
                    <Label className="text-muted-foreground text-xs">
                        <Trans>Voice</Trans>
                    </Label>
                    <Select onValueChange={handleVoiceChange} value={data.voice ?? "alloy"}>
                        <SelectTrigger className="nodrag h-8 text-sm">
                            <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                            {VOICE_OPTIONS.map((voice) => (
                                <SelectItem key={voice.value} value={voice.value}>
                                    {i18n._(voice.label)}
                                </SelectItem>
                            ))}
                        </SelectContent>
                    </Select>
                </div>

                <div className="text-muted-foreground bg-muted/50 rounded p-2 text-xs">
                    <Trans>Uses AI SDK Text-to-Speech</Trans>
                </div>
            </div>
        </BaseNode>
    );
};

const AudioNode = memo(AudioNodeComponent);

export default AudioNode;
