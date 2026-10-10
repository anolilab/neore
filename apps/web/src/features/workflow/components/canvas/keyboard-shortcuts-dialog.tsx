/**
 * Keyboard Shortcuts Help Dialog
 *
 * Displays all available workflow keyboard shortcuts grouped by category.
 * Triggered by pressing "?" on the canvas.
 */
import type { MessageDescriptor } from "@lingui/core";
import { msg } from "@lingui/core/macro";
import { Trans, useLingui } from "@lingui/react/macro";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@ui/components/responsive-dialog";

interface KeyboardShortcutsDialogProps {
    onClose: () => void;
    open: boolean;
}

const isMac = typeof navigator !== "undefined" && /Mac|iPod|iPhone|iPad/.test(navigator.userAgent);
const modifierKey = isMac ? "\u{2318}" : "Ctrl";

interface Shortcut {
    description: MessageDescriptor;
    keys: string;
}

const SHORTCUT_GROUPS: { label: MessageDescriptor; shortcuts: Shortcut[] }[] = [
    {
        label: msg`Execution`,
        shortcuts: [
            { description: msg`Run workflow`, keys: `${modifierKey}+Enter` },
            { description: msg`Save workflow`, keys: `${modifierKey}+S` },
        ],
    },
    {
        label: msg`Editing`,
        shortcuts: [
            { description: msg`Undo`, keys: `${modifierKey}+Z` },
            { description: msg`Redo`, keys: isMac ? `${modifierKey}+Shift+Z` : "Ctrl+Y" },
            { description: msg`Duplicate selected`, keys: `${modifierKey}+D` },
            { description: msg`Copy selected`, keys: `${modifierKey}+C` },
            { description: msg`Paste`, keys: `${modifierKey}+V` },
            { description: msg`Select all`, keys: `${modifierKey}+A` },
            { description: msg`Delete selected`, keys: "Delete / Backspace" },
        ],
    },
    {
        label: msg`Layout`,
        shortcuts: [
            { description: msg`Group selected`, keys: `${modifierKey}+G` },
            { description: msg`Align horizontally`, keys: "H" },
            { description: msg`Align vertically`, keys: "V" },
            { description: msg`Distribute evenly`, keys: "D" },
            { description: msg`Fit view`, keys: "F" },
            { description: msg`Auto-layout`, keys: "L" },
        ],
    },
    {
        label: msg`Navigation`,
        shortcuts: [
            { description: msg`Deselect all`, keys: "Escape" },
            { description: msg`Node search`, keys: `${modifierKey}+K` },
            { description: msg`Show this help`, keys: "?" },
        ],
    },
];

const KeyboardShortcutsDialog = ({ onClose, open }: KeyboardShortcutsDialogProps) => {
    const { i18n } = useLingui();

    return (
        <Dialog onOpenChange={(v) => !v && onClose()} open={open}>
            <DialogContent className="max-w-md">
                <DialogHeader>
                    <DialogTitle>
                        <Trans>Keyboard Shortcuts</Trans>
                    </DialogTitle>
                </DialogHeader>

                <div className="space-y-4">
                    {SHORTCUT_GROUPS.map((group) => (
                        <div key={group.label.id}>
                            <p className="text-muted-foreground mb-2 text-[11px] font-medium tracking-wide uppercase">{i18n._(group.label)}</p>
                            <div className="space-y-1">
                                {group.shortcuts.map((shortcut) => (
                                    <div className="flex items-center justify-between py-1" key={shortcut.description.id}>
                                        <span className="text-sm">{i18n._(shortcut.description)}</span>
                                        <kbd className="bg-muted text-muted-foreground rounded border px-1.5 py-0.5 font-mono text-xs">{shortcut.keys}</kbd>
                                    </div>
                                ))}
                            </div>
                        </div>
                    ))}
                </div>
            </DialogContent>
        </Dialog>
    );
};

export default KeyboardShortcutsDialog;
