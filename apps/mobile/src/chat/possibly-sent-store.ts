import { api } from "@neore/backend/api";
import type { Id } from "@neore/backend/dataModel";

import { getClient } from "../lib/lunora";
import { displayTextOf } from "./message-parts";
import { checkPossiblySent, createPossiblySentStore } from "./possibly-sent";

/** Chats per page of a check; messages are capped by the server (20). */
const THREADS_PER_PAGE = 100;
const MESSAGES_PER_PAGE = 20;

/** The app's possibly-sent prompts, checked against the server. The rules live in `possibly-sent.ts`. */
export const possiblySent = createPossiblySentStore({
    check: async (entry) =>
        await checkPossiblySent(entry, {
            messages: async (threadId, cursor) => {
                const result = await getClient().query(api.chat.functions.getThreadUIMessages, {
                    paginationOpts: { cursor, numItems: MESSAGES_PER_PAGE },
                    threadId: threadId as Id<"threads">,
                });

                return {
                    continueCursor: result.continueCursor,
                    isDone: result.isDone,
                    page: result.page.map((message) => {
                        // eslint-disable-next-line no-underscore-dangle -- `_creationTime` is the Lunora document field, not a private one
                        return { createdAt: message._creationTime, id: message.id, role: message.role, text: displayTextOf(message.parts) };
                    }),
                };
            },
            threads: async (cursor) => {
                const { threads } = await getClient().query(api.chat.composite.getThreadListData, { paginationOpts: { cursor, numItems: THREADS_PER_PAGE } });

                return {
                    continueCursor: threads.continueCursor,
                    isDone: threads.isDone,
                    page: threads.page.map((thread) => {
                        // eslint-disable-next-line no-underscore-dangle -- `_id` and `_creationTime` are the Lunora document fields
                        return { createdAt: thread._creationTime, id: thread._id as string };
                    }),
                };
            },
        }),
});
