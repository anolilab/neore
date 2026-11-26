import { defineModule } from "lunorash/server";

export default defineModule({
    description: "Tasks and goals: rounds run by agents or coding agents, verdicts, credit accounting, and suggested tasks to accept or dismiss.",
    tables: ["goals", "taskRuns", "taskSuggestions", "tasks"],
});
