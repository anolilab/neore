import { create } from "zustand";

/**
 * The sign-in prompt the chat opens when a visitor who may not chat sends a
 * message (invite-only: signed out, or a guest). One prompt for the whole app;
 * `LoginPromptHost` renders it.
 */
interface LoginPromptStore {
    isOpen: boolean;
    setOpen: (isOpen: boolean) => void;
}

export const useLoginPromptStore = create<LoginPromptStore>()((set) => {
    return {
        isOpen: false,
        setOpen: (isOpen) => {
            set({ isOpen });
        },
    };
});

export const openLoginPrompt = (): void => {
    useLoginPromptStore.getState().setOpen(true);
};
