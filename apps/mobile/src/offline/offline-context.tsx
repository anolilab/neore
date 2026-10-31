import { createContext, use } from "react";

import type { ScopedCache } from "./cache";
import type { WriteControl, WriteControlState } from "./write-gate";
import { writeControlState } from "./write-gate";

export interface OfflineValue {
    /** The signed-in account's cache, or undefined while nobody is signed in. */
    cache: ScopedCache | undefined;
    /** The network just came back and no request has answered yet: reads run, writes wait. */
    isChecking: boolean;
    isOffline: boolean;
    /** Moves when a read should run again: the app came back online, or a retry is due while offline. Reads only. */
    refreshTick: number;
    /** Screens report how each read ended, which is how a dead server shows up when the device still has a network. */
    reportRead: (outcome: "failed" | "succeeded") => void;
}

/** Provided by `OfflineProvider`. */
export const OfflineContext = createContext<OfflineValue | undefined>(undefined);

export const useOffline = (): OfflineValue => {
    const value = use(OfflineContext);

    if (!value) {
        throw new Error("useOffline must be used inside OfflineProvider");
    }

    return value;
};

/** The enabled state of one write control, with the reason it is off. */
export const useWriteControl = (control: WriteControl): WriteControlState => {
    const { isChecking, isOffline } = useOffline();

    return writeControlState(control, { isChecking, isOffline });
};
