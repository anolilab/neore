/**
 * Where a click on a sub-agent opens its chat: the main view (the chat the page shows) or the side panel (a split-view pane beside
 * the focused one). The chosen place is a setting; Ctrl, Cmd or the middle button takes the other place for that one click.
 *
 * The side panel exists only while the split view is on, so without it every click opens the main view.
 */

export type ChatOpenPlace = "main" | "side";

export const DEFAULT_CHAT_OPEN_PLACE: ChatOpenPlace = "side";

/** The saved setting as the app reads it: a browser that saved no value before this setting existed gets the default. */
export const readChatOpenPlace = (value: unknown): ChatOpenPlace => (value === "main" ? "main" : DEFAULT_CHAT_OPEN_PLACE);

/** The parts of a mouse event that decide the place: the button (1 is the middle button) and the two modifier keys. */
export type ChatClick = { button: number; ctrlKey: boolean; metaKey: boolean };

const otherPlace = (place: ChatOpenPlace): ChatOpenPlace => (place === "side" ? "main" : "side");

/**
 * The place one click opens the chat in. `isSideAvailable` is the split view on and laid out side by side: below the desktop breakpoint
 * only the focused pane shows, so a pane beside it would not be seen.
 */
export const chatOpenPlaceFor = (chosen: ChatOpenPlace, click: ChatClick, isSideAvailable: boolean): ChatOpenPlace => {
    const takesOtherPlace = click.button === 1 || click.ctrlKey || click.metaKey;
    const place = takesOtherPlace ? otherPlace(chosen) : chosen;

    return place === "side" && !isSideAvailable ? "main" : place;
};
