import { defineConfig, defineDocs } from "fumadocs-mdx/config";
import remarkDirective from "remark-directive";

export const docs = defineDocs({
    dir: "../../docs",
    docs: {
        // Only user-facing product documentation is published, and the extension
        // is what marks it: `.mdx` = product docs (all carry fumadocs
        // title/description frontmatter), `.md` = internal engineering notes
        // (`docs/analyze/`, `docs/plans/`) which have no frontmatter and must not
        // ship to the public docs site. Internal engineering notes that are not
        // product docs live at the repo root instead (`AGENTS.md`).
        //
        // Negation patterns ("!analyze/**") do NOT work here: fumadocs-mdx's Vite
        // codegen maps every pattern through normalizeViteGlobPath, which prepends
        // "./" and turns "!analyze/**" into "./!analyze/**", silently disabling the
        // negation. Keep this an allow-list.
        files: ["**/*.mdx"],
    },
});

export default defineConfig({
    mdxOptions: {
        remarkPlugins: [remarkDirective],
    },
});
