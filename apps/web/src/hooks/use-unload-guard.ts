import { useEffect } from "react";

import { acquireUnloadGuard } from "@/lib/unload-guard";

/** Warn before the tab closes while `active` is true. */
export const useUnloadGuard = (active: boolean): void => {
    useEffect(() => (active ? acquireUnloadGuard() : undefined), [active]);
};
