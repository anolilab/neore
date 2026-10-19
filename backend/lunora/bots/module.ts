import { defineModule } from "lunorash/server";

export default defineModule({
    description: "Persistent bots: a named persona with its own routines, memory and computer, owned by one user.",
    tables: ["bots"],
});
