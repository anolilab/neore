import { create } from "zustand";

/**
 * The sign-in prompt the chat opens when a visitor who may not chat sends a
 * message (invite-only: signed out, or a guest). One prompt for the whole app;
 * `LoginPromptHost` renders it.
 */
interface LoginPromptStore {
    isOpen: boolean;

    /**
     * The page the prompt was opened on (path, query and hash). Sign-in returns there, also from the
     * forgot-password, magic-link and email-code pages the prompt links to.
     */
    openedFrom: string | undefined;
    setOpen: (isOpen: boolean) => void;
}

/** The current URL; `undefined` outside a browser. */
const currentUrl = (): string | undefined =>
    globalThis.location === undefined ? undefined : `${globalThis.location.pathname}${globalThis.location.search}${globalThis.location.hash}`;

export const useLoginPromptStore = create<LoginPromptStore>()((set) => {return {
    isOpen: false,
    openedFrom: undefined,
    setOpen: (isOpen) => {
        set({ isOpen });
    },
}});

export const openLoginPrompt = (): void => {
    useLoginPromptStore.setState({ isOpen: true, openedFrom: currentUrl() });
};
