import { defineModule } from "lunorash/server";

export default defineModule({
    description: "The user's library of named system-prompt presets.",
    tables: ["systemPromptPresets"],
});
