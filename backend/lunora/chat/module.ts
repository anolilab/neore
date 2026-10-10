import { defineModule } from "lunorash/server";

export default defineModule({
    description: "Chat threads end to end: start/stream/execute, tools, sharing, tags, pins, group chats, slides, local models and persistent streams.",
    tables: ["persistentChunks", "persistentStreams", "presentationSlides", "presentations", "threadPins", "threadTags", "toolApprovalRuns"],
});
