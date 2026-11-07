const FOCUSABLE = 'a[href], button, input, select, textarea, [contenteditable="true"], [tabindex]';

/**
 * Where focus goes when the rename dialog closes. The list mounts the dialog, not the row that opened it, and virtualization can
 * unmount that row while the dialog is open. So focus returns to the thread's row when it is still mounted, else to the list
 * root, which stays mounted while the list is. A container is not focusable by default, so the target is made focusable.
 */
export const renameFocusTarget = (list: HTMLElement | null, threadId: string): HTMLElement | null => {
    if (!list) {
        return null;
    }

    const row = [...list.querySelectorAll<HTMLElement>("[data-thread-id]")].find((element) => element.dataset.threadId === threadId);
    const target = row ?? list;

    if (!target.matches(FOCUSABLE)) {
        target.tabIndex = -1;
    }

    return target;
};
