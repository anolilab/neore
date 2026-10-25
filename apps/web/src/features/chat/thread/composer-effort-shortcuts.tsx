"use client";

import { useLingui } from "@lingui/react/macro";
import type { FC } from "react";
import { useEffect, useRef } from "react";
import { toast } from "sonner";

import { useChatThread } from "@/features/chat/core/context/chat-context";
import useCurrentModel from "@/features/chat/core/hooks/use-current-model";
import { useModelStore } from "@/features/chat/core/stores/model-store";
import { EFFORT_LABEL_MESSAGES } from "@/features/chat/model-settings/reasoning-effort-selector";
import type { EffortDirection } from "@/features/chat/model-settings/reasoning-effort-steps";
import { stepReasoningEffort, supportsReasoningEffort } from "@/features/chat/model-settings/reasoning-effort-steps";
import { useGatewayModels } from "@/hooks/use-gateway-models";

/** The events the `increaseEffort` / `decreaseEffort` shortcuts dispatch (`use-keyboard-shortcut-handler.ts`). */
const EFFORT_EVENTS: Record<EffortDirection, string> = {
    decrease: "composer.decreaseEffort",
    increase: "composer.increaseEffort",
};

/**
 * Steps the composer's reasoning effort one stop per shortcut press, clamped at both ends. The
 * value lands in the pending settings, which the next send carries (like every other composer
 * setting). A model without reasoning is left alone. The store drops the value when the thread
 * changes (`loadThreadData`). Renders nothing.
 *
 * Mounted once per thread view (`thread.tsx`), not inside `Composer`: the landing page mounts
 * several composers, and each listener would step the value again.
 */
const ComposerEffortShortcuts: FC = () => {
    const { i18n, t } = useLingui();
    const { thread } = useChatThread();
    const model = useCurrentModel();
    // The whole catalog, not the picker's filtered list: a thread keeps its model after a flag or a filter hides it.
    const models = useGatewayModels();
    const comparisonModels = useModelStore((state) => (state.comparisonMode ? state.selectedModelsForComparison : undefined));
    // In a comparison the value goes to each child that reasons, so one is enough.
    const supportsReasoning = (comparisonModels?.length ? comparisonModels : [model as string]).some((id) => supportsReasoningEffort(models, id));
    const threadEffortRef = useRef(thread?.reasoningEffort);

    useEffect(() => {
        threadEffortRef.current = thread?.reasoningEffort;
    });

    useEffect(() => {
        const step = (direction: EffortDirection) => {
            if (!supportsReasoning) {
                toast.info(t`This model has no reasoning effort`);

                return;
            }

            const { pendingSettings, setPendingSettings } = useModelStore.getState();
            const next = stepReasoningEffort(pendingSettings?.reasoningEffort ?? threadEffortRef.current, direction);
            const message = EFFORT_LABEL_MESSAGES[next];

            setPendingSettings((previous) => {
                return { ...previous, reasoningEffort: next };
            });
            toast.info(t`Reasoning effort: ${message ? i18n._(message) : next}`);
        };
        const increase = () => step("increase");
        const decrease = () => step("decrease");

        globalThis.addEventListener(EFFORT_EVENTS.increase, increase);
        globalThis.addEventListener(EFFORT_EVENTS.decrease, decrease);

        return () => {
            globalThis.removeEventListener(EFFORT_EVENTS.increase, increase);
            globalThis.removeEventListener(EFFORT_EVENTS.decrease, decrease);
        };
    }, [i18n, supportsReasoning, t]);

    return null;
};

export default ComposerEffortShortcuts;
