/**
 * The settings toggles for the in-app toasts a chat run raises (`features/notifications/lib/chat-toasts.ts`).
 * They gate the toast in the browser only: the notification record and any push are written regardless.
 * Absent means on, so an existing account keeps the toasts it would have had.
 */
import { v } from "lunorash/server";

import type { UserSettingsPatch } from "../auth/lib/preference-writes";
import { saveUserSettings } from "../auth/lib/preference-writes";
import { isAccountDeletionUnderway } from "../gdpr/deletion-guard";
import { authMutation, rateLimit } from "../lib/crpc";

const chatToastEvent = v.union(v.literal("failed"), v.literal("finished"), v.literal("input"));

const patchFor = (event: "failed" | "finished" | "input", enabled: boolean): UserSettingsPatch => {
    switch (event) {
        case "failed": {
            return { chatFailedToastEnabled: enabled };
        }
        case "finished": {
            return { chatFinishedToastEnabled: enabled };
        }
        default: {
            return { chatInputToastEnabled: enabled };
        }
    }
};

/** The settings toggle for one chat toast. */
export const setChatToastEnabled = authMutation
    .use(rateLimit("notifications/update"))
    .input({ enabled: v.boolean(), event: chatToastEvent })
    .output(v.null())
    .mutation(async ({ args: { enabled, event }, ctx }) => {
        const { userId } = ctx.user;

        if (await isAccountDeletionUnderway(ctx, userId)) {
            return null;
        }

        const settings = await ctx.db.userSettings.findFirst({ where: { userId } });

        await saveUserSettings(ctx.db, settings, userId, patchFor(event, enabled), ctx.user.activeOrganization?.id ?? null);

        ctx.log.event("notifications.set_chat_toast_enabled", { enabled, event });

        return null;
    });
