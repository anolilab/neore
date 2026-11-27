/**
 * Motion for the composer's `/`, `@` and `{{` popups. They open under the caret while the person is typing, so the
 * enter is short (100 ms) and a highlighted row follows the arrow keys at once (75 ms). Reduced motion drops both;
 * the global rule in `packages/ui/src/global.css` does too, these say it where the classes are.
 */
export const POPUP_ENTER_MOTION = "animate-in fade-in-0 zoom-in-95 slide-in-from-bottom-2 duration-100 ease-out motion-reduce:animate-none";

export const POPUP_ROW_MOTION = "transition-colors duration-75 motion-reduce:transition-none";
