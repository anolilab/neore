import { defineModule } from "lunorash/server";

export default defineModule({
    description: "Sub-agent runs delegated from a chat: admission limits, the child thread run and the result post-back.",
    tables: ["subAgentRuns"],
});
