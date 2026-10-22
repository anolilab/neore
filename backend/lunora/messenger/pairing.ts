/**
 * The pairing gate every messenger webhook runs a sender through (see
 * `messenger/lib/pairing.ts` for the why).
 *
 * - Paired connection, its contact → `"proceed"`.
 * - Paired connection, anyone else → a rate-limited "this bot is private" reply.
 * - Unpaired connection, `/pair <code>` with the live code → the sender is bound
 *   and told so; the message itself is not sent to the model.
 * - Unpaired connection, anything else (or a wrong code) → the private reply.
 *
 * Nothing but `"proceed"` reaches the model or the owner's threads.
 */
import type { HttpActionCtx } from "lunorash/server";

import { internal } from "../_generated/internal";
import type { Doc } from "../_generated/dataModel";
import { httpScheduler } from "../lib/http-scheduler";
import { checkRateLimit } from "../lib/rate-limiter";
import { hashPairingCode, PAIRED_NOTICE, parsePairCommand, PRIVATE_BOT_NOTICE } from "./lib/pairing";

export interface PairingSender {
    chatId: string;
    displayName?: string;
    senderId: string;
    text?: string;
    username?: string;
}

/** Where a notice goes: the same addressing `generateAndSendResponse` takes, minus the thread. */
export interface NoticeDelivery {
    inboundAt?: number;
    platform: string;
    platformChatId: string;
    platformThreadTs?: string;
    replyToId?: string;
    replyToken?: string;
    serviceUrl?: string;
}

export type PairingOutcome = "just_paired" | "proceed" | "refused";

const sendNotice = async (context: HttpActionCtx, connection: Doc<"messengerConnections">, delivery: NoticeDelivery, text: string): Promise<void> => {
    await httpScheduler(context).runAfter(0, internal.messenger.respond.sendNotice, { ...delivery, text, userId: connection.userId });
};

const refuse = async (context: HttpActionCtx, connection: Doc<"messengerConnections">, sender: PairingSender, delivery: NoticeDelivery): Promise<"refused"> => {
    // One private-bot reply per stranger per hour: enough to tell a lost user
    // what is going on, never a way to make the bot spam on the owner's quota.
    const notice = await checkRateLimit(context, "messenger/privateNotice", { key: `${connection._id}:${sender.senderId}`, throws: false });

    if (notice.ok) {
        await sendNotice(context, connection, delivery, PRIVATE_BOT_NOTICE);
    }

    return "refused";
};

export const checkSenderPairing = async (
    context: HttpActionCtx,
    connection: Doc<"messengerConnections">,
    sender: PairingSender,
    delivery: NoticeDelivery,
): Promise<PairingOutcome> => {
    if (connection.platformUserId) {
        return connection.platformUserId === sender.senderId ? "proceed" : await refuse(context, connection, sender, delivery);
    }

    const code = parsePairCommand(sender.text);

    if (!code) {
        return await refuse(context, connection, sender, delivery);
    }

    // Guesses are capped per SENDER first, then per connection. A cap on the
    // connection alone let one stranger spend it with five wrong guesses and
    // lock the owner out of pairing for the window. The sender cap is checked
    // first so a sender over it never draws on the shared one; the connection
    // cap is higher, and bounds a stranger rotating through accounts.
    const senderAttempt = await checkRateLimit(context, "messenger/pairAttempt", { key: `${connection._id}:${sender.senderId}`, throws: false });

    if (!senderAttempt.ok) {
        return await refuse(context, connection, sender, delivery);
    }

    const connectionAttempt = await checkRateLimit(context, "messenger/pairAttemptConnection", { key: connection._id, throws: false });

    if (!connectionAttempt.ok) {
        return await refuse(context, connection, sender, delivery);
    }

    const paired = await context.runMutation(internal.messenger.functions.pairConnection, {
        codeHash: await hashPairingCode(code),
        connectionId: connection._id,
        displayName: sender.displayName,
        platformChatId: sender.chatId,
        platformUserId: sender.senderId,
        platformUsername: sender.username,
    });

    if (!paired) {
        return await refuse(context, connection, sender, delivery);
    }

    // A batch (LINE sends several events per request) re-reads this row object.
    connection.platformChatId = sender.chatId;
    connection.platformUserId = sender.senderId;

    await sendNotice(context, connection, delivery, PAIRED_NOTICE);

    return "just_paired";
};
