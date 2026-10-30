import { defineModule } from "lunorash/server";

export default defineModule({
    description: "Coding-agent sessions on paired devices (host-run threads), and the signed ingest of their turn output.",
    tables: ["acpSessions"],
});
