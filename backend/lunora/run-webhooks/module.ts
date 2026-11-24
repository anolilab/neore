import { defineModule } from "lunorash/server";

export default defineModule({
    description: "The user's outbound run webhook: a signed POST to their URL, with a send-test check. Run events join it in a later part.",
    tables: ["runWebhooks"],
});
