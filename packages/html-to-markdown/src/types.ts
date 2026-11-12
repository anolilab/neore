/**
 * An element that the converter has annotated while walking the tree. Rules
 * only ever receive elements; text nodes are annotated too but never reach a rule.
 * `Node` (see node.ts) adds these before any rule runs.
 */
export interface AnnotatedNode extends Element {
    flankingWhitespace: { leading: string; trailing: string };
    isBlank: boolean;
    isBlock: boolean;
    isCode: boolean;
}

export type ReplacementFunction = (content: string, node: AnnotatedNode, options: Options) => string;

export interface Options {
    blankReplacement: ReplacementFunction;
    br: string;
    bulletListMarker: string;
    codeBlockStyle: string;
    defaultReplacement: ReplacementFunction;
    emDelimiter: string;
    fence: string;
    headingStyle: string;
    hr: string;
    keepReplacement: ReplacementFunction;
    linkReferenceStyle: string;
    linkStyle: string;
    preformattedCode: boolean;
    rules?: Record<string, Rule>;

    /**
     * When true, a link whose destination has a scheme other than http, https, mailto or tel renders as its text only.
     * Relative destinations are kept, unless a `&` comes before their first `/`, `?` or `#`. The destination is checked
     * after CommonMark's escapes are undone, and `\` and `&` are escaped in the output so the rendered href is the checked
     * text. Off by default, as upstream.
     *
     * Images are out of scope: an `<img src>` is rendered unchanged, even a `javascript:` one, because an image does not
     * run script.
     */
    safeLinks: boolean;
    strongDelimiter: string;
}

export type FilterFunction = (this: Rule, node: AnnotatedNode, options: Options) => boolean;

export interface Rule {
    append?: (options: Options) => string;
    filter?: string | string[] | FilterFunction;
    references?: string[];
    replacement: (this: Rule, content: string, node: AnnotatedNode, options: Options) => string;
}
