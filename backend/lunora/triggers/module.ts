import { defineModule } from "lunorash/server";

export default defineModule({
    description: "Schedule and webhook triggers that run a headless agent into a new thread.",
    tables: ["triggerExecutions", "triggers"],
});
