import { defineModule } from "lunorash/server";

export default defineModule({
    description: "User memory: extraction after each reply, scored retrieval, and the nightly reflection.",
    tables: ["memories", "memoryDigests", "memoryReflectionState"],
});
