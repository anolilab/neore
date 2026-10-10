import { useState } from "react";

/**
 * True from the first time `open` is true, and from then on. Mount a lazy
 * dialog behind it: rendered with `open={false}` from the start, `lazy()`
 * still fetches its chunk on first paint; kept mounted after the first open,
 * its close animation still plays.
 */
export const useHasOpened = (open: boolean): boolean => {
    const [hasOpened, setHasOpened] = useState(open);

    // Latched during render, as React documents for state derived from props.
    if (open && !hasOpened) {
        setHasOpened(true);
    }

    return open || hasOpened;
};
