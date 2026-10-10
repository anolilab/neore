import { firefoxBrowser } from "@/lib/target";
import { PageContextError } from "@/page-context/build";
import { capturePage, selectionContext } from "@/page-context/capture";
import type { PanelRequest } from "@/page-context/panel-request";
import { postPanelRequest } from "@/page-context/panel-request";
import type { QuickAction } from "@/page-context/quick-prompts";
import { QUICK_ACTION_LABELS } from "@/page-context/quick-prompts";

const MENU_CHAT_WITH_PAGE = "chat-with-page";
const SELECTION_ACTIONS: QuickAction[] = ["explain", "summarize", "translate"];

/**
 * Open the side panel for the tab's window.
 *
 * Must be called SYNCHRONOUSLY from the user-gesture handler — `sidePanel.open`
 * and Firefox's `sidebarAction.open` are both rejected once an `await` has run.
 * Either way the request waits in session storage until the panel takes it.
 */
const openPanel = (tab: chrome.tabs.Tab | undefined): void => {
    const sidebar = firefoxBrowser()?.sidebarAction;

    if (sidebar) {
        sidebar.open().catch((error: unknown) => {
            console.warn("[anole] could not open the sidebar", error);
        });

        return;
    }

    if (!chrome.sidePanel?.open || tab?.windowId === undefined) {
        return;
    }

    chrome.sidePanel.open({ windowId: tab.windowId }).catch((error: unknown) => {
        console.warn("[anole] could not open the side panel", error);
    });
};

const newRequestId = (): string => crypto.randomUUID();

const errorRequest = (error: unknown): PanelRequest => {
    return {
        id: newRequestId(),
        kind: "error",
        message: error instanceof PageContextError ? error.message : "Could not read this page.",
    };
};

const chatWithPage = async (tab: chrome.tabs.Tab | undefined, action?: QuickAction): Promise<void> => {
    let request: PanelRequest;

    try {
        if (!tab) {
            throw new PageContextError("No active tab.");
        }

        const context = await capturePage(tab);

        request = action ? { action, context, id: newRequestId(), kind: "quick-prompt" } : { context, id: newRequestId(), kind: "attach-page" };
    } catch (error) {
        request = errorRequest(error);
    }

    await postPanelRequest(request);
};

const createMenus = (): void => {
    chrome.contextMenus.removeAll(() => {
        chrome.contextMenus.create({ contexts: ["page"], id: MENU_CHAT_WITH_PAGE, title: "Chat with this page" });
        chrome.contextMenus.create({ contexts: ["page"], id: "summarize-page", title: QUICK_ACTION_LABELS["summarize-page"] });

        for (const action of SELECTION_ACTIONS) {
            chrome.contextMenus.create({ contexts: ["selection"], id: action, title: `${QUICK_ACTION_LABELS[action]} “%s”` });
        }
    });
};

chrome.runtime.onInstalled.addListener(() => {
    createMenus();

    // Toolbar click opens the panel (no popup).
    chrome.sidePanel?.setPanelBehavior({ openPanelOnActionClick: true }).catch((error: unknown) => {
        console.warn("[anole] could not set side panel behaviour", error);
    });
});

// Firefox has no `openPanelOnActionClick`; the toolbar button toggles the
// sidebar itself. (Chrome never fires `onClicked` while that behaviour is set.)
const firefoxSidebar = firefoxBrowser()?.sidebarAction;

if (firefoxSidebar) {
    chrome.action.onClicked.addListener(() => {
        firefoxSidebar.toggle().catch((error: unknown) => {
            console.warn("[anole] could not toggle the sidebar", error);
        });
    });
}

chrome.contextMenus.onClicked.addListener((info, tab) => {
    openPanel(tab);

    if (info.menuItemId === MENU_CHAT_WITH_PAGE) {
        void chatWithPage(tab);

        return;
    }

    if (info.menuItemId === "summarize-page") {
        void chatWithPage(tab, "summarize-page");

        return;
    }

    const action = SELECTION_ACTIONS.find((candidate) => candidate === info.menuItemId);

    if (!action) {
        return;
    }

    let request: PanelRequest;

    try {
        request = { action, context: selectionContext(info.selectionText ?? "", tab), id: newRequestId(), kind: "quick-prompt" };
    } catch (error) {
        request = errorRequest(error);
    }

    void postPanelRequest(request);
});

chrome.commands.onCommand.addListener((command, tab) => {
    if (command === "open-side-panel") {
        openPanel(tab);

        return;
    }

    if (command === "chat-with-page") {
        openPanel(tab);
        void chatWithPage(tab);
    }
});
