import { Trans } from "@lingui/react/macro";
import { Label } from "@ui/components/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@ui/components/select";
import type { Node, NodeProps } from "@xyflow/react";
import { Code } from "lucide-react";
import { memo } from "react";

import { useWorkflowStore } from "../../stores/workflow-store";
import type { CodeNodeData } from "../../types";
import NODE_CONFIGS from "../../types";
import CodemirrorCompact from "../codemirror-compact";
import BaseNode from "./base-node";

const LANGUAGES = [
    { label: "JavaScript", value: "javascript" },
    { label: "TypeScript", value: "typescript" },
    { label: "Python", value: "python" },
] as const;

const CodeNodeComponent = (props: NodeProps<Node<CodeNodeData>>) => {
    const { data, id } = props;
    const updateNode = useWorkflowStore((state) => state.updateNode);
    const config = NODE_CONFIGS.code;

    const handleLanguageChange = (language: string | null) => {
        if (language === null) {
            return;
        }

        updateNode(id, { language: language as CodeNodeData["language"] });
    };

    const handleCodeChange = (value: string) => {
        updateNode(id, { code: value });
    };

    return (
        <BaseNode {...props} color={config.color} icon={<Code className="size-4" />} inputs={config.handles.inputs} outputs={config.handles.outputs}>
            <div className="space-y-3">
                <div className="space-y-1.5">
                    <Label className="text-muted-foreground text-xs">
                        <Trans>Language</Trans>
                    </Label>
                    <Select onValueChange={handleLanguageChange} value={data.language}>
                        <SelectTrigger className="nodrag h-8 text-sm">
                            <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                            {LANGUAGES.map((lang) => (
                                <SelectItem key={lang.value} value={lang.value}>
                                    {lang.label}
                                </SelectItem>
                            ))}
                        </SelectContent>
                    </Select>
                </div>

                <div className="space-y-1.5">
                    <Label className="text-muted-foreground text-xs">
                        <Trans>Code</Trans>
                    </Label>
                    <div className="nodrag">
                        <CodemirrorCompact height="120px" language={data.language} onChange={handleCodeChange} showLineNumbers value={data.code} />
                    </div>
                </div>
            </div>
        </BaseNode>
    );
};

const CodeNode = memo(CodeNodeComponent);

export default CodeNode;
