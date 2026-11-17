import { defineModule } from "lunorash/server";

export default defineModule({
    description: "Feedback a user sends from the app: an idea, a problem or anything else, with optional images.",
    tables: ["feedback"],
});
