import type { PageContext } from "./build";
import type { QuickAction } from "./quick-prompts";

/**
 * A request the background worker hands to the side panel.
 *
 * The worker cannot talk to a panel that is still opening, so it parks the
 * request in `chrome.storage.session` (memory-only, cleared with the browser
 * session, and not readable from content scripts at the default access level)
 * and the panel takes it on mount or when it changes.
 */
export type PanelRequest =
    | { context: PageContext; id: string; kind: "attach-page" }
    | { action: QuickAction; context: PageContext; id: string; kind: "quick-prompt" }
    | { id: string; kind: "error"; message: string };

const KEY = "neore.panelRequest";

export const postPanelRequest = async (request: PanelRequest): Promise<void> => {
    await chrome.storage.session.set({ [KEY]: request });
};

/** Read and clear the parked request, so each is handled exactly once. */
export const takePanelRequest = async (): Promise<PanelRequest | undefined> => {
    const stored = await chrome.storage.session.get(KEY);
    const request = stored[KEY] as PanelRequest | undefined;

    if (request) {
        await chrome.storage.session.remove(KEY);
    }

    return request;
};

/** Call `onRequest` for the parked request and every later one. Returns the unsubscribe. */
export const subscribePanelRequests = (onRequest: (request: PanelRequest) => void): (() => void) => {
    const listener = (changes: Record<string, chrome.storage.StorageChange>, area: string) => {
        if (area === "session" && changes[KEY]?.newValue) {
            void takePanelRequest().then((request) => request && onRequest(request));
        }
    };

    chrome.storage.onChanged.addListener(listener);
    void takePanelRequest().then((request) => request && onRequest(request));

    return () => chrome.storage.onChanged.removeListener(listener);
};
