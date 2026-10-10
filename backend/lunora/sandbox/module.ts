import { defineModule } from "lunorash/server";

export default defineModule({
    description: "Code-execution sandboxes: the warm pool, sessions, actions, PTY and workspace sync.",
    tables: ["sandboxActions", "sandboxSessions"],
});
