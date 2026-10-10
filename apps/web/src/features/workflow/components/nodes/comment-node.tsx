import type { MessageDescriptor } from "@lingui/core";
import { msg } from "@lingui/core/macro";
import { Trans, useLingui } from "@lingui/react/macro";
import cn from "@ui/utils/cn";
import type { Node, NodeProps } from "@xyflow/react";
import { NodeResizer } from "@xyflow/react";
import { MessageSquare } from "lucide-react";
import { memo, useEffect, useRef, useState } from "react";

import { useWorkflowStore } from "../../stores/workflow-store";
import type { CommentNodeData } from "../../types";

const COMMENT_COLORS: { label: MessageDescriptor; value: string }[] = [
    { label: msg`Yellow`, value: "#fbbf24" },
    { label: msg`Blue`, value: "#60a5fa" },
    { label: msg`Green`, value: "#34d399" },
    { label: msg`Pink`, value: "#f472b6" },
    { label: msg`Purple`, value: "#a78bfa" },
    { label: msg`Orange`, value: "#fb923c" },
];

const CommentNodeComponent = ({ data, id, selected }: NodeProps<Node<CommentNodeData>>) => {
    const updateNode = useWorkflowStore((state) => state.updateNode);
    const { i18n, t } = useLingui();
    const [isEditing, setIsEditing] = useState(false);
    const textareaRef = useRef<HTMLTextAreaElement>(null);

    // Focus the note as soon as it appears (replaces `autoFocus`, which jsx-a11y
    // forbids because it steals focus on first paint).
    useEffect(() => {
        if (isEditing) {
            textareaRef.current?.focus();
        }
    }, [isEditing]);

    const color = data.color ?? "#fbbf24";

    const handleContentChange = (value: string) => {
        updateNode(id, { content: value });
    };

    const handleColorChange = (newColor: string) => {
        updateNode(id, { color: newColor });
    };

    return (
        <>
            <NodeResizer
                handleClassName="!bg-transparent !border-transparent !w-2 !h-2"
                isVisible={selected}
                lineClassName="!border-transparent"
                minHeight={80}
                minWidth={160}
            />
            <div
                className={cn("relative h-full w-full rounded-lg p-3 shadow-sm transition-shadow", selected && "shadow-md ring-2 ring-offset-1")}
                style={{
                    backgroundColor: `${color}20`,
                    borderColor: `${color}60`,
                    borderStyle: "solid",
                    borderWidth: 1,
                    ...(selected && { ringColor: color }),
                }}
            >
                {/* Header with icon and color dots */}
                <div className="mb-2 flex items-center justify-between">
                    <div className="flex items-center gap-1.5">
                        <MessageSquare aria-hidden="true" className="size-3.5" style={{ color }} />
                        <span className="text-muted-foreground text-[10px] font-medium tracking-wide uppercase">
                            <Trans>Note</Trans>
                        </span>
                    </div>
                    {selected && (
                        <div aria-label={t`Comment color`} className="flex items-center gap-0.5" role="group">
                            {COMMENT_COLORS.map((c) => (
                                <button
                                    aria-label={i18n._(c.label)}
                                    className={cn(
                                        "size-3.5 rounded-full border transition-transform",
                                        color === c.value ? "border-foreground/40 scale-125" : "border-transparent hover:scale-110",
                                    )}
                                    key={c.value}
                                    onClick={() => handleColorChange(c.value)}
                                    style={{ backgroundColor: c.value }}
                                    type="button"
                                />
                            ))}
                        </div>
                    )}
                </div>

                {/* Content area */}
                {isEditing ? (
                    <textarea
                        aria-label={t`Comment`}
                        className="nodrag nowheel text-foreground placeholder:text-muted-foreground/60 w-full resize-none border-none bg-transparent text-sm outline-none"
                        onBlur={() => setIsEditing(false)}
                        onChange={(e) => handleContentChange(e.target.value)}
                        onKeyDown={(e) => {
                            e.stopPropagation();

                            if (e.key === "Escape") {
                                setIsEditing(false);
                            }
                        }}
                        placeholder={t`Add a note...`}
                        ref={textareaRef}
                        rows={3}
                        value={data.content ?? ""}
                    />
                ) : (
                    <div
                        className={cn("nodrag cursor-text text-sm whitespace-pre-wrap", data.content ? "text-foreground" : "text-muted-foreground/60")}
                        onDoubleClick={() => setIsEditing(true)}
                        title={t`Double-click to edit`}
                    >
                        {data.content || t`Double-click to add a note...`}
                    </div>
                )}
            </div>
        </>
    );
};

const CommentNode = memo(CommentNodeComponent);

export default CommentNode;
