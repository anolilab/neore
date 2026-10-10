import { defineModule } from "lunorash/server";

export default defineModule({
    description: "Saved prompt templates, their history, and the prompt optimizer actions.",
    tables: ["promptHistory", "prompts", "threadVariables", "userVariableDefaults"],
});
