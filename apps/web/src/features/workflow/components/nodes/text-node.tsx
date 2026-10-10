import { Trans, useLingui } from "@lingui/react/macro";
import { Label } from "@ui/components/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@ui/components/select";
import { Textarea } from "@ui/components/textarea";
import type { TiptapEditorRef } from "@ui/components/tiptap-editor";
import { TiptapEditorMinimal } from "@ui/components/tiptap-editor";
import type { Node, NodeProps } from "@xyflow/react";
import { Type } from "lucide-react";
import { memo, useRef } from "react";

import { useWorkflowStore } from "../../stores/workflow-store";
import type { TextNodeData } from "../../types";
import NODE_CONFIGS from "../../types";
import BaseNode from "./base-node";

const TextNodeComponent = (props: NodeProps<Node<TextNodeData>>) => {
    const { data, id } = props;
    const updateNode = useWorkflowStore((state) => state.updateNode);
    const config = NODE_CONFIGS.text;
    const { i18n, t } = useLingui();
    const templateVariable = "{{input}}";
    const editorRef = useRef<TiptapEditorRef>(null);

    const handleContentChange = (value: string) => {
        updateNode(id, { content: value });
    };

    const handleModeChange = (mode: string | null) => {
        if (mode === null) {
            return;
        }

        updateNode(id, { mode: mode as TextNodeData["mode"] });
    };

    return (
        <BaseNode {...props} color={config.color} icon={<Type className="size-4" />} inputs={config.handles.inputs} outputs={config.handles.outputs}>
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
                                <Trans>Input (Rich Text)</Trans>
                            </SelectItem>
                            <SelectItem value="transform">
                                <Trans>Transform (Template)</Trans>
                            </SelectItem>
                        </SelectContent>
                    </Select>
                </div>

                <div className="space-y-1.5">
                    <Label className="text-muted-foreground text-xs" htmlFor={`${id}-content`}>
                        {data.mode === "input" ? <Trans>Text Content</Trans> : <Trans>Template</Trans>}
                    </Label>
                    {data.mode === "input" ? (
                        <div className="nodrag">
                            <TiptapEditorMinimal
                                className="min-h-[80px] text-sm"
                                content={data.content ?? ""}
                                locale={i18n.locale}
                                onChange={handleContentChange}
                                placeholder={t`Enter text...`}
                                ref={editorRef}
                            />
                        </div>
                    ) : (
                        <Textarea
                            className="nodrag min-h-[80px] resize-none font-mono text-sm"
                            id={`${id}-content`}
                            onChange={(e) => updateNode(id, { template: e.target.value })}
                            placeholder={t`Use ${templateVariable} for variables from connected nodes...`}
                            rows={3}
                            value={data.template ?? data.content ?? ""}
                        />
                    )}
                </div>
            </div>
        </BaseNode>
    );
};

const TextNode = memo(TextNodeComponent);

export default TextNode;
