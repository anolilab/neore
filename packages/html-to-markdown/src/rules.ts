import { isUnsafeDestination } from "./commonmark-rules";
import annotateNode from "./node";
import type { AnnotatedNode, Options, ReplacementFunction, Rule, RuleLookup } from "./types";
import { removeReplacement } from "./utilities";

/** The answers given to nodes during one conversion. */
interface Answers {
    /**
     * A rule's answer for a node. Kept for as long as this service lives, so a node never gets a second answer.
     * Each parse makes new nodes, so one document never sees another document's answers.
     */
    readonly decided: WeakMap<Node, Rule>;
    /** No-match answers. Dropped when a rule, keep or remove is added, because the new one may match them. */
    undecided: WeakSet<Node>;
}

function newAnswers(): Answers {
    return { decided: new WeakMap(), undecided: new WeakSet() };
}

/** The attributes that carry a link destination: `href`, and `xlink:href` on an SVG `<a>`. */
const LINK_ATTRIBUTES = ["href", "xlink:href"];

/**
 * The default `keepReplacement`. It ignores its content and outputs the
 * element's HTML, so the converter skips the children of a kept element when
 * this is the replacement in use. A custom `keepReplacement` still gets the
 * converted children.
 *
 * With `safeLinks`, an `<a>` inside the element whose destination is unsafe is
 * written without its link: its content stays and its destination goes. Kept
 * markup with only safe links is output unchanged.
 */
export function defaultKeepReplacement(_content: string, node: AnnotatedNode, options: Options): string {
    const html = options.safeLinks ? htmlWithoutUnsafeLinks(node) : node.outerHTML;

    if (node.isBlock) {
        return `\n\n${html}\n\n`;
    }

    return html;
}

/**
 * The element's HTML with every unsafe anchor unwrapped, so its text and its
 * inner markup stay. The element is returned as is when it has no unsafe anchor.
 */
function htmlWithoutUnsafeLinks(node: AnnotatedNode): string {
    const hasUnsafeLink = isUnsafeAnchor(node) || anchorsWithin(node).some((anchor) => isUnsafeAnchor(anchor));

    if (!hasUnsafeLink) {
        return node.outerHTML;
    }

    const copy = node.cloneNode(true) as Element;
    const isRootUnsafe = isUnsafeAnchor(copy);

    for (const anchor of anchorsWithin(copy)) {
        if (isUnsafeAnchor(anchor)) {
            unwrap(anchor);
        }
    }

    // A root anchor has no parent to unwrap into, so only its inner markup is output.
    // eslint-disable-next-line unicorn/prefer-dom-node-html-methods -- domino, the Node and Workers parser, has no getHTML, so innerHTML is the serialiser here.
    return isRootUnsafe ? copy.innerHTML : copy.outerHTML;
}

/** The `<a>` elements inside the element, in document order. Copied by index, since domino's NodeList is not iterable. */
function anchorsWithin(element: Element): Element[] {
    const found = element.querySelectorAll("a");

    return Array.from({ length: found.length }, (_unused, index) => found[index]).filter((anchor) => anchor !== undefined);
}

function isUnsafeAnchor(element: Element): boolean {
    if (element.localName !== "a") {
        return false;
    }

    return LINK_ATTRIBUTES.some((name) => {
        const href = element.getAttribute(name);

        return href !== null && isUnsafeDestination(href);
    });
}

function unwrap(element: Element): void {
    const parent = element.parentNode;

    if (!parent) {
        return;
    }

    while (element.firstChild) {
        parent.insertBefore(element.firstChild, element);
    }

    element.remove();
}

/**
 * Manages the rules used to convert HTML to Markdown. The first match wins, in
 * this order:
 *
 * 1. the blank rule, for a blank element (only whitespace, no meaningful content);
 * 2. rules added with `addRule`, newest first;
 * 3. keep filters, newest first (rendered as HTML);
 * 4. remove filters, newest first (dropped with their content);
 * 5. the built-in rules;
 * 6. the default rule.
 *
 * Keep and remove sit above the built-in rules, so `keep(['b'])` and
 * `remove(['i'])` also work for built-in tags (upstream #455). Upstream's
 * documentation says the built-in rules win, and this changes that on purpose.
 * The blank rule comes first, as upstream documents, because a blank element
 * has no content to keep or remove.
 */
export default class Rules implements RuleLookup {
    private readonly customRules: Rule[] = [];

    private readonly builtInRules: Rule[] = [];

    private readonly keepList: Rule[] = [];

    private readonly removeList: Rule[] = [];

    // The lists a node is searched in, in order: added rules, then keep, then remove, then the built-in rules.
    private readonly searchOrder: ReadonlyArray<ReadonlyArray<Rule>> = [this.customRules, this.keepList, this.removeList, this.builtInRules];

    private readonly answers = newAnswers();

    /** Rules whose replacement ignores the children, so converting them is wasted work. */
    private readonly skipChildrenRules = new WeakSet<Rule>();

    private readonly options: Options;

    private readonly blankRule: Rule;

    private readonly keepReplacement: ReplacementFunction;

    private readonly defaultRule: Rule;

    constructor(options: Options) {
        this.options = options;
        this.blankRule = { replacement: options.blankReplacement };
        this.keepReplacement = options.keepReplacement;
        this.defaultRule = { replacement: options.defaultReplacement };

        const ruleTable: Record<string, Rule> = options.rules ?? {};

        for (const rule of Object.values(ruleTable)) {
            this.builtInRules.push(rule);
        }
    }

    add(_key: string, rule: Rule): void {
        this.customRules.unshift(rule);
        this.answers.undecided = new WeakSet();
    }

    keep(filter: Rule["filter"]): void {
        const rule: Rule = {
            filter,
            replacement: this.keepReplacement,
        };

        if (this.keepReplacement === defaultKeepReplacement) {
            this.skipChildrenRules.add(rule);
        }

        this.keepList.unshift(rule);
        this.answers.undecided = new WeakSet();
    }

    remove(filter: Rule["filter"]): void {
        const rule: Rule = {
            filter,
            replacement: removeReplacement,
        };

        this.skipChildrenRules.add(rule);
        this.removeList.unshift(rule);
        this.answers.undecided = new WeakSet();
    }

    /**
     * True when the converter should not convert the element's children: a
     * removed element, or a kept one with the default `keepReplacement`, since
     * neither uses them. Converting them would only throw the output away, and
     * could still leave side effects such as reference-link definitions.
     */
    skipsChildren(rule: Rule): boolean {
        return this.skipChildrenRules.has(rule);
    }

    forNode(node: AnnotatedNode): Rule {
        if (node.isBlank) {
            return this.blankRule;
        }

        return decideRule(this.answers, this.searchOrder, node, this.options, this) ?? this.defaultRule;
    }

    /**
     * True when a rule of any kind, built-in, added, keep or remove, matches the node. A rule that must
     * decide whether to treat a node as transparent asks this first.
     */
    hasRuleFor(node: Node): boolean {
        return this.ruleFor(node) !== undefined;
    }

    ruleFor(node: Node): Rule | undefined {
        // Only an element has a rule. A filter written for elements must not be handed a text node.
        if (node.nodeType !== 1) {
            return undefined;
        }

        // A node already answered is not annotated again: annotating reads the node's whole text, and a parent is
        // asked about once per child, so annotating each time made a parent with many children quadratic.
        const known = this.answers.decided.get(node);

        if (known) {
            return known;
        }

        if (this.answers.undecided.has(node)) {
            return undefined;
        }

        return decideRule(this.answers, this.searchOrder, annotateNode(node, this.options), this.options, this);
    }

    forEach(visit: (rule: Rule, index: number) => void): void {
        [...this.customRules, ...this.builtInRules].forEach((rule, index) => {
            visit(rule, index);
        });
    }
}

/**
 * The first rule of any kind that matches the node, asked once per node. A filter can
 * be asked twice for one node (code-block detection, then traversal), and a second
 * answer that differs from the first would split the two. The first answer is kept.
 */
function decideRule(
    answers: Answers,
    searchOrder: ReadonlyArray<ReadonlyArray<Rule>>,
    node: AnnotatedNode,
    options: Options,
    lookup: RuleLookup,
): Rule | undefined {
    const known = answers.decided.get(node);

    if (known) {
        return known;
    }

    if (answers.undecided.has(node)) {
        return undefined;
    }

    // Lowercased once for the node, not once per rule.
    const nodeName = node.nodeName.toLowerCase();
    // A filter may add a rule during this search, which replaces the no-match set. A no-match answer then
    // belongs to the old rules, so it is not recorded in the new set.
    const undecidedBefore = answers.undecided;

    for (const list of searchOrder) {
        const rule = findRule(list, node, nodeName, options, lookup);

        if (rule) {
            answers.decided.set(node, rule);

            return rule;
        }
    }

    if (answers.undecided === undecidedBefore) {
        answers.undecided.add(node);
    }

    return undefined;
}

function isFilterMatch(rule: Rule, node: AnnotatedNode, nodeName: string, options: Options, lookup: RuleLookup): boolean {
    const { filter } = rule;

    if (typeof filter === "string") {
        return filter === nodeName;
    }

    if (Array.isArray(filter)) {
        return filter.includes(nodeName);
    }

    if (typeof filter === "function") {
        return filter.call(rule, node, options, lookup);
    }

    throw new TypeError("`filter` needs to be a string, array, or function");
}

function findRule(rules: ReadonlyArray<Rule>, node: AnnotatedNode, nodeName: string, options: Options, lookup: RuleLookup): Rule | undefined {
    // A filter may add rules to this same list. Bounding the search by the length
    // at the start keeps it to the rules that existed, as Array.find did.
    const { length } = rules;

    for (let index = 0; index < length; index += 1) {
        const rule = rules[index];

        if (rule && isFilterMatch(rule, node, nodeName, options, lookup)) {
            return rule;
        }
    }

    return undefined;
}
