import { defineModule } from "lunorash/server";

export default defineModule({
    description: "The user's file vault: uploaded and generated files, folders and signed display URLs.",
    tables: ["files", "folders"],
});
