import { Trans, useLingui } from "@lingui/react/macro";
import { Button } from "@ui/components/button";
import { Label } from "@ui/components/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@ui/components/select";
import type { TiptapEditorRef } from "@ui/components/tiptap-editor";
import { TiptapEditorMinimal } from "@ui/components/tiptap-editor";
import { ToggleGroup, ToggleGroupItem } from "@ui/components/toggle-group";
import cn from "@ui/utils/cn";
import type { Node, NodeProps } from "@xyflow/react";
import { Type } from "lucide-react";
import { memo, useMemo, useRef } from "react";

import { useWorkflowStore } from "../../stores/workflow-store";
import type { TextNodeData } from "../../types";
import NODE_CONFIGS from "../../types";
import type { JsonCheck } from "../../utils/prompt-format";
import { checkJson, formatJson } from "../../utils/prompt-format";
import MentionPromptField from "../mention-prompt-field";
import BaseNode from "./base-node";

type TemplateFormat = NonNullable<TextNodeData["format"]>;

const TEMPLATE_FORMATS: Record<TemplateFormat, true> = { json: true, text: true, yaml: true };

const isTemplateFormat = (value: string): value is TemplateFormat => Object.hasOwn(TEMPLATE_FORMATS, value);

const TextNodeComponent = (props: NodeProps<Node<TextNodeData>>) => {
    const { data, id } = props;
    const updateNode = useWorkflowStore((state) => state.updateNode);
    const config = NODE_CONFIGS.text;
    const { i18n, t } = useLingui();
    const templateVariable = "{{input}}";
    const editorRef = useRef<TiptapEditorRef>(null);

    const format = data.format ?? "text";
    const template = data.template ?? data.content ?? "";
    const jsonCheck = useMemo(() => (format === "json" ? checkJson(template) : null), [format, template]);

    const handleContentChange = (value: string) => {
        updateNode(id, { content: value });
    };

    const handleModeChange = (mode: string | null) => {
        if (mode === null) {
            return;
        }

        updateNode(id, { mode: mode as TextNodeData["mode"] });
    };

    // The group is single-select; a click on the pressed item yields no value, which is ignored.
    const handleFormatChange = (values: ReadonlyArray<string> | undefined) => {
        const next = values?.[0];

        if (next && isTemplateFormat(next)) {
            updateNode(id, { format: next });
        }
    };

    const handleFormat = () => {
        const result = formatJson(template);

        if (result.ok) {
            updateNode(id, { template: result.text });
        }
    };

    // The state word is the only live text: it changes when a template turns valid or invalid, not on every keystroke.
    const jsonState = (check: JsonCheck): string | null => {
        switch (check.status) {
            case "empty": {
                return null;
            }
            case "invalid": {
                return t`Invalid JSON`;
            }
            case "too-long": {
                return t`Too long to check as JSON`;
            }
            case "valid": {
                return t`Valid JSON`;
            }
            default: {
                const exhaustive: never = check;

                return exhaustive;
            }
        }
    };

    // The position and the Format refusal reason are not live, so typing does not re-announce them.
    const jsonDetail = (check: JsonCheck): string | null => {
        switch (check.status) {
            case "empty":
            case "too-long": {
                return null;
            }
            case "invalid": {
                const { column, line } = check;

                return line === null || column === null ? null : t`Line ${line}, column ${column}`;
            }
            case "valid": {
                return check.formatChangesValues ? t`Formatting would change values` : null;
            }
            default: {
                const exhaustive: never = check;

                return exhaustive;
            }
        }
    };

    const state = jsonCheck && jsonState(jsonCheck);
    const detail = jsonCheck && jsonDetail(jsonCheck);

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
                    <div className="space-y-3">
                        <ToggleGroup
                            aria-label={t`Prompt format`}
                            className="nodrag"
                            onValueChange={handleFormatChange}
                            size="sm"
                            value={[format]}
                            variant="outline"
                        >
                            <ToggleGroupItem value="text">
                                <Trans>Text</Trans>
                            </ToggleGroupItem>
                            <ToggleGroupItem value="json">
                                <Trans>JSON</Trans>
                            </ToggleGroupItem>
                            <ToggleGroupItem value="yaml">
                                <Trans>YAML</Trans>
                            </ToggleGroupItem>
                        </ToggleGroup>

                        {/* JSON and YAML are highlighted by the editor; only JSON is checked, because no YAML parser ships with the web app. */}
                        <MentionPromptField
                            height="96px"
                            hint={<Trans>Type @ to insert the output of a connected text node</Trans>}
                            label={<Trans>Template</Trans>}
                            language={format}
                            lineWrapping={format === "text"}
                            nodeId={id}
                            onChange={(value) => updateNode(id, { template: value })}
                            placeholder={t`Use ${templateVariable} for variables from connected nodes...`}
                            value={template}
                        >
                            {jsonCheck && state && (
                                <div className="flex items-center justify-between gap-2">
                                    <p className={cn("text-xs", jsonCheck.status === "valid" ? "text-muted-foreground" : "text-destructive")}>
                                        <span aria-live="polite" role="status">
                                            {state}
                                        </span>
                                        {detail && <span> · {detail}</span>}
                                    </p>
                                    <Button
                                        className="nodrag"
                                        disabled={jsonCheck.status !== "valid" || jsonCheck.formatChangesValues}
                                        onClick={handleFormat}
                                        size="sm"
                                        type="button"
                                        variant="outline"
                                    >
                                        <Trans>Format</Trans>
                                    </Button>
                                </div>
                            )}
                            {jsonCheck?.status === "invalid" && template.includes("{{") && (
                                <p className="text-muted-foreground text-xs">
                                    <Trans>Placeholders outside quotes are checked as written, so this may read as invalid until a run fills them in</Trans>
                                </p>
                            )}
                        </MentionPromptField>
                    </div>
                )}
            </div>
        </BaseNode>
    );
};

const TextNode = memo(TextNodeComponent);

export default TextNode;
