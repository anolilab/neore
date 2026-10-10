/**
 * Keyboard shortcuts for workflow canvas operations.
 *
 * Shortcuts:
 * - Cmd/Ctrl+Enter: Run workflow
 * - Cmd/Ctrl+S: Save workflow
 * - Cmd/Ctrl+Z: Undo
 * - Cmd/Ctrl+Shift+Z / Cmd/Ctrl+Y: Redo
 * - Cmd/Ctrl+D: Duplicate selected node
 * - Cmd/Ctrl+C: Copy selected node
 * - Cmd/Ctrl+V: Paste copied node
 * - Cmd/Ctrl+A: Select all nodes
 * - Cmd/Ctrl+G: Group selected nodes
 * - H: Align selected nodes horizontally
 * - V: Align selected nodes vertically (when no text input is focused)
 * - D: Distribute selected nodes evenly
 * - Escape: Deselect all
 */
import { useLingui } from "@lingui/react/macro";
import { useReactFlow } from "@xyflow/react";
import { useCallback, useEffect } from "react";

import { useHistoryStore } from "../stores/history-store";
import { useWorkflowStore } from "../stores/workflow-store";
import { autoLayout } from "../utils/auto-layout";

interface UseWorkflowShortcutsOptions {
    onRun?: () => void;
    onSave?: () => void;
    onShowNodeSearch?: () => void;
    onShowShortcuts?: () => void;
}

/** Align selected nodes along an axis. */
function alignSelectedNodes(direction: "horizontal" | "vertical") {
    const { nodes } = useWorkflowStore.getState();
    const selected = nodes.filter((n) => n.selected && n.type !== "group" && !n.parentId);

    if (selected.length < 2) return;

    if (direction === "horizontal") {
        // Align all to the average Y position
        const avgY = selected.reduce((sum, n) => sum + n.position.y, 0) / selected.length;
        const selectedIds = new Set(selected.map((n) => n.id));

        useWorkflowStore.getState().setNodes(nodes.map((n) => (selectedIds.has(n.id) ? { ...n, position: { ...n.position, y: avgY } } : n)));
    } else {
        // Align all to the average X position
        const avgX = selected.reduce((sum, n) => sum + n.position.x, 0) / selected.length;
        const selectedIds = new Set(selected.map((n) => n.id));

        useWorkflowStore.getState().setNodes(nodes.map((n) => (selectedIds.has(n.id) ? { ...n, position: { ...n.position, x: avgX } } : n)));
    }
}

/** Distribute selected nodes evenly along the dominant axis. */
function distributeSelectedNodes() {
    const { nodes } = useWorkflowStore.getState();
    const selected = nodes.filter((n) => n.selected && n.type !== "group" && !n.parentId);

    if (selected.length < 3) return;

    // Determine dominant axis (use the axis with the largest spread)
    const xs = selected.map((n) => n.position.x);
    const ys = selected.map((n) => n.position.y);
    const xSpread = Math.max(...xs) - Math.min(...xs);
    const ySpread = Math.max(...ys) - Math.min(...ys);
    const selectedIds = new Set(selected.map((n) => n.id));

    if (xSpread >= ySpread) {
        // Distribute horizontally
        const sorted = selected.toSorted((a, b) => a.position.x - b.position.x);
        const minX = sorted[0]!.position.x;
        const maxX = sorted[sorted.length - 1]!.position.x;
        const step = (maxX - minX) / (sorted.length - 1);

        const posMap = new Map(sorted.map((n, i) => [n.id, minX + step * i]));

        useWorkflowStore
            .getState()
            .setNodes(nodes.map((n) => (selectedIds.has(n.id) ? { ...n, position: { ...n.position, x: posMap.get(n.id) ?? n.position.x } } : n)));
    } else {
        // Distribute vertically
        const sorted = selected.toSorted((a, b) => a.position.y - b.position.y);
        const minY = sorted[0]!.position.y;
        const maxY = sorted[sorted.length - 1]!.position.y;
        const step = (maxY - minY) / (sorted.length - 1);

        const posMap = new Map(sorted.map((n, i) => [n.id, minY + step * i]));

        useWorkflowStore
            .getState()
            .setNodes(nodes.map((n) => (selectedIds.has(n.id) ? { ...n, position: { ...n.position, y: posMap.get(n.id) ?? n.position.y } } : n)));
    }
}

/** Apply auto-layout to the entire workflow. */
function applyAutoLayout() {
    const { edges, nodes, setNodes } = useWorkflowStore.getState();
    const layoutedNodes = autoLayout(nodes, edges);

    setNodes(layoutedNodes);
}

export function useWorkflowShortcuts({ onRun, onSave, onShowNodeSearch, onShowShortcuts }: UseWorkflowShortcutsOptions = {}) {
    const { fitView } = useReactFlow();
    const { t } = useLingui();

    const handleKeyDown = useCallback(
        (event: KeyboardEvent) => {
            // Don't capture shortcuts when typing in inputs/textareas
            const target = event.target as HTMLElement;
            const isEditing = target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable || target.closest(".nodrag");

            const isModule = event.metaKey || event.ctrlKey;

            // ── Mod shortcuts (work even when editing) ──
            if (isModule) {
                switch (event.key.toLowerCase()) {
                    case "a": {
                        if (isEditing) return;

                        event.preventDefault();
                        const { nodes } = useWorkflowStore.getState();

                        useWorkflowStore.getState().setNodes(
                            nodes.map((n) => {
                                return { ...n, selected: true };
                            }),
                        );

                        return;
                    }
                    case "c": {
                        if (isEditing) return;

                        useWorkflowStore.getState().copySelectedNodes();

                        return;
                    }
                    case "d": {
                        if (isEditing) return;

                        event.preventDefault();
                        const { duplicateNode, selectedNodeId } = useWorkflowStore.getState();

                        if (selectedNodeId) duplicateNode(selectedNodeId);

                        return;
                    }
                    case "enter": {
                        event.preventDefault();
                        onRun?.();

                        return;
                    }
                    case "g": {
                        if (isEditing) return;

                        event.preventDefault();
                        const { groupNodes, nodes: allNodes } = useWorkflowStore.getState();
                        const selectedIds: string[] = [];

                        for (const n of allNodes) {
                            if (n.selected && n.type !== "group") selectedIds.push(n.id);
                        }

                        if (selectedIds.length >= 2) groupNodes(selectedIds, t`Group`);

                        return;
                    }
                    case "k": {
                        event.preventDefault();
                        onShowNodeSearch?.();

                        return;
                    }
                    case "s": {
                        event.preventDefault();
                        onSave?.();

                        return;
                    }
                    case "v": {
                        if (isEditing) return;

                        useWorkflowStore.getState().pasteNodes();

                        return;
                    }
                    case "y": {
                        if (isEditing) return;

                        event.preventDefault();
                        useHistoryStore.getState().redo();

                        return;
                    }
                    case "z": {
                        if (isEditing) return;

                        event.preventDefault();

                        if (event.shiftKey) {
                            useHistoryStore.getState().redo();
                        } else {
                            useHistoryStore.getState().undo();
                        }

                        return;
                    }
                    default: {
                        break;
                    }
                }
            }

            // ── Single-key shortcuts (only when NOT editing) ──
            if (isEditing) return;

            // Check "?" before lowercasing (it's shift+/)
            if (event.key === "?") {
                event.preventDefault();
                onShowShortcuts?.();

                return;
            }

            switch (event.key.toLowerCase()) {
                case "d": {
                    if (isModule) return;

                    event.preventDefault();
                    distributeSelectedNodes();

                    return;
                }
                case "escape": {
                    useWorkflowStore.getState().selectNode(null);
                    const { nodes } = useWorkflowStore.getState();

                    useWorkflowStore.getState().setNodes(
                        nodes.map((n) => {
                            return { ...n, selected: false };
                        }),
                    );

                    return;
                }
                case "f": {
                    event.preventDefault();
                    void fitView({ duration: 300, padding: 0.2 });

                    return;
                }
                case "h": {
                    event.preventDefault();
                    alignSelectedNodes("horizontal");

                    return;
                }
                case "l": {
                    event.preventDefault();
                    applyAutoLayout();
                    void fitView({ duration: 300, padding: 0.2 });

                    break;
                }
                case "v": {
                    if (isModule) return; // Already handled above

                    event.preventDefault();
                    alignSelectedNodes("vertical");

                    break;
                }
                default: {
                    break;
                }
            }
        },
        [onRun, onSave, onShowShortcuts, onShowNodeSearch, fitView, t],
    );

    useEffect(() => {
        document.addEventListener("keydown", handleKeyDown);

        return () => document.removeEventListener("keydown", handleKeyDown);
    }, [handleKeyDown]);
}

export { alignSelectedNodes, applyAutoLayout, distributeSelectedNodes };
