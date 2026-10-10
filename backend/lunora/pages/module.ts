import { defineModule } from "lunorash/server";

export default defineModule({
    description: "Collaborative pages: content, versions, comments, presence, access grants and public sharing.",
    tables: ["pageAccess", "pageComments", "pageFavorites", "pageInvites", "pagePresence", "pageVersions", "pages"],
});
