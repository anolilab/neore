import { useSyncExternalStore } from "react";
import { AppState } from "react-native";

const subscribe = (onChange: () => void) => {
    const subscription = AppState.addEventListener("change", onChange);

    return () => {
        subscription.remove();
    };
};

/** Backgrounded is the one state in which nothing on screen is seen; "inactive" (a system sheet over the app) still shows it. */
const isActive = (): boolean => AppState.currentState !== "background";

/** Whether the app is in the front: polling that only feeds the screen stops while it is not. */
export const useIsAppActive = (): boolean => useSyncExternalStore(subscribe, isActive, isActive);
