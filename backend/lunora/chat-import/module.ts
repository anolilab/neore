import { defineModule } from "lunorash/server";

export default defineModule({
    description: "Imports ChatGPT, Gemini and Claude exports through a batched workflow.",
    tables: ["chatImportJobs"],
});
