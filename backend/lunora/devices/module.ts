import { defineModule } from "lunorash/server";

export default defineModule({
    description: "Paired desktop devices and the signed tool calls the backend relays to them.",
    tables: ["deviceCalls", "devices"],
});
