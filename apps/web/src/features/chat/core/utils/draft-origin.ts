import type { DraftFrom } from "@neore/backend/not-typed-text";

import { useChatUIStore } from "../stores/chat-ui-store";

/**
 * Text that entered the composer without the person typing it: a prompt link (`?prompt=`, a chat's `?initialMessage=`), the
 * desktop shell (a `neore://new?text=` link, a share, the Quick Composer), or a saved prompt someone else wrote. The draft
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

/**
 * A saved prompt put into the composer. Someone else's (an organization's shared prompt; an unknown viewer counts as someone
 * else) marks the draft. The person's own unmarks it only when it `replaced` the whole draft: inserted into other text, that
 * text keeps its mark.
 */
export const noteSavedPrompt = (prompt: { userId: string }, viewerId: string | undefined, { replaced }: { replaced: boolean }): void => {
    if (prompt.userId !== viewerId) {
        markComposerDraft("sharedPrompt");
    } else if (replaced) {
        useChatUIStore.getState().setComposerDraftFrom(undefined);
    }
};

/** A request's `draftFrom`, spread into its body: nothing for the person's own words. */
export const draftFromField = (origin: DraftOrigin | undefined): { draftFrom?: DraftOrigin } => (origin === undefined ? {} : { draftFrom: origin });

/**
 * The mark of a composer's `initialMessage` prefill. A chat's comes from its address (`/chat/$threadId?initialMessage=`),
 * which a link wrote; the new-chat composer's from the hand-off of text typed on the landing or home page.
 */
export const prefillDraftFrom = (threadId: string | undefined): DraftOrigin | undefined => (threadId ? "promptLink" : undefined);
