import { useEffect } from "react";

import { useModelStore } from "@/features/chat/core/stores/model-store";

/**
 * Re-enables the model picker's comparison mode for a comparison parent once its children are known: loading a chat into the
 * model store clears it. Only the thread that owns the live composer does so; the split view's background panes share the
 * store and must not turn comparison on (or leave it on) for the focused pane's chat. Focus runs it again, after the focused
 * pane has loaded its chat.
 */
export const useComparisonModelSync = ({ active, branches }: { active: boolean; branches: ReadonlyArray<{ model: string }> }): void => {
    useEffect(() => {
        if (!active || branches.length === 0) {
            return;
        }

        const store = useModelStore.getState();

        store.setSelectedModelsForComparison(branches.map((b) => b.model));
        store.setComparisonMode(true);
    }, [active, branches]);
};
