import { api } from "@neore/backend/api";
import type { Id } from "@neore/backend/dataModel";

import { getClient } from "../lib/lunora";
import { displayTextOf } from "./message-parts";
import { checkPossiblySent, createPossiblySentStore } from "./possibly-sent";

/** Chats and messages read per check: the prompt is among the newest of each, or the check finds nothing. */
const NEWEST = 10;

/** The app's possibly-sent prompts, checked against the server. The rules live in `possibly-sent.ts`. */
export const possiblySent = createPossiblySentStore({
    check: async (entry) =>
        await checkPossiblySent(entry, {
            newestMessages: async (threadId) => {
                const page = await getClient().query(api.chat.functions.getThreadUIMessages, {
                    // eslint-disable-next-line unicorn/no-null -- the server's pagination options take `null` for "from the start"
                    paginationOpts: { cursor: null, numItems: NEWEST },
                    threadId: threadId as Id<"threads">,
                });

                return page.page.map((message) => {
                    // eslint-disable-next-line no-underscore-dangle -- `_creationTime` is the Lunora document field, not a private one
                    return { createdAt: message._creationTime, id: message.id, role: message.role, text: displayTextOf(message.parts) };
                });
            },
            newestThreads: async () => {
                // eslint-disable-next-line unicorn/no-null -- see above
                const data = await getClient().query(api.chat.composite.getThreadListData, { paginationOpts: { cursor: null, numItems: NEWEST } });

                return data.threads.page.map((thread) => {
                    // eslint-disable-next-line no-underscore-dangle -- `_id` and `_creationTime` are the Lunora document fields
                    return { createdAt: thread._creationTime, id: thread._id as string };
                });
            },
        }),
});
