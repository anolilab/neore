import { useSidebar } from "@neore/ui/components/sidebar";

import { ASIDE_TAB } from "@/features/chat/aside/open-aside";
import { useChatUIStore } from "@/features/chat/core/stores/chat-ui-store";
import useFeatureFlaggedModels from "@/hooks/use-feature-flagged-models";

/** Text models only have a summary; any other mode (image, video, speech) has none. A thread with no model yet counts as text. */
export const isTextModelId = (model: string | undefined, models: ReadonlyArray<{ id: string; mode?: string }>): boolean =>
    !model || (models.find((candidate) => candidate.id === model)?.mode ?? "text") === "text";

/**
 * The tab the details panel shows. The Ask tab exists for text models only: a thread switched to another model falls back to the
 * Thread tab, which is the one that holds the context box.
 */
export const effectiveRightSidebarTab = (storedTab: string, isTextModel: boolean): string => (!isTextModel && storedTab === ASIDE_TAB ? "summary" : storedTab);

/**
 * Whether the context box of the thread is on screen: the details panel is open (the sheet on a phone) on its Thread tab.
 * The header reads this to leave the linked pull requests to the box, and brings them back when the box is not there.
 */
export const useThreadContextShown = (model: string | undefined): boolean => {
    const { isMobile, isMobileOpen, isOpen } = useSidebar("right");
    const storedTab = useChatUIStore((state) => state.activeRightSidebarTab);
    const flaggedModels = useFeatureFlaggedModels();
    const isPanelOpen = isMobile ? isMobileOpen : isOpen;

    return isPanelOpen && effectiveRightSidebarTab(storedTab, isTextModelId(model, flaggedModels)) === "summary";
};
