import type { NavigationDirection } from "@ui/types/data-grid";

export const DEFAULT_ROW_HEIGHT = "short";
export const OVERSCAN = 6;
export const VIEWPORT_OFFSET = 1;
export const HORIZONTAL_PAGE_SIZE = 5;
export const SCROLL_SYNC_RETRY_COUNT = 16;
export const MIN_COLUMN_SIZE = 60;
export const MAX_COLUMN_SIZE = 800;
export const SEARCH_SHORTCUT_KEY = "f";
export const NON_NAVIGABLE_COLUMN_IDS = new Set(["actions", "select"]);

export const SCROLL_ALIGN_START_DIRECTIONS = new Set(["ctrl+home", "ctrl+up", "pageup", "up"]);
export const SCROLL_ALIGN_END_DIRECTIONS = new Set(["ctrl+down", "ctrl+end", "down", "pagedown"]);
export const HORIZONTAL_NAVIGATION_DIRECTIONS = new Set(["end", "home", "left", "right"]);

export const isHorizontalNavigation = (direction: NavigationDirection): direction is "left" | "right" | "home" | "end" =>
    HORIZONTAL_NAVIGATION_DIRECTIONS.has(direction);
export const VERTICAL_NAVIGATION_DIRECTIONS = new Set(["ctrl+down", "ctrl+end", "ctrl+home", "ctrl+up", "down", "pagedown", "pageup", "up"]);

export const getScrollAlign = (direction: NavigationDirection): "center" | "end" | "start" => {
    if (SCROLL_ALIGN_START_DIRECTIONS.has(direction)) {
        return "start";
    }

    if (SCROLL_ALIGN_END_DIRECTIONS.has(direction)) {
        return "end";
    }

    return "center";
};
