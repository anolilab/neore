import annotateNode from "./node";
import type { AnnotatedNode, Options, ReplacementFunction, Rule, RuleLookup } from "./types";

/**
 * The default `keepReplacement`. It ignores its content and outputs the
 * element's HTML, so the converter skips the children of a kept element when
 * this is the replacement in use. A custom `keepReplacement` still gets the
 * converted children.
 */
export function defaultKeepReplacement(_content: string, node: AnnotatedNode): string {
    if (node.isBlock) {
        return `\n\n${node.outerHTML}\n\n`;
    }

    return node.outerHTML;
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
    }

    remove(filter: Rule["filter"]): void {
        const rule: Rule = {
            filter,
            replacement: () => "",
        };

        this.skipChildrenRules.add(rule);
        this.removeList.unshift(rule);
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

        // Lowercased once for the node, not once per rule.
        const nodeName = node.nodeName.toLowerCase();

        const fromCustom = findRule(this.customRules, node, nodeName, this.options, this);

        if (fromCustom) {
            return fromCustom;
        }

        const fromKeep = findRule(this.keepList, node, nodeName, this.options, this);

        if (fromKeep) {
            return fromKeep;
        }

        const fromRemove = findRule(this.removeList, node, nodeName, this.options, this);

        if (fromRemove) {
            return fromRemove;
        }

        const fromBuiltIn = findRule(this.builtInRules, node, nodeName, this.options, this);

        return fromBuiltIn ?? this.defaultRule;
    }

    /**
     * True when a rule of any kind, built-in, added, keep or remove, matches the node. A rule that must
     * decide whether to treat a node as transparent asks this first.
     */
    hasRuleFor(node: Node): boolean {
        const annotated = annotateNode(node, this.options);
        const nodeName = annotated.nodeName.toLowerCase();

        return [this.customRules, this.builtInRules, this.keepList, this.removeList].some((list) => findRule(list, annotated, nodeName, this.options, this) !== undefined);
    }

    forEach(visit: (rule: Rule, index: number) => void): void {
        [...this.customRules, ...this.builtInRules].forEach((rule, index) => {
            visit(rule, index);
        });
    }
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

function findRule(rules: Rule[], node: AnnotatedNode, nodeName: string, options: Options, lookup: RuleLookup): Rule | undefined {
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
