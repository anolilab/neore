import { defineModule } from "lunorash/server";

export default defineModule({
    description: "Visual workflows: the node graph editor, versions, presence, execution and the public gallery.",
    tables: ["workflowPresence", "workflowVersions"],
});
