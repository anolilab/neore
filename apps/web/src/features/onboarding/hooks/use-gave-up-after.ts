import { useEffect, useState } from "react";

/** `true` once `ms` have passed since the component mounted: how long something is worth waiting for before going on without it. */
export const useGaveUpAfter = (ms: number): boolean => {
    const [gaveUp, setGaveUp] = useState(false);

    useEffect(() => {
        const timer = setTimeout(setGaveUp, ms, true);

        return () => clearTimeout(timer);
    }, [ms]);

    return gaveUp;
};
