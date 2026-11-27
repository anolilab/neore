import { useSyncExternalStore } from "react";

import { hasNativeCapability, isNativeShell } from "./bridge";

// The bridge is installed before any page script and never changes, so there is nothing to subscribe to.
const subscribe = (): (() => void) => () => {};
const onServer = (): boolean => false;

/** Whether the desktop shell is present: `false` on the server and in the hydration pass, so markup matches. */
export const useIsNativeShell = (): boolean => useSyncExternalStore(subscribe, isNativeShell, onServer);

/** Whether the desktop shell advertises `capability`; `false` on the server and in the hydration pass. */
export const useNativeCapability = (capability: string): boolean => useSyncExternalStore(subscribe, () => hasNativeCapability(capability), onServer);
