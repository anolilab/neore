/** How many frames to wait for the composer's editor (it loads lazily) before giving up on moving focus into it. */
export const FOCUS_FRAMES = 60;

/** The composer's input: the chat editor, or a worker's textarea (which has no textbox role). */
export const COMPOSER_INPUT = '[role="textbox"], textarea[data-focus-area="composer"]';

/**
 * Moves focus into a pane's composer once it has mounted (it loads lazily). `onSettled` runs once: with `true` when the composer has taken
 * focus, with `false` when it did not mount within `FOCUS_FRAMES` frames. Returns a function that stops the retries.
 */
export const focusComposerWhenMounted = (pane: { current: HTMLElement | null }, onSettled: (focused: boolean) => void): (() => void) => {
    let frame = 0;
    let frames = 0;
    const focusEditor = () => {
        const editor = pane.current?.querySelector<HTMLElement>(COMPOSER_INPUT);

        if (editor) {
            editor.focus();
            onSettled(true);

            return;
        }

        frames += 1;

        if (frames < FOCUS_FRAMES) {
            frame = requestAnimationFrame(focusEditor);

            return;
        }

        onSettled(false);
    };

    focusEditor();

    return () => cancelAnimationFrame(frame);
};
