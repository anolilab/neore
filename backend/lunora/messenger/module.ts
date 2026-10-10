import { defineModule } from "lunorash/server";

export default defineModule({
    description: "Telegram, Slack, Discord and other messenger bots (BYOK): webhooks, pairing, replies and media.",
    tables: ["messengerConnections"],
});
