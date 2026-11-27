import { create } from "zustand";

import type { SettingsTab } from "./settings-navigation";

interface SettingsRequest {
    anchor?: string;
    /** Counts up on every request, so the same tab asked for twice is still two requests. */
    id: number;
    tab: SettingsTab;
}

/**
 * The last tab a settings link asked for. The link also writes the tab to the URL, but a tab switched to inside the
 * modal is not written back, so a link to the tab the URL already names would change nothing there: the modal
 * follows this request as well.
 */
export const useSettingsRequest = create<{ request?: SettingsRequest }>()(() => {
    return {};
});

export const requestSettingsTab = (tab: SettingsTab, anchor?: string): void => {
    useSettingsRequest.setState((state) => {
        return { request: { anchor, id: (state.request?.id ?? 0) + 1, tab } };
    });
};
