/**
 * CodeMirror language extension loader.
 * Lazy-imports language packs to minimize bundle size.
 */
import type { Extension } from "@uiw/react-codemirror";

const languageLoaders: Record<string, () => Promise<Extension>> = {
    c: () => import("@codemirror/lang-cpp").then((m) => m.cpp()),
    cpp: () => import("@codemirror/lang-cpp").then((m) => m.cpp()),
    css: () => import("@codemirror/lang-css").then((m) => m.css()),
    html: () => import("@codemirror/lang-html").then((m) => m.html()),
    java: () => import("@codemirror/lang-java").then((m) => m.java()),
    javascript: () => import("@codemirror/lang-javascript").then((m) => m.javascript({ jsx: true, typescript: false })),
    json: () => import("@codemirror/lang-json").then((m) => m.json()),
    jsx: () => import("@codemirror/lang-javascript").then((m) => m.javascript({ jsx: true, typescript: false })),
    markdown: () => import("@codemirror/lang-markdown").then((m) => m.markdown()),
    python: () => import("@codemirror/lang-python").then((m) => m.python()),
    rust: () => import("@codemirror/lang-rust").then((m) => m.rust()),
    sql: () => import("@codemirror/lang-sql").then((m) => m.sql()),
    tsx: () => import("@codemirror/lang-javascript").then((m) => m.javascript({ jsx: true, typescript: true })),
    typescript: () => import("@codemirror/lang-javascript").then((m) => m.javascript({ jsx: true, typescript: true })),
    xml: () => import("@codemirror/lang-xml").then((m) => m.xml()),
    yaml: () => import("@codemirror/lang-yaml").then((m) => m.yaml()),
    yml: () => import("@codemirror/lang-yaml").then((m) => m.yaml()),
};

/**
 * Load a CodeMirror language extension by name.
 * Returns null for unsupported languages (CodeMirror will still work without syntax highlighting).
 */
export default async function loadLanguageExtension(lang: string): Promise<Extension | null> {
    const loader = languageLoaders[lang.toLowerCase()];

    if (!loader) {
        return null;
    }

    try {
        return await loader();
    } catch {
        return null;
    }
}
