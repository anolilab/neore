import { Trans, useLingui } from "@lingui/react/macro";
import { Label } from "@ui/components/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@ui/components/select";
import type { TiptapEditorRef } from "@ui/components/tiptap-editor";
import { TiptapEditorMinimal } from "@ui/components/tiptap-editor";
import type { Node, NodeProps } from "@xyflow/react";
import { Type } from "lucide-react";
import { memo, useRef } from "react";

import { useWorkflowStore } from "../../stores/workflow-store";
import type { TextNodeData } from "../../types";
import NODE_CONFIGS from "../../types";
import MentionPromptField from "../mention-prompt-field";
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

                {data.mode === "input" ? (
                    <div className="space-y-1.5">
                        <Label className="text-muted-foreground text-xs">
                            <Trans>Text Content</Trans>
                        </Label>
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
                    </div>
                ) : (
                    <MentionPromptField
                        height="96px"
                        hint={<Trans>Type @ to insert the output of a connected text node</Trans>}
                        label={<Trans>Template</Trans>}
                        nodeId={id}
                        onChange={(value) => updateNode(id, { template: value })}
                        placeholder={t`Use ${templateVariable} for variables from connected nodes...`}
                        value={data.template ?? data.content ?? ""}
                    />
                )}
            </div>
        </BaseNode>
    );
};

const TextNode = memo(TextNodeComponent);

export default TextNode;
