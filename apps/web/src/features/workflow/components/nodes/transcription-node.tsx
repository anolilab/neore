import type { MessageDescriptor } from "@lingui/core";
import { msg } from "@lingui/core/macro";
import { Trans, useLingui } from "@lingui/react/macro";
import { Label } from "@ui/components/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@ui/components/select";
import type { Node, NodeProps } from "@xyflow/react";
import { Mic } from "lucide-react";
import { memo } from "react";

import { useWorkflowStore } from "../../stores/workflow-store";
import type { TranscriptionNodeData } from "../../types";
import NODE_CONFIGS from "../../types";
import BaseNode from "./base-node";

const LANGUAGE_OPTIONS: { label: MessageDescriptor; value: string }[] = [
    { label: msg`Auto-detect`, value: "auto" },
    { label: msg`English`, value: "en" },
    { label: msg`Spanish`, value: "es" },
    { label: msg`French`, value: "fr" },
    { label: msg`German`, value: "de" },
    { label: msg`Italian`, value: "it" },
    { label: msg`Portuguese`, value: "pt" },
    { label: msg`Dutch`, value: "nl" },
    { label: msg`Japanese`, value: "ja" },
    { label: msg`Korean`, value: "ko" },
    { label: msg`Chinese`, value: "zh" },
    { label: msg`Arabic`, value: "ar" },
    { label: msg`Russian`, value: "ru" },
    { label: msg`Hindi`, value: "hi" },
];

const TranscriptionNodeComponent = (props: NodeProps<Node<TranscriptionNodeData>>) => {
    const { data, id } = props;
    const updateNode = useWorkflowStore((state) => state.updateNode);
    const config = NODE_CONFIGS.transcription;
    const { i18n } = useLingui();

    const handleLanguageChange = (language: string | null) => {
        if (language === null) {
            return;
        }

        updateNode(id, { language });
    };

    return (
        <BaseNode {...props} color={config.color} icon={<Mic className="size-4" />} inputs={config.handles.inputs} outputs={config.handles.outputs}>
            <div className="space-y-3">
                <div className="space-y-1.5">
                    <Label className="text-muted-foreground text-xs">
                        <Trans>Language</Trans>
                    </Label>
                    <Select onValueChange={handleLanguageChange} value={data.language ?? "auto"}>
                        <SelectTrigger className="nodrag h-8 text-sm">
                            <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                            {LANGUAGE_OPTIONS.map((lang) => (
                                <SelectItem key={lang.value} value={lang.value}>
                                    {i18n._(lang.label)}
                                </SelectItem>
                            ))}
                        </SelectContent>
                    </Select>
                </div>

                <div className="text-muted-foreground bg-muted/50 rounded p-2 text-xs">
                    <p>
                        <Trans>Connect an audio/file node as input</Trans>
                    </p>
                    <p className="mt-1">
                        <Trans>Model: OpenAI Whisper</Trans>
                    </p>
                </div>
            </div>
        </BaseNode>
    );
};

const TranscriptionNode = memo(TranscriptionNodeComponent);

export default TranscriptionNode;
