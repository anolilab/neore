import { useSyncExternalStore } from "react";

/**
 * The user's code-highlight and Mermaid theme choice, read by the Streamdown
 * renderers (`@neore/chat-ui`'s message text).
 *
 * A tiny external store rather than props or a provider, so the chat
 * primitives stay free of app state and the app needs no extra wrapper: the
 * web app pushes its Appearance settings in with `setStreamdownAppearance`,
 * and anything else (SSR, the extension) keeps the defaults below.
 *
 * `shikiTheme` holds bundled theme NAMES only — Shiki `import()`s a theme the
 * first time it highlights with it. `mermaidTheme` goes into the Mermaid config
 * Streamdown passes to the lazily loaded plugin (`use-streamdown-plugins`), so
 * nothing here imports Mermaid.
 */
export type StreamdownAppearance = {
    mermaidTheme: string;
    /** `[light, dark]`, Streamdown's `shikiTheme` order. */
    shikiTheme: [string, string];
};

export const DEFAULT_STREAMDOWN_APPEARANCE: StreamdownAppearance = {
    mermaidTheme: "default",
    shikiTheme: ["poimandres", "min-light"],
};

// Held on an object so the setter mutates a property rather than rebinding a module-level `let`.
const store: { current: StreamdownAppearance; listeners: Set<() => void> } = {
    current: DEFAULT_STREAMDOWN_APPEARANCE,
    listeners: new Set(),
};

/**
 * Replaces the appearance. A no-op when nothing changed, so the snapshot keeps
 * its identity and memoized renderers (and Streamdown's own `shikiTheme ===`
 * comparison) are not disturbed. Pass stable `shikiTheme` tuples.
 */
export const setStreamdownAppearance = (next: StreamdownAppearance): void => {
    const { current } = store;

    if (current.mermaidTheme === next.mermaidTheme && current.shikiTheme === next.shikiTheme) {
        return;
    }

    store.current = next;

    for (const listener of store.listeners) {
        listener();
    }
};

const subscribe = (listener: () => void): (() => void) => {
    store.listeners.add(listener);

    return () => {
        store.listeners.delete(listener);
    };
};

const getSnapshot = (): StreamdownAppearance => store.current;

const getServerSnapshot = (): StreamdownAppearance => DEFAULT_STREAMDOWN_APPEARANCE;

const useStreamdownAppearance = (): StreamdownAppearance => useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);

export default useStreamdownAppearance;
