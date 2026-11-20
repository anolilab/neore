import { defineModule } from "lunorash/server";

export default defineModule({
    description: "The user's file vault: uploaded and generated files, folders, signed display URLs and saved site logins.",
    tables: ["files", "folders", "savedSiteLogins"],
});
