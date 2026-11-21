import type { DraftFrom } from "@neore/backend/not-typed-text";

import { useChatUIStore } from "../stores/chat-ui-store";

/**
 * Text that entered the composer without the person typing it: a prompt link (`?prompt=`, a chat's `?initialMessage=`), the
 * desktop shell (a `neore://new?text=` link, a share, the Quick Composer), a saved prompt whose words someone else wrote,
 * forwarded messages, a suggestion they clicked, the prompt improver's rewrite, a gallery item's stored prompt, or an
 * organization's value filled into a prompt. The draft
 * carries the mark (`composerDraftFrom` in `chat-ui-store.ts`) from then on, through edits, a pane switch, a reload
 * (`split/stored-drafts.ts`), the queue and a failed send handed back, until it is sent or emptied. A send names it
 * (`draftFrom`), and the backend saves the prompt marked (`backend/lunora/lib/not-typed-text.ts`), so the agent never reads it
 * as the person's own words when deciding what it may do on their behalf (a saved site login).
 *
 * Set it after the text is in: emptying the draft drops the mark.
 */
export type DraftOrigin = DraftFrom;

/** Marks the live composer's draft as holding text from `origin`. */
export const markComposerDraft = (origin: DraftOrigin): void => {
    useChatUIStore.getState().setComposerDraftFrom(origin);
};

/** The live composer's mark, read when its draft leaves it (a send, the queue, a steer). */
export const composerDraftFrom = (): DraftOrigin | undefined => useChatUIStore.getState().composerDraftFrom;

/** What the composer needs of a saved prompt to tell whose words it holds (`backend/lunora/prompts/content-author.ts`). */
export type SavedPromptAuthorship = {
    contentBy?: string;
    contentByImpersonator?: boolean;
    contentByOthers?: boolean;
    organizationId?: string;
    userId: string;
};

/**
 * Whether the viewer wrote all of the prompt's current words, themselves and not an admin acting as them. The owner's id
 * says nothing about that: a teammate may have edited it, and one other writer of any part makes it someone else's. A row
 * from before the writers were recorded is the viewer's only if it is their own personal prompt; an organization's could
 * hold anyone's words.
 */
export const isOwnPromptContent = (prompt: SavedPromptAuthorship, viewerId: string | undefined): boolean => {
    if (viewerId === undefined || prompt.contentByImpersonator === true || prompt.contentByOthers === true) {
        return false;
    }

    if (prompt.contentBy === undefined) {
        return prompt.userId === viewerId && !prompt.organizationId;
    }

    return prompt.contentBy === viewerId;
};

/**
 * A saved prompt put into the composer. One whose words someone else wrote (`isOwnPromptContent`; an unknown viewer counts
 * as someone else) marks the draft. The person's own unmarks it only when it `replaced` the whole draft: inserted into
 * other text, that text keeps its mark.
 */
export const noteSavedPrompt = (prompt: SavedPromptAuthorship, viewerId: string | undefined, { replaced }: { replaced: boolean }): void => {
    if (!isOwnPromptContent(prompt, viewerId)) {
        markComposerDraft("sharedPrompt");
    } else if (replaced) {
        useChatUIStore.getState().setComposerDraftFrom(undefined);
    }
};

/** A request's `draftFrom`, spread into its body: nothing for the person's own words. */
export const draftFromField = (origin: DraftOrigin | undefined): { draftFrom?: DraftOrigin } => (origin === undefined ? {} : { draftFrom: origin });

/** The new-chat hand-off the chat index read last (`handOffLandingMessage`): its text and mark, kept until the next one. */
const landing: { draftFrom: DraftOrigin | undefined; text: string | undefined } = { draftFrom: undefined, text: undefined };

/**
 * Set when the chat index reads a hand-off: its text and mark, or none, so an earlier one never marks the next. Read by
 * `prefillDraftFrom` for that text only, as often as the composer applies it again (a remount writes the text again).
 */
export const holdLandingDraft = (text: string, origin: DraftOrigin | undefined): void => {
    landing.draftFrom = origin;
    landing.text = text;
};

/**
 * The mark of a composer's `initialMessage` prefill, read when the text is put in. A chat's comes from its address
 * (`/chat/$threadId?initialMessage=`), which a link wrote. The new-chat composer's is its hand-off's when the text is the
 * hand-off's (`handOffLandingMessage`): none for text typed on the landing or home page, `forwarded` for forwarded
 * messages, `suggestion` for an onboarding template.
 */
export const prefillDraftFrom = (threadId: string | undefined, text: string): DraftOrigin | undefined => {
    if (threadId) {
        return "promptLink";
    }

    return landing.text === text ? landing.draftFrom : undefined;
};

/**
 * Gives the live composer's draft, just replaced by an `initialMessage` prefill, that prefill's mark (`prefillDraftFrom`).
 * It replaces the mark the earlier draft held: a hand-off of typed text clears it, so an unsent forwarded or suggested
 * draft never marks the person's own words, and a marked hand-off keeps its own.
 */
export const markPrefilledDraft = (threadId: string | undefined, text: string): void => {
    useChatUIStore.getState().setComposerDraftFrom(prefillDraftFrom(threadId, text));
};
