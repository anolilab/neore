import type { MessageDescriptor } from "@lingui/core";
import { msg } from "@lingui/core/macro";

/**
 * Display labels for the thread categories the AI can assign. The id is the
 * stored backend value; only the label is translated.
 */
export const THREAD_CATEGORY_LABELS: Readonly<Record<string, MessageDescriptor>> = {
    analysis: msg`Analysis`,
    brainstorming: msg`Brainstorming`,
    business: msg`Business`,
    coding: msg`Coding`,
    creative: msg`Creative`,
    general: msg`General`,
    learning: msg`Learning`,
    math: msg`Math`,
    research: msg`Research`,
    writing: msg`Writing`,
};
