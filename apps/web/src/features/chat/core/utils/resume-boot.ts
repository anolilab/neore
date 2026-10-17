/**
 * Whether this page load opened on the chat index. Read ONCE, when the app boots:
 * `__root.tsx` imports this module eagerly, so the value is taken from the first
 * URL. A page opened with a query (a prompt, a handoff) is not a resume, and any
 * later visit to /chat (New chat, a sidebar link) is not one either.
 */
export const BOOTED_ON_CHAT_INDEX =
    globalThis.location !== undefined && /^\/chat\/?$/.test(globalThis.location.pathname) && globalThis.location.search === "";
