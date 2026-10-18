import type { MentionKind } from "@neore/backend/workflow/mentions";
import { Label } from "@ui/components/label";
import type { ReactNode } from "react";
import { useId } from "react";
import { useShallow } from "zustand/react/shallow";

import { useWorkflowStore } from "../stores/workflow-store";
import { mentionableLabels } from "../utils/mention-labels";
import CodemirrorCompact from "./codemirror-compact";

interface MentionPromptFieldProps {
    /** Rendered under the editor, above the hint. */
    children?: ReactNode;
    height: string;
    hint: ReactNode;
    /** Upstream node kinds whose labels can be mentioned. Defaults to text only. */
    kinds?: ReadonlyArray<MentionKind>;
    label: ReactNode;
    /** The CodeMirror language. Defaults to plain text. */
    language?: string;
    /** Wrap long lines. Defaults on; JSON and YAML turn it off, where a wrapped line reads as two. */
    lineWrapping?: boolean;
    /** The node the prompt belongs to; its direct upstream nodes supply the labels. */
    nodeId: string;
    onChange: (value: string) => void;
    placeholder?: string;
    value: string;
}

/** A prose prompt with `@` mentions of the node's connected inputs. The visible label names the editor. */
const MentionPromptField = ({
    children,
    height,
    hint,
    kinds,
    label,
    language = "text",
    lineWrapping = true,
    nodeId,
    onChange,
    placeholder,
    value,
}: MentionPromptFieldProps) => {
    const labelId = useId();
    const mentionLabels = useWorkflowStore(useShallow((state) => mentionableLabels(state.nodes, state.edges, nodeId, kinds)));

    return (
        <div className="space-y-1.5">
            <Label className="text-muted-foreground text-xs" id={labelId}>
                {label}
            </Label>
            <CodemirrorCompact
                ariaLabelledBy={labelId}
                className="nodrag"
                height={height}
                language={language}
                lineWrapping={lineWrapping}
                mentionLabels={mentionLabels}
                onChange={onChange}
                placeholder={placeholder}
                prose
                value={value}
            />
            {children}
            <p className="text-muted-foreground text-xs">{hint}</p>
        </div>
    );
};

export default MentionPromptField;
