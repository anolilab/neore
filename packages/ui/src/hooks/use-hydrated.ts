import { useSyncExternalStore } from "react";

const subscribe = () => () => {};

export default function useIsHydrated() {
    return useSyncExternalStore(
        subscribe,
        () => true,
        () => false,
    );
}
