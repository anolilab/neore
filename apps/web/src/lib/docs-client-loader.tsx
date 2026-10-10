import browserCollections from "fumadocs-mdx:collections/browser";
import { DocsBody, DocsDescription, DocsPage, DocsTitle } from "fumadocs-ui/page";

/**
 * The docs routes' MDX loader. It lives in its own module so the routes can
 * reach it from their loaders through a dynamic import: referenced directly
 * from both the loader and the component, it became a shared route module,
 * which is not code-split, and put `fumadocs-ui/page` on every page's entry.
 */
const docsClientLoader = browserCollections.docs.createClientLoader({
    component({ toc, frontmatter, default: MDX }) {
        return (
            <DocsPage toc={toc}>
                <DocsTitle>{frontmatter.title as string}</DocsTitle>
                {frontmatter.description && <DocsDescription>{frontmatter.description as string}</DocsDescription>}
                <DocsBody>
                    <MDX />
                </DocsBody>
            </DocsPage>
        );
    },
});

export default docsClientLoader;
