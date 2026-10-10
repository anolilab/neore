export interface CodeDetectionResult {
    isCode: boolean;
    language: string; // empty string = unknown
}

const LANGUAGE_EXTENSIONS: Record<string, string> = {
    bash: "sh",
    c: "c",
    cpp: "cpp",
    csharp: "cs",
    css: "css",
    dockerfile: "dockerfile",
    go: "go",
    html: "html",
    java: "java",
    javascript: "js",
    json: "json",
    kotlin: "kt",
    php: "php",
    python: "py",
    ruby: "rb",
    rust: "rs",
    scala: "scala",
    scss: "scss",
    sql: "sql",
    swift: "swift",
    typescript: "ts",
    xml: "xml",
    yaml: "yaml",
};

// Compiled once at module load — never recreated per call
const CODE_SIGNALS: { pattern: RegExp; weight: number }[] = [
    // Very strong signals (weight 3)
    { pattern: /^#!\//, weight: 3 },
    { pattern: /#include\s*[<"]/, weight: 3 },
    { pattern: /\bpublic\s+(class|interface|enum|static)\b/, weight: 3 },
    { pattern: /\bfn\s+\w+\s*\(/, weight: 3 },
    { pattern: /<\?php\b/, weight: 3 },
    { pattern: /\$\w+\s*=/, weight: 3 },
    { pattern: /^[ \t]*FROM\s+\w/m, weight: 3 },
    { pattern: /SELECT\s.+?\sFROM\b/is, weight: 3 },

    // Strong signals (weight 2)
    { pattern: /\b(function|class|def|func)\s+\w+/, weight: 2 },
    { pattern: /\b(interface|enum|struct|impl)\s+\w+/, weight: 2 },
    { pattern: /[{};][ \t]*$|^[ \t]*[{}]/m, weight: 2 },
    { pattern: /\b(try|catch|finally|throw)\b/, weight: 2 },
    { pattern: /\b(import|export|require|from)\s+['"\w{]/, weight: 2 },
    { pattern: /\b(const|let|var)\s+\w+\s*=/, weight: 2 },
    { pattern: /=>/, weight: 2 },
    { pattern: /\/\/[^\n]+|\/\*[\s\S]*?\*\//, weight: 2 },
    { pattern: /^[ \t]*#\s+\w/m, weight: 2 },
    { pattern: /:=/, weight: 2 },
    { pattern: /->/, weight: 2 },
    { pattern: /::/, weight: 2 },

    // Medium signals (weight 1)
    { pattern: /\b(return|yield|await|async)\b/, weight: 1 },
    { pattern: /\b(if|else|elif|for|while|switch|case|break|continue)\s*[({:]/, weight: 1 },
    { pattern: /===|!==|<=|>=/, weight: 1 },
    { pattern: /\bnull\b|\bundefined\b|\bNone\b|\bnil\b/, weight: 1 },
    { pattern: /\b(true|false|True|False)\b/, weight: 1 },
    { pattern: /\bpublic\b|\bprivate\b|\bprotected\b/, weight: 1 },
    { pattern: /\bstatic\b|\bfinal\b|\babstract\b/, weight: 1 },
    { pattern: /\b(string|int|float|bool|void|char)\b/, weight: 1 },
    { pattern: /@\w+\s*[(\n]/, weight: 1 },
    { pattern: /\w\s*\([^)]*\)\s*\{/, weight: 1 },
];

const SHEBANG_PREFIX_RE = /^#!\//;
const SHEBANG_PYTHON_RE = /python/;
const SHEBANG_NODE_RE = /node|javascript/;

const JSON_BODY_RE = /^\s*\{[\s\S]*\}\s*$/;
const JSON_KEY_RE = /"[\w-]+":\s/;
const YAML_DOC_START_RE = /^\s*-{3}/;
const YAML_KEY_RE = /^\w[\w-]*:\s+\S/m;
const XML_DECLARATION_RE = /<\?xml\b/;
const XML_OPEN_TAG_RE = /<[A-Z][\w-]*[\s/>]/;
const XML_CLOSE_TAG_RE = /<\/[A-Z]/;
const HTML_OPEN_TAG_RE = /<[a-z][a-z0-9]*[\s/>]/;
const HTML_CLOSE_TAG_RE = /<\/[a-z]/;
const SQL_SELECT_RE = /SELECT\s.+?\sFROM\b/is;
const DOCKERFILE_FROM_RE = /^FROM\s+\w/m;
const DOCKERFILE_INSTRUCTION_RE = /^(?:RUN|COPY|CMD|EXPOSE|ENV|ENTRYPOINT)\b/m;
const BASH_SHEBANG_RE = /^#!\/bin\/(?:ba)?sh/;
const BASH_FI_RE = /\bfi\b/;
const BASH_THEN_RE = /\bthen\b/;
const C_INCLUDE_RE = /#include\s*[<"]/;
const CPP_MARKERS_RE = /\bstd::\b|\bcout\b/;
const RUST_MARKERS_RE = /fn\s+\w+|let\s+mut\b|impl\s+\w|\buse\s+std::/;
const KOTLIN_MARKERS_RE = /\bfun\s+\w+\s*\(|\bval\s+\w+\s*=|\bdata\s+class\b/;
const SCALA_MARKERS_RE = /\bobject\s+\w+\s+extends\b|\bcase\s+class\b|\bscala\b/;
const JAVA_MARKERS_RE = /\bpublic\s+(?:class|interface|enum)\b|\bSystem\.out\.print/;
const CSHARP_MARKERS_RE = /\bnamespace\s+\w+|\busing\s+System\b|\basync\s+Task\b/;
const GO_MARKERS_RE = /\bfunc\s+\w|\bpackage\s+\w|\b:=\b/;
const SWIFT_MARKERS_RE = /\bguard\s+let\b|\b@IBOutlet\b|\bvar\s+\w+:\s+\w/;
const PHP_MARKERS_RE = /<\?php\b|\$\w+->|\becho\s+/;
const PYTHON_MARKERS_RE = /\bdef\s+\w+|\bself\.\w+|\belif\b|\bprint\s*\(/;
const SCSS_RULE_RE = /^[ \t]*\.\w[\w-]*[ \t]*\{/m;
const SCSS_AT_RULE_RE = /@media\b|@mixin\b|@include\b/;
const CSS_DECLARATION_RE = /^[ \t]*[\w-]+[ \t]*:[ \t]*[\w#"'(]/m;
const CSS_BRACE_RE = /\{/;
const TYPESCRIPT_MARKERS_RE = /@\w+\s*[(\n]|\binterface\b|\btype\s+\w+\s*=|\bReadonly</;
const RUBY_END_RE = /\bend\b/;
const RUBY_MARKERS_RE = /\bdo\b|\bputs\b|\battr_/;
const JAVASCRIPT_MARKERS_RE = /\bconst\b|\blet\b|\bvar\b|\b=>\b|\bfunction\b/;
const COMMENT_LINE_RE = /^\s*#/;

const INDENT_TAB_RE = /^\t/;
const INDENT_SPACES_RE = /^ {2,}/;
const STRUCTURED_LINE_END_RE = /[;{]$/;

const shebanglanguage = (line: string): string => {
    if (SHEBANG_PYTHON_RE.test(line)) {
        return "python";
    }

    if (SHEBANG_NODE_RE.test(line)) {
        return "javascript";
    }

    return "bash";
};

const detectLanguage = (text: string): string => {
    if (JSON_BODY_RE.test(text) && JSON_KEY_RE.test(text)) {
        return "json";
    }

    if (YAML_DOC_START_RE.test(text) || YAML_KEY_RE.test(text)) {
        return "yaml";
    }

    if (XML_DECLARATION_RE.test(text) || (XML_OPEN_TAG_RE.test(text) && XML_CLOSE_TAG_RE.test(text))) {
        return "xml";
    }

    if (HTML_OPEN_TAG_RE.test(text) && HTML_CLOSE_TAG_RE.test(text)) {
        return "html";
    }

    if (SQL_SELECT_RE.test(text)) {
        return "sql";
    }

    if (DOCKERFILE_FROM_RE.test(text) && DOCKERFILE_INSTRUCTION_RE.test(text)) {
        return "dockerfile";
    }

    if (BASH_SHEBANG_RE.test(text) || (BASH_FI_RE.test(text) && BASH_THEN_RE.test(text))) {
        return "bash";
    }

    if (C_INCLUDE_RE.test(text) && CPP_MARKERS_RE.test(text)) {
        return "cpp";
    }

    if (C_INCLUDE_RE.test(text)) {
        return "c";
    }

    if (RUST_MARKERS_RE.test(text)) {
        return "rust";
    }

    if (KOTLIN_MARKERS_RE.test(text)) {
        return "kotlin";
    }

    if (SCALA_MARKERS_RE.test(text)) {
        return "scala";
    }

    if (JAVA_MARKERS_RE.test(text)) {
        return "java";
    }

    if (CSHARP_MARKERS_RE.test(text)) {
        return "csharp";
    }

    if (GO_MARKERS_RE.test(text)) {
        return "go";
    }

    if (SWIFT_MARKERS_RE.test(text)) {
        return "swift";
    }

    if (PHP_MARKERS_RE.test(text)) {
        return "php";
    }

    if (PYTHON_MARKERS_RE.test(text)) {
        return "python";
    }

    if (SCSS_RULE_RE.test(text) || SCSS_AT_RULE_RE.test(text)) {
        return "scss";
    }

    if (CSS_DECLARATION_RE.test(text) && !CSS_BRACE_RE.test(text)) {
        return "css";
    }

    if (TYPESCRIPT_MARKERS_RE.test(text)) {
        return "typescript";
    }

    if (RUBY_END_RE.test(text) && RUBY_MARKERS_RE.test(text)) {
        return "ruby";
    }

    if (JAVASCRIPT_MARKERS_RE.test(text)) {
        return "javascript";
    }

    if (COMMENT_LINE_RE.test(text)) {
        return "bash";
    }

    return "";
};

export const languageToExtension = (language: string): string => LANGUAGE_EXTENSIONS[language] ?? "txt";

export const detectCode = (text: string): CodeDetectionResult => {
    const lines = text.split("\n");
    const nonEmptyLines = lines.filter((l) => l.trim().length > 0);

    if (nonEmptyLines.length < 2 || text.trimStart().startsWith("```")) {
        return { isCode: false, language: "" };
    }

    if (SHEBANG_PREFIX_RE.test(lines[0]!)) {
        return { isCode: true, language: shebanglanguage(lines[0]!) };
    }

    let score = 0;

    const indentedCount = nonEmptyLines.reduce((n, l) => n + (INDENT_TAB_RE.test(l) || INDENT_SPACES_RE.test(l) ? 1 : 0), 0);

    if (indentedCount >= Math.max(2, nonEmptyLines.length * 0.3)) {
        score += 2;
    }

    const structuredCount = nonEmptyLines.reduce((n, l) => n + (STRUCTURED_LINE_END_RE.test(l.trim()) ? 1 : 0), 0);

    if (structuredCount >= Math.max(2, nonEmptyLines.length * 0.2)) {
        score += 2;
    }

    for (const { pattern, weight } of CODE_SIGNALS) {
        if (pattern.test(text)) {
            score += weight;
        }
    }

    if (score < 3) {
        return { isCode: false, language: "" };
    }

    return { isCode: true, language: detectLanguage(text) };
};
