/** The stored settings that ask before a chat action runs. Absent fields take the default (see `chatActionConfirmations`). */
export interface ChatActionConfirmationSettings {
    confirmBeforeArchiveChat?: boolean;
    confirmBeforeDeleteChat?: boolean;
    confirmBeforeUnpinChat?: boolean;
}

/** Whether each chat action asks first. */
export interface ChatActionConfirmations {
    archive: boolean;
    delete: boolean;
    unpin: boolean;
}

/**
 * Resolves the stored settings to what each action asks for. Archive and unpin ask only when turned on; delete asks
 * unless turned off: it is the only one of the three that removes the chat's messages.
 */
export const chatActionConfirmations = (settings: ChatActionConfirmationSettings | null | undefined): ChatActionConfirmations => {
    return {
        archive: settings?.confirmBeforeArchiveChat === true,
        delete: settings?.confirmBeforeDeleteChat !== false,
        unpin: settings?.confirmBeforeUnpinChat === true,
    };
};

/**
 * What the actions ask while the settings are not known (still loading, or the read failed). Everything asks, so a
 * missing answer never skips a prompt someone opted into.
 */
export const CONFIRM_EVERYTHING: ChatActionConfirmations = { archive: true, delete: true, unpin: true };
