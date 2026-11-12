import type { AnnotatedNode, Options, Rule } from "./types";
import { escapeMarkdown, repeat, trimNewlines } from "./utilities";

const LINE_START = /^/gm;
const NEWLINE = /\n/g;
const TRAILING_NEWLINE = /\n$/;
const LINE_BREAKS = /\r?\n|\r/g;
const BACKTICKS = /`+/g;
const BACKTICK_EDGE = /^`|`$/;
const LANGUAGE_CLASS = /language-(\S+)/;
const LINE_BREAK_RUN = /\n\s*/g;
const DOUBLE_QUOTE = /"/g;

/**
 * Reference-style links collect their definitions here and append them after
 * the document (see `append`). The state lives on this rule object, as in
 * upstream; the rule is shared by every converter in the process.
 */
function isReferencedLink(node: AnnotatedNode, options: Options): boolean {
    return options.linkStyle === "referenced" && node.nodeName === "A" && Boolean(node.getAttribute("href"));
}

class ReferenceLinkRule implements Rule {
    references: string[] = [];

    filter = isReferencedLink;

    replacement(content: string, node: AnnotatedNode, options: Options): string {
        const href = escapeLinkDestination(node.getAttribute("href") ?? "");
        let title = cleanAttribute(node.getAttribute("title"));

        if (title) {
            title = ` "${escapeLinkTitle(title)}"`;
        }

        let replacement: string;
        let reference: string;

        switch (options.linkReferenceStyle) {
            case "collapsed": {
                replacement = `[${content}][]`;
                reference = `[${content}]: ${href}${title}`;
                break;
            }
            case "shortcut": {
                replacement = `[${content}]`;
                reference = `[${content}]: ${href}${title}`;
                break;
            }
            default: {
                const id = this.references.length + 1;

                replacement = `[${content}][${id}]`;
                reference = `[${id}]: ${href}${title}`;
            }
        }

        this.references.push(reference);

        return replacement;
    }

    append(): string {
        let references = "";

        if (this.references.length > 0) {
            references = `\n\n${this.references.join("\n")}\n\n`;
            this.references = []; // Reset references
        }

        return references;
    }
}

const rules: Record<string, Rule> = {
    blockquote: {
        filter: "blockquote",

        replacement(content) {
            const quoted = trimNewlines(content).replaceAll(LINE_START, "> ");

            return `\n\n${quoted}\n\n`;
        },
    },

    code: {
        filter(node) {
            const hasSiblings = Boolean(node.previousSibling || node.nextSibling);
            const isCodeBlock = node.parentNode?.nodeName === "PRE" && !hasSiblings;

            return node.nodeName === "CODE" && !isCodeBlock;
        },

        replacement(content) {
            if (!content) {
                return "";
            }

            const flat = content.replaceAll(LINE_BREAKS, " ");

            const extraSpace = BACKTICK_EDGE.test(flat) || isSpacePadded(flat) ? " " : "";
            let delimiter = "`";
            const matches: string[] = flat.match(BACKTICKS) ?? [];

            while (matches.includes(delimiter)) {
                delimiter += "`";
            }

            return delimiter + extraSpace + flat + extraSpace + delimiter;
        },
    },

    emphasis: {
        filter: ["em", "i"],

        replacement(content, _node, options) {
            if (!content.trim()) {
                return "";
            }

            return options.emDelimiter + content + options.emDelimiter;
        },
    },

    fencedCodeBlock: {
        filter(node, options) {
            return options.codeBlockStyle === "fenced" && node.nodeName === "PRE" && node.firstChild?.nodeName === "CODE";
        },

        replacement(_content, node, options) {
            const codeElement = node.firstChild as Element;
            const className = codeElement.getAttribute("class") ?? "";
            const language = (LANGUAGE_CLASS.exec(className) ?? [null, ""])[1];
            const code = codeElement.textContent ?? "";

            const fenceChar = options.fence.charAt(0);
            let fenceSize = 3;
            const fenceInCodeRegex = new RegExp(`^${fenceChar}{3,}`, "gm");

            let match: RegExpExecArray | null = fenceInCodeRegex.exec(code);

            while (match) {
                if (match[0].length >= fenceSize) {
                    fenceSize = match[0].length + 1;
                }

                match = fenceInCodeRegex.exec(code);
            }

            const fence = repeat(fenceChar, fenceSize);

            return `\n\n${fence}${language}\n${code.replace(TRAILING_NEWLINE, "")}\n${fence}\n\n`;
        },
    },

    heading: {
        filter: ["h1", "h2", "h3", "h4", "h5", "h6"],

        replacement(content, node, options) {
            const hLevel = Number(node.nodeName.charAt(1));

            if (options.headingStyle === "setext" && hLevel < 3) {
                const underline = repeat(hLevel === 1 ? "=" : "-", content.length);

                return `\n\n${content}\n${underline}\n\n`;
            }

            return `\n\n${repeat("#", hLevel)} ${content}\n\n`;
        },
    },

    horizontalRule: {
        filter: "hr",

        replacement(_content, _node, options) {
            return `\n\n${options.hr}\n\n`;
        },
    },

    image: {
        filter: "img",

        replacement(_content, node) {
            const alt = escapeMarkdown(cleanAttribute(node.getAttribute("alt")));
            const src = escapeLinkDestination(node.getAttribute("src") ?? "");
            const title = cleanAttribute(node.getAttribute("title"));
            const titlePart = title ? ` "${escapeLinkTitle(title)}"` : "";

            return src ? `![${alt}](${src}${titlePart})` : "";
        },
    },

    indentedCodeBlock: {
        filter(node, options) {
            return options.codeBlockStyle === "indented" && node.nodeName === "PRE" && node.firstChild?.nodeName === "CODE";
        },

        replacement(_content, node) {
            const code = (node.firstChild as Element).textContent ?? "";

            return `\n\n    ${code.replaceAll(NEWLINE, "\n    ")}\n\n`;
        },
    },

    inlineLink: {
        filter(node, options) {
            return options.linkStyle === "inlined" && node.nodeName === "A" && Boolean(node.getAttribute("href"));
        },

        replacement(content, node) {
            const href = escapeLinkDestination(node.getAttribute("href") ?? "");
            const title = escapeLinkTitle(cleanAttribute(node.getAttribute("title")));
            const titlePart = title ? ` "${title}"` : "";

            return `[${content}](${href}${titlePart})`;
        },
    },

    lineBreak: {
        filter: "br",

        replacement(_content, _node, options) {
            return `${options.br}\n`;
        },
    },

    list: {
        filter: ["ul", "ol"],

        replacement(content, node) {
            const parent = node.parentNode as Element | null;

            if (parent?.nodeName === "LI" && parent.lastElementChild === node) {
                return `\n${content}`;
            }

            return `\n\n${content}\n\n`;
        },
    },

    listItem: {
        filter: "li",

        replacement(content, node, options) {
            let prefix = `${options.bulletListMarker}   `;
            const parent = node.parentNode as Element | null;

            if (parent?.nodeName === "OL") {
                const start = parent.getAttribute("start");
                const index = Array.prototype.indexOf.call(parent.children, node);

                prefix = `${start ? Number(start) + index : index + 1}.  `;
            }

            const isParagraph = TRAILING_NEWLINE.test(content);
            let body = trimNewlines(content) + (isParagraph ? "\n" : "");

            // indent: every line break gets the prefix's width in spaces
            body = body.split("\n").join(`\n${" ".repeat(prefix.length)}`);

            return prefix + body + (node.nextSibling ? "\n" : "");
        },
    },

    paragraph: {
        filter: "p",

        replacement(content) {
            return `\n\n${content}\n\n`;
        },
    },

    referenceLink: new ReferenceLinkRule(),

    strong: {
        filter: ["strong", "b"],

        replacement(content, _node, options) {
            if (!content.trim()) {
                return "";
            }

            return options.strongDelimiter + content + options.strongDelimiter;
        },
    },
};

const LINE_TERMINATORS = new Set(["\n", "\r", "\u{2028}", "\u{2029}"]);

/**
 * Linear equivalent of the regular expression `/^ .*?[^ ].* $/`, which backtracks
 * polynomially on long inputs. It matches when the text starts and ends with a
 * space and has a non-space character between them, with no line terminator
 * between the first space and that character, or between it and the last space
 * (`.` does not match line terminators).
 */
function isSpacePadded(text: string): boolean {
    const last = text.length - 1;

    if (last < 2 || text[0] !== " " || text[last] !== " ") {
        return false;
    }

    let terminators = 0;
    let hasNonSpace = false;

    for (let index = 1; index < last; index += 1) {
        const char = text[index] ?? "";

        if (LINE_TERMINATORS.has(char)) {
            terminators += 1;
        }

        if (char !== " ") {
            hasNonSpace = true;
        }
    }

    // With no terminator, any non-space will do. With exactly one, that
    // character itself is the non-space that the pattern needs.
    return terminators === 0 ? hasNonSpace : terminators === 1;
}

function cleanAttribute(attribute: string | null): string {
    // `\n\s*` collapses each run of line breaks (and the blanks after them) to one
    // line break. It matches upstream's `(\n+\s*)+` without nested quantifiers.
    return attribute ? attribute.replaceAll(LINE_BREAK_RUN, "\n") : "";
}

function escapeLinkDestination(destination: string): string {
    const escaped = destination
        .replaceAll("<", String.raw`\<`)
        .replaceAll(">", String.raw`\>`)
        .replaceAll("(", String.raw`\(`)
        .replaceAll(")", String.raw`\)`);

    return escaped.includes(" ") ? `<${escaped}>` : escaped;
}

function escapeLinkTitle(title: string): string {
    return title.replaceAll(DOUBLE_QUOTE, String.raw`\"`);
}

export default rules;
