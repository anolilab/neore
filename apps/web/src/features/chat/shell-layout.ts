import type { CSSProperties } from "react";

/**
 * The chat shell's sidebar setup. The `(chat)` route mounts it for a signed-in user, and the
 * loading skeleton mounts it before auth resolves, so the placeholder's sidebar widths and insets
 * come from the same values as the real layout.
 */
export const chatDefaultOpen = ["left"];

export const chatSidebarNames = ["left", "right"];

export const chatSidebarStyle = {
    "--header-height": "calc(var(--spacing) * 10)",
    "--sidebar-width": "calc(var(--spacing) * 66)",
} as CSSProperties;
