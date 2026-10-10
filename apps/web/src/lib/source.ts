import { loader } from "fumadocs-core/source";
import { docs } from "fumadocs-mdx:collections/server";

const docsSource = loader({
    baseUrl: "/docs",
    source: docs.toFumadocsSource(),
});

export default docsSource;
