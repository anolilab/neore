import type { View } from "@/features/types";

/** What the panel shows, and the account it was opened under. */
export interface AccountPanel {
    activeOrgId: string | null;
    userId: string | undefined;
    view: View;
}

export const THREADS_VIEW: View = { type: "threads" };

/**
 * What `userId` sees. A panel opened under another account (a sign-in from
 * another panel) is not theirs: its chat, the page context and quick prompt it
 * was seeded with, and the organization picked. They get the thread list
 * instead. A new grant for the same user keeps it all, and an open chat stays
 * mounted.
 */
export const panelFor = (panel: AccountPanel, userId: string | undefined): AccountPanel =>
    panel.userId === userId ? panel : { activeOrgId: null, userId, view: THREADS_VIEW };
