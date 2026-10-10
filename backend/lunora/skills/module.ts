import { defineModule } from "lunorash/server";

export default defineModule({
    description: "Skills: authoring, the marketplace, ratings, invocation and the JIT tool loader.",
    tables: ["skillFiles", "skillHistory", "skillInvocations", "skillRatings", "skillStats", "skills", "userSkills"],
});
