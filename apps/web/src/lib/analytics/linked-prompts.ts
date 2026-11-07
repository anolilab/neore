import { peekPendingLinkDraftPrompt } from "@/features/chat/core/utils/pending-link-draft";

/**
 * The text of the prompt links on this page: each draft a link has put in the composer, and the one kept for a visit. The scrubber
 * (`redact-prompt.ts`) removes these texts from every event, so an error report that quotes a draft, in its message, stack or context,
 * sends nothing of it. Only a few are kept: the most recent drafts.
 */

const MAX_REMEMBERED = 20;

const remembered: string[] = [];

/** Remembers `prompt`, the text a link has drafted, so no event sent from this page carries it. */
export const rememberLinkedPrompt = (prompt: string): void => {
    const text = prompt.trim();

    if (text === "") {
        return;
    }

    const index = remembered.indexOf(text);

    if (index !== -1) {
        remembered.splice(index, 1);
    }

    remembered.push(text);

    if (remembered.length > MAX_REMEMBERED) {
        remembered.shift();
    }
};

/** Every linked prompt text the scrubber must remove: the drafts on this page, and the one kept in storage for a visit. */
export const linkedPromptTexts = (): string[] => {
    const kept = peekPendingLinkDraftPrompt();
    const texts = kept === undefined ? remembered : [...remembered, kept.trim()];

    // An empty text would match every string, so it is never a linked prompt.
    return texts.filter((text) => text !== "");
};
