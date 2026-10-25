import type { LayoutState } from "@/features/layout/stores/ui-state-store";

export type ChatTextSize = LayoutState["fontSize"];

export const CHAT_TEXT_SIZES = ["small", "medium", "large"] as const satisfies ReadonlyArray<ChatTextSize>;

export const DEFAULT_CHAT_TEXT_SIZE: ChatTextSize = "medium";

/** Set on `<html>`; styles.css scales `.message-text` from it. Absent for the default size. */
export const CHAT_TEXT_SIZE_ATTRIBUTE = "data-chat-text-size";

export const isChatTextSize = (value: unknown): value is ChatTextSize => CHAT_TEXT_SIZES.includes(value as ChatTextSize);

/**
 * Inline `<head>` script that puts the stored chat text size on `<html>` BEFORE
 * first paint, like the accent boot script: the persisted store only
 * rehydrates after the bundle runs, which would flash the default size first.
 * Only `small` / `large` are ever written; anything else leaves the default.
 * A fixed string with no interpolation: the storage key and the attribute are
 * literals here, and `chat-text-size.test.ts` pins that they equal
 * `UI_STATE_STORAGE_KEY` and `CHAT_TEXT_SIZE_ATTRIBUTE`.
 */
export const CHAT_TEXT_SIZE_BOOT_SCRIPT = `(function(){try{var s=JSON.parse(localStorage.getItem("neore-ui-state")||"null");var z=s&&s.state&&s.state.layout&&s.state.layout.fontSize;if(z==="small"||z==="large"){document.documentElement.setAttribute("data-chat-text-size",z)}}catch(e){}})();`;

/** The runtime twin of the boot script: the default size removes the attribute so nothing changes. */
export const applyChatTextSize = (size: unknown, root: HTMLElement = document.documentElement): void => {
    if (size === "small" || size === "large") {
        root.setAttribute(CHAT_TEXT_SIZE_ATTRIBUTE, size);

        return;
    }

    root.removeAttribute(CHAT_TEXT_SIZE_ATTRIBUTE);
};
