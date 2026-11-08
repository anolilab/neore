/**
 * Bubble menu with the table commands, shown while the selection is inside a table.
 * Replaces the library's `RichTextBubbleTable`, whose icon-only buttons have no accessible name.
 */

import { useLingui } from "@lingui/react/macro";
import type { Editor } from "@tiptap/core";
import { isActive } from "@tiptap/core";
import { useEditorState } from "@tiptap/react";
import { BubbleMenu } from "@tiptap/react/menus";
import type { LucideIcon } from "lucide-react";
import {
    BetweenHorizontalEnd,
    BetweenHorizontalStart,
    BetweenVerticalEnd,
    BetweenVerticalStart,
    Columns2,
    Rows2,
    TableCellsMerge,
    TableCellsSplit,
    Trash2,
} from "lucide-react";

import { Button } from "../components/button";

type TableCommand =
    | "addColumnAfter"
    | "addColumnBefore"
    | "addRowAfter"
    | "addRowBefore"
    | "deleteColumn"
    | "deleteRow"
    | "deleteTable"
    | "mergeCells"
    | "splitCell";

const run = (editor: Editor, command: TableCommand) => {
    editor.chain().focus()[command]().run();
};

export default function TiptapTableBubble({ editor }: { editor: Editor }) {
    const { t } = useLingui();
    const can = useEditorState({
        editor,
        selector: ({ editor: e }) => {
            const probe = e.can();

            return Object.fromEntries(COMMANDS.map(({ command }) => [command, probe[command]()])) as Record<TableCommand, boolean>;
        },
    });

    const labels: Record<TableCommand, string> = {
        addColumnAfter: t`Insert column after`,
        addColumnBefore: t`Insert column before`,
        addRowAfter: t`Insert row below`,
        addRowBefore: t`Insert row above`,
        deleteColumn: t`Delete column`,
        deleteRow: t`Delete row`,
        deleteTable: t`Delete table`,
        mergeCells: t`Merge cells`,
        splitCell: t`Split cell`,
    };

    return (
        <BubbleMenu
            editor={editor}
            options={{ flip: true, offset: 8, placement: "bottom" }}
            pluginKey="TiptapTableBubble"
            shouldShow={({ editor: e }) => isActive(e.view.state, "table")}
        >
            <div aria-label={t`Table`} className="bg-popover text-popover-foreground flex items-center gap-1 rounded-md border p-1 shadow-md" role="toolbar">
                {COMMANDS.map(({ command, Icon, separatorBefore }) => (
                    <span className="contents" key={command}>
                        {separatorBefore && <div className="bg-border mx-1 h-4 w-px" />}
                        <Button
                            aria-label={labels[command]}
                            disabled={!can[command]}
                            onClick={() => run(editor, command)}
                            size="icon"
                            title={labels[command]}
                            type="button"
                            variant="ghost"
                        >
                            <Icon />
                        </Button>
                    </span>
                ))}
            </div>
        </BubbleMenu>
    );
}

const COMMANDS: { command: TableCommand; Icon: LucideIcon; separatorBefore?: boolean }[] = [
    { command: "addColumnBefore", Icon: BetweenHorizontalEnd },
    { command: "addColumnAfter", Icon: BetweenHorizontalStart },
    { command: "deleteColumn", Icon: Columns2 },
    { command: "addRowBefore", Icon: BetweenVerticalEnd, separatorBefore: true },
    { command: "addRowAfter", Icon: BetweenVerticalStart },
    { command: "deleteRow", Icon: Rows2 },
    { command: "mergeCells", Icon: TableCellsMerge, separatorBefore: true },
    { command: "splitCell", Icon: TableCellsSplit },
    { command: "deleteTable", Icon: Trash2, separatorBefore: true },
];
