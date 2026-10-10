"use client";

import { useLingui } from "@lingui/react/macro";
import { useMemo } from "react";

import type { SystemOptimizerStyle, UserOptimizerStyle } from "@/features/chat/prompt-improvement/lib/optimizer-client";

interface StyleMeta {
    description: string;
    label: string;
}

interface OptimizerStyleLabels {
    system: Record<SystemOptimizerStyle, StyleMeta>;
    user: Record<UserOptimizerStyle, StyleMeta>;
}

/**
 * Centralized translated labels for prompt-optimizer styles.
 *
 * The strings need to live in a React/Lingui context (so they re-render on
 * locale change), which is why this is a hook rather than a static export
 * from `@neore/ai/prompts/optimizer`.
 */
const useOptimizerStyleLabels = (): OptimizerStyleLabels => {
    const { t } = useLingui();

    return useMemo(() => {
        return {
            system: {
                analytical: {
                    description: t`Suited for complex tasks: Role / Background / Attention / Skills / Goals / Constraints / Workflow.`,
                    label: t`Analytical (deep structure)`,
                },
                general: {
                    description: t`Produces a standard Role / Profile / Skills / Rules / Workflows scaffold.`,
                    label: t`General role scaffold`,
                },
                "output-format": {
                    description: t`Like General, but also specifies output format, validation rules, and examples.`,
                    label: t`Output-format focused`,
                },
            },
            user: {
                basic: {
                    description: t`Quick clarity & structure improvements.`,
                    label: t`Basic`,
                },
                planning: {
                    description: t`Decompose the goal into an actionable plan.`,
                    label: t`Planning`,
                },
                professional: {
                    description: t`Precise, quantified, and targeted description.`,
                    label: t`Professional`,
                },
            },
        };
    }, [t]);
};

export default useOptimizerStyleLabels;
