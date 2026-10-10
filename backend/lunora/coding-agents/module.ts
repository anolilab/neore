import { defineModule } from "lunorash/server";

export default defineModule({
    description: "Claude Code / Codex runs in an E2B sandbox on the user's own key, and the pull requests built from their diffs.",
    tables: ["codingAgentRuns"],
});
