import { defineModule } from "lunorash/server";

export default defineModule({
    description: "Tasks and goals: rounds run by agents or coding agents, verdicts, and credit accounting.",
    tables: ["goals", "taskRuns", "tasks"],
});
