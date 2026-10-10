"use client";

/**
 * Canvas Toolbar - Quick AI action buttons for document editing.
 * Injects pre-defined prompts into the chat composer when clicked.
 */

import { useLingui } from "@lingui/react/macro";
import cn from "@neore/ui/utils/cn";
import type { FC } from "react";

import { useChatUIStore } from "@/features/chat/core/stores/chat-ui-store";

interface CanvasToolbarProps {
    className?: string;
    documentKind: "text" | "code" | "sheet" | "image" | "design";
}

interface QuickAction {
    label: string;
    prompt: string;
}

const CanvasToolbar: FC<CanvasToolbarProps> = ({ className, documentKind }) => {
    const { t } = useLingui();
    const setComposerText = useChatUIStore((state) => state.setComposerText);

    const textActions: QuickAction[] = [
        { label: t`Make shorter`, prompt: "Make this document shorter and more concise. Update the document with the shortened version." },
        { label: t`Make longer`, prompt: "Expand this document with more detail and depth. Update the document with the expanded version." },
        {
            label: t`Fix grammar`,
            prompt: "Fix all grammar, spelling, and punctuation errors in this document. Update the document with the corrected version.",
        },
        { label: t`Simplify`, prompt: "Simplify the language in this document to make it easier to understand. Update the document." },
        { label: t`Change tone`, prompt: "Make this document more professional in tone. Update the document with the revised version." },
    ];

    const codeActions: QuickAction[] = [
        { label: t`Add comments`, prompt: "Add helpful comments throughout this code to explain what each section does. Update the document." },
        { label: t`Optimize`, prompt: "Optimize this code for better performance and readability. Update the document with the optimized version." },
        { label: t`Add error handling`, prompt: "Add proper error handling and edge case checks to this code. Update the document." },
        { label: t`Convert to TypeScript`, prompt: "Convert this code to TypeScript with proper type annotations. Update the document." },
    ];

    const sheetActions: QuickAction[] = [
        {
            label: t`Add summary row`,
            prompt: "Add a summary row at the bottom of this spreadsheet with totals/averages for numeric columns. Update the document.",
        },
        { label: t`Sort data`, prompt: "Sort this spreadsheet data by the most logical column in ascending order. Update the document." },
        {
            label: t`Clean data`,
            prompt: "Clean this spreadsheet data: fix inconsistent formatting, remove duplicates, and standardize values. Update the document.",
        },
        {
            label: t`Add more rows`,
            prompt: "Generate 10 more realistic data rows that follow the same pattern as the existing data in this spreadsheet. Update the document.",
        },
    ];

    const designActions: QuickAction[] = [
        { label: t`Add background`, prompt: "Add a visually appealing background to this design. Update the design with new elements." },
        { label: t`Add title text`, prompt: "Add a prominent title text to this design canvas. Use the updateDesign tool." },
        { label: t`Improve layout`, prompt: "Rearrange the elements in this design for better visual hierarchy and balance. Use the updateDesign tool." },
        { label: t`Change colors`, prompt: "Update the color scheme of this design to be more modern and cohesive. Use the updateDesign tool." },
    ];

    const actionsByKind: Partial<Record<CanvasToolbarProps["documentKind"], QuickAction[]>> = {
        code: codeActions,
        design: designActions,
        sheet: sheetActions,
        text: textActions,
    };
    const actions = actionsByKind[documentKind] ?? [];

    if (actions.length === 0) {
        return null;
    }

    const handleAction = (action: QuickAction) => {
        setComposerText(action.prompt);
    };

    return (
        <div className={cn("flex flex-wrap gap-1.5 border-b px-4 py-2", className)}>
            {actions.map((action) => (
                <button
                    className="bg-muted hover:bg-accent text-muted-foreground hover:text-accent-foreground rounded-md px-2.5 py-1 text-xs transition-colors"
                    key={action.label}
                    onClick={() => handleAction(action)}
                    type="button"
                >
                    {action.label}
                </button>
            ))}
        </div>
    );
};

CanvasToolbar.displayName = "CanvasToolbar";
export default CanvasToolbar;
