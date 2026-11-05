import { api } from "@neore/backend/api";

import type { LunoraFixture } from "../lunora";
import { ago, HOUR } from "../clock";
import { lunora } from "../lunora";

const quota = (capacity: number, remaining: number) => {
    return { capacity, remaining };
};

/**
 * The app chrome around a page (header bell, usage ring, changelog card): what a page story
 * needs beside the page's own data. `tier` sets the usage ring; the inbox holds one unread
 * approval and one finished task.
 */
export const shellFixtures = (options: { tier?: "anonymous" | "free" | "premium"; unread?: boolean } = {}): LunoraFixture[] => [
    lunora(api.chat.functions.getMessageRateLimit, {
        audio: quota(20, 18),
        image: quota(50, 41),
        text: quota(500, 412),
        tier: options.tier ?? "premium",
        video: quota(5, 5),
    }),
    lunora(api.notifications.functions.getNotificationInbox, {
        items:
            options.unread === false
                ? []
                : [
                      { _id: "n1", createdAt: ago(HOUR), link: "/chat/t1", read: false, title: "Deploy the preview", type: "tool_approval" },
                      { _id: "n2", createdAt: ago(5 * HOUR), outcome: "success", read: true, title: "Weekly report", type: "task" },
                  ],
        unreadCount: options.unread === false ? 0 : 1,
    }),
    lunora(api.changelog.functions.getChangelogs, []),
];
