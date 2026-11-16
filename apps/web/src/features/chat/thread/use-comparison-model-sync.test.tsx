import { render } from "@testing-library/react";
import { useEffect } from "react";
import { beforeEach, describe, expect, it } from "vitest";

import { useModelStore } from "@/features/chat/core/stores/model-store";
import { syncFocusedModel } from "@/features/chat/split/pane-state";

import { useComparisonModelSync } from "./use-comparison-model-sync";

const THREAD = "thread-parent";
const branches = [{ model: "m1" }, { model: "m2" }];

interface PaneProps {
    isFocused: boolean;
    isLoaded: boolean;
    model: string;
}

/**
 * Loads the focused chat into the model store, as the split view's focus sync does. It is a child of the pane that runs the
 * comparison hook, so its effect runs first, the same order as on the page.
 */
const FocusSync = ({ isFocused, isLoaded, model }: PaneProps) => {
    useEffect(() => {
        if (isFocused) {
            syncFocusedModel({ isLoaded, mode: "text", model, threadId: THREAD });
        }
    }, [isFocused, isLoaded, model]);

    return null;
};

const Pane = ({ isFocused, isLoaded, model }: PaneProps) => {
    useComparisonModelSync({ active: isFocused, branches });

    return <FocusSync isFocused={isFocused} isLoaded={isLoaded} model={model} />;
};

const comparison = () => {
    const { comparisonMode, selectedModelsForComparison } = useModelStore.getState();

    return { comparisonMode, models: selectedModelsForComparison };
};

describe("comparison mode on a split pane (#11)", () => {
    beforeEach(() => {
        useModelStore.setState({
            comparisonMode: false,
            currentModeThreadId: undefined,
            pendingSettings: undefined,
            selectedModelThreadId: undefined,
            selectedModelsForComparison: [],
            threadModes: new Map(),
            userChangedMode: false,
            userChangedModel: false,
        });
    });

    it("is not turned on by a pane that is not focused", () => {
        render(<Pane isFocused={false} isLoaded model="m" />);

        expect(comparison()).toEqual({ comparisonMode: false, models: [] });
    });

    it("is turned on when the pane takes focus and its chat has loaded", () => {
        const { rerender } = render(<Pane isFocused={false} isLoaded model="m" />);

        rerender(<Pane isFocused isLoaded model="m" />);

        expect(comparison()).toEqual({ comparisonMode: true, models: ["m1", "m2"] });
    });

    it("stays on when the focused chat's own load lands after its branches are known", () => {
        const { rerender } = render(<Pane isFocused isLoaded={false} model="m" />);

        expect(comparison().comparisonMode).toBe(true);

        rerender(<Pane isFocused isLoaded model="m" />);

        expect(comparison()).toEqual({ comparisonMode: true, models: ["m1", "m2"] });
    });

    it("stays on when the focused chat's model changes while it has focus", () => {
        const { rerender } = render(<Pane isFocused isLoaded model="m" />);

        rerender(<Pane isFocused isLoaded model="m2" />);

        expect(useModelStore.getState().selectedModel).toBe("m2");
        expect(comparison()).toEqual({ comparisonMode: true, models: ["m1", "m2"] });
    });
});
