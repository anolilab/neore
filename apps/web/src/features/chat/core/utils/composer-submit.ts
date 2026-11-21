/**
 * "Send this as a new chat" from OUTSIDE the chat UI — today only the native
 * shell's Quick Composer (`lib/native/native-bridge.tsx`). Opt-in by
 * construction: nothing in the web app calls `requestComposerSubmit`, so no
 * browser flow ever sends a message the user did not type and submit.
 *
 * The request is held by a request channel (`core/stores/request-channel-store.ts`)
 * until the NEW-thread composer takes it, so a request made while `/chat` is
 * still loading is sent once that composer mounts and is ready, not dropped.
 */

import { createRequestChannel } from "@/features/chat/core/stores/request-channel-store";

export interface ComposerSubmitRequest {
    text: string;
}

const composerSubmitChannel = createRequestChannel<ComposerSubmitRequest>();

export const requestComposerSubmit = (request: ComposerSubmitRequest): void => {
    composerSubmitChannel.request(request);
};

/** Subscribes the new-thread composer — including to a request made before it mounted. */
export const onComposerSubmitRequest = (handler: (request: ComposerSubmitRequest) => void): (() => void) => composerSubmitChannel.consume(handler);

export { SIGNED_OUT } from "./signed-out";

export interface ComposerAttachRequest {
    /** The account the files were dropped for; absent when it was not known yet (a dock drop while the app starts). */
    accountId?: string;
    files: File[];
}

const composerAttachChannel = createRequestChannel<ComposerAttachRequest>();

/** Whether a request for `requestAccountId` belongs to `accountId`: a request made before the session was known belongs to any. */
const isForAccount = (requestAccountId: string | undefined, accountId: string | undefined): boolean =>
    requestAccountId === undefined || accountId === undefined || requestAccountId === accountId;

/**
 * Files dropped on the dock icon or the sidebar's thread list. The new-thread composer attaches them through its normal
 * upload path; nothing is sent. Drops that arrive before the composer takes them are joined, so a second drop does not
 * replace the first, and a drop made while the session loaded joins the next one, taking its account. Only a drop for
 * another known account replaces the held one, so files never mix across accounts.
 */
export const requestComposerAttach = (request: ComposerAttachRequest): void => {
    const held = composerAttachChannel.store.getState().pending?.payload;

    // Joined for one account, or when the held drop was made before the session was known (it takes the new account). A
    // later drop with no account never joins a held one for an account: it might be for the account that is loading.
    if (held && (held.accountId === request.accountId || held.accountId === undefined)) {
        composerAttachChannel.request({ accountId: request.accountId, files: [...held.files, ...request.files] });

        return;
    }

    composerAttachChannel.request({ accountId: request.accountId, files: request.files });
};

/**
 * Whether dropped files wait for the new-chat composer of `accountId` (any account while it is not known yet): the
 * resume-last-chat redirect must not leave them behind. A request for another account does not count; that composer drops it.
 */
export const hasPendingComposerAttach = (accountId: string | undefined): boolean => {
    const { pending } = composerAttachChannel.store.getState();

    return pending !== null && isForAccount(pending.payload.accountId, accountId);
};

/** Takes `files` back from a request still waiting, for a drop whose new chat could not open. */
export const withdrawComposerAttach = (files: ReadonlyArray<File>): void => {
    const { pending, take } = composerAttachChannel.store.getState();

    if (!pending) {
        return;
    }

    const rest = pending.payload.files.filter((file: File) => !files.includes(file));

    if (rest.length === 0) {
        take();
    } else {
        composerAttachChannel.request({ ...pending.payload, files: rest });
    }
};

/**
 * Hands dropped files to the new-thread composer of `accountId`. A request for another account is not taken at all: it
 * stays for that account's composer (during a switch, the old one may still be listening), is never uploaded under
 * this one, and the next drop for another account replaces it.
 */
export const onComposerAttachRequest = (
    accountId: string,
    handler: (request: ComposerAttachRequest) => void,
    // Told the number of files let go below, so the person can be asked to drop them again.
    onDiscarded: (count: number) => void = () => {},
): (() => void) => {
    // A request that already waits for another account when this composer opens was dropped before a switch: it is let go,
    // so it never turns up hours later in that account's next new chat. One that arrives while this composer listens (the
    // old account's, mid-switch) still waits for its own account's composer.
    const { pending, take } = composerAttachChannel.store.getState();

    if (pending && pending.payload.accountId !== undefined && pending.payload.accountId !== accountId) {
        take();
        onDiscarded(pending.payload.files.length);
    }

    return composerAttachChannel.consume(handler, (request: ComposerAttachRequest) => request.accountId === undefined || request.accountId === accountId);
};
