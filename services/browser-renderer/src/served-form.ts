/**
 * The login forms of a page as the site sent it, read from the HTML of the page's own load outside the browser, where no
 * script of the page reaches. `checkForm` in `login.ts` reads the same values from the live page; the two must agree
 * exactly before anything is typed.
 */
import type { DefaultTreeAdapterMap, DefaultTreeAdapterTypes, TreeAdapter } from "parse5";
import { defaultTreeAdapter, Parser, Tokenizer } from "parse5";

type Element = DefaultTreeAdapterTypes.Element;
type ParentNode = DefaultTreeAdapterTypes.ParentNode;

const HTML_NAMESPACE = "http://www.w3.org/1999/xhtml";

/** The most attributes a served tag is read with: the parser looks each new one up among those before it. */
export const MAX_TAG_ATTRIBUTES = 256;

/**
 * The most work the parser does for a served page, about 0.2 s of it: each tag costs the open elements and open
 * formatting elements it may walk (more for each attribute a formatting element compares), each element made and each
 * attribute given to one. Nothing interrupts the parse, and its work grows with the square of the nesting.
 */
export const MAX_PARSE_WORK = 20_000_000;

/** Thrown inside the parser when a page is past a limit. */
const TOO_LARGE = new Error("The served page is too large to read");

/**
 * The parser's tokenizer: tells `onTag` of each tag before the parser takes it, and refuses a tag of more than
 * `MAX_TAG_ATTRIBUTES` attributes, repeats of one name included, before it looks the next one up.
 */
class BoundedTokenizer extends Tokenizer {
    private readonly onTag: (attributes: number) => void;

    /** The attribute names of the current tag looked up so far, a repeated one included (which the parser drops). */
    private attributeNames = 0;

    public constructor(
        options: ConstructorParameters<typeof Tokenizer>[0],
        handler: ConstructorParameters<typeof Tokenizer>[1],
        onTag: (attributes: number) => void,
    ) {
        super(options, handler);
        this.onTag = onTag;
    }

    protected override _createStartTagToken(): void {
        this.attributeNames = 0;
        super._createStartTagToken();
    }

    protected override _createEndTagToken(): void {
        this.attributeNames = 0;
        super._createEndTagToken();
    }

    protected override _leaveAttrName(): void {
        // Each name is looked up among the tag's own before a repeat is dropped: repeats count toward the limit too.
        if (this.attributeNames >= MAX_TAG_ATTRIBUTES) {
            throw TOO_LARGE;
        }

        this.attributeNames += 1;
        super._leaveAttrName();
    }

    protected override emitCurrentTagToken(): void {
        const token = this.currentToken;

        this.onTag(token && "attrs" in token ? token.attrs.length : 0);
        super.emitCurrentTagToken();
    }
}

/** `html` parsed within `MAX_PARSE_WORK`, or `null` when it takes more. */
const parseBounded = (html: string): DefaultTreeAdapterTypes.Document | null => {
    let work = 0;
    const spend = (amount: number): void => {
        work += amount;

        if (work > MAX_PARSE_WORK) {
            throw TOO_LARGE;
        }
    };
    // Set once the parser is: text and tags cost the open elements and open formatting elements they may walk.
    let walk = (): number => 1;
    const treeAdapter: TreeAdapter<DefaultTreeAdapterMap> = {
        ...defaultTreeAdapter,
        adoptAttributes: (recipient, attributes) => {
            // A set of the recipient's attributes is built each time: dearer than a step of a walk.
            spend(8 * (recipient.attrs.length + attributes.length));
            defaultTreeAdapter.adoptAttributes(recipient, attributes);
        },
        createElement: (tagName, namespaceURI, attributes) => {
            spend(1 + attributes.length);

            return defaultTreeAdapter.createElement(tagName, namespaceURI, attributes);
        },
        // Text first reopens the formatting elements not open, looking each up among the open elements.
        insertText: (parentNode, text) => {
            spend(walk());
            defaultTreeAdapter.insertText(parentNode, text);
        },
        insertTextBefore: (parentNode, text, referenceNode) => {
            spend(walk());
            defaultTreeAdapter.insertTextBefore(parentNode, text, referenceNode);
        },
    };

    // `Parser.parse`, with the bounded tokenizer in place of its own before it reads anything.
    const parser = new Parser<DefaultTreeAdapterMap>({ treeAdapter });

    walk = () => parser.openElements.stackTop + 1 + parser.activeFormattingElements.entries.length;
    parser.tokenizer = new BoundedTokenizer(parser.options, parser, (attributes) => {
        // A start or end tag can walk every open element, and a formatting one every open formatting element.
        spend(walk() + parser.activeFormattingElements.entries.length * attributes);
    });

    try {
        parser.tokenizer.write(html, true);
    } catch (error) {
        if (error === TOO_LARGE) {
            return null;
        }

        throw error;
    }

    return parser.document;
};

/** Where a form sends a password field, as both the live page and the served HTML spell it. */
export interface FormTarget {
    /**
     * The action address without its fragment: the submitter's `formaction` first, else the form's `action`, resolved
     * against the document's base; the document's own address when that is empty.
     */
    action: string;
    /** The form's `accept-charset`, as written. */
    charset: string;
    /** `application/x-www-form-urlencoded`, `multipart/form-data` or `text/plain`. */
    enctype: string;
    /** `post` or another method, lowercased; a form without one is sent by POST. */
    method: string;
    /** The password field's name. */
    name: string;
    /** The window it is sent in, lowercased: the submitter's `formtarget`, the form's `target` or a `<base target>`. */
    target: string;
}

/** A password field whose form's submit buttons send it to different places: no page with one is filled. */
export const AMBIGUOUS = "ambiguous";

const ENCTYPES = new Set(["application/x-www-form-urlencoded", "multipart/form-data", "text/plain"]);

/** An `enctype` or `formenctype` value as the DOM reads it: an unknown one is URL-encoded. */
export const enctypeOf = (value: string | null): string => {
    const lowered = value?.toLowerCase() ?? "";

    return ENCTYPES.has(lowered) ? lowered : "application/x-www-form-urlencoded";
};

const attribute = (element: Element, name: string): string | null => element.attrs.find((pair) => pair.name === name && !pair.namespace)?.value ?? null;

const isHtml = (element: Element, tag: string): boolean => element.tagName === tag && element.namespaceURI === HTML_NAMESPACE;

/** An element in document order, with what its ancestors make of it. */
interface Placed {
    element: Element;
    /** The nearest form around it. */
    form: Element | null;
    /** In a disabled fieldset, and not in that fieldset's first legend. */
    isFenced: boolean;
}

/**
 * The elements of `root` in document order. A depth-first walk, so an element's descendants come right after it; each
 * carries only what its ancestors decide, never their list, which would grow with each level of nesting.
 */
const inOrder = (root: ParentNode): Placed[] => {
    const found: Placed[] = [];
    const stack: Placed[] = [];
    const push = (node: ParentNode, { form, isFenced }: Omit<Placed, "element">): void => {
        const children = ("childNodes" in node ? node.childNodes : []).filter((child): child is Element => "tagName" in child);
        const isFence = "tagName" in node && isHtml(node, "fieldset") && attribute(node, "disabled") !== null;
        const legend = isFence ? children.find((child) => isHtml(child, "legend")) : undefined;
        const nearest = "tagName" in node && isHtml(node, "form") ? node : form;

        for (const child of children.toReversed()) {
            stack.push({ element: child, form: nearest, isFenced: isFenced || (isFence && child !== legend) });
        }
    };

    push(root, { form: null, isFenced: false });

    for (let entry = stack.pop(); entry; entry = stack.pop()) {
        found.push(entry);
        push(entry.element, entry);
    }

    return found;
};

/** Whether a control is disabled: its own `disabled`, or a disabled fieldset's, unless it sits in that fieldset's first legend. */
const isDisabled = ({ element, isFenced }: Placed): boolean => attribute(element, "disabled") !== null || isFenced;

/** The fields of a destination: where the form goes, how and in which window. The field's name and place are compared apart. */
const isSameDestination = (one: Omit<FormTarget, "name">, other: Omit<FormTarget, "name">): boolean =>
    one.action === other.action && one.charset === other.charset && one.enctype === other.enctype && one.method === other.method && one.target === other.target;

/**
 * Where each password field of `html` would be sent, in document order (`null` for one in no form, `AMBIGUOUS` for one
 * whose form's enabled submit buttons would send it to different places), read the way
 * `checkForm` reads the live page: the form owner by the `form` attribute or the nearest form around it, the first enabled
 * submit button of that form, and the addresses against the first `<base href>` or `url`. A form the parser ties to a field
 * it does not hold (a form in a table) is not seen, so that field is in no form here. A page with a tag of more than
 * `MAX_TAG_ATTRIBUTES` attributes, or that takes more than `MAX_PARSE_WORK` to parse, is not read: its first field
 * counts as in no form.
 */
export const servedForms = (html: string, url: string): (FormTarget | typeof AMBIGUOUS | null)[] => {
    const document = parseBounded(html);

    if (!document) {
        return [null];
    }

    const elements = inOrder(document);
    const html5 = elements.filter(({ element }) => element.namespaceURI === HTML_NAMESPACE);
    const baseHref = html5.find(({ element }) => isHtml(element, "base") && attribute(element, "href") !== null);
    const href = baseHref ? (attribute(baseHref.element, "href") ?? "") : null;
    const base = href !== null && URL.canParse(href, url) ? new URL(href, url).href : url;
    const baseTarget = html5.find(({ element }) => isHtml(element, "base") && attribute(element, "target") !== null);
    const ids = new Map<string, Element>();

    for (const { element } of elements) {
        const id = attribute(element, "id");

        if (id !== null && id !== "" && !ids.has(id)) {
            ids.set(id, element);
        }
    }

    const ownerOf = ({ element, form }: Placed): Element | null => {
        const named = attribute(element, "form");

        if (named !== null) {
            const owner = ids.get(named);

            return owner && isHtml(owner, "form") ? owner : null;
        }

        return form;
    };

    const typeOf = (element: Element): string => attribute(element, "type")?.toLowerCase() ?? "";

    // The enabled submit buttons of each form, in document order: read once, not once for each password field.
    const submitters = new Map<Element, Element[]>();

    for (const entry of html5) {
        const isSubmit = isHtml(entry.element, "button")
            ? !["button", "reset"].includes(typeOf(entry.element))
            : isHtml(entry.element, "input") && ["image", "submit"].includes(typeOf(entry.element));
        const form = isSubmit && !isDisabled(entry) ? ownerOf(entry) : null;

        if (form) {
            // Appended in place: a copy for each button would be quadratic in a form's buttons.
            const known = submitters.get(form) ?? [];

            known.push(entry.element);
            submitters.set(form, known);
        }
    }

    // Each action address resolved once, to where it sends the form without its fragment: a form's own one is shared by
    // every submit button that does not override it. An empty action is the document's own address, whatever its base.
    const resolvedActions = new Map<string, string>();
    const resolve = (action: string): string => {
        let resolved = resolvedActions.get(action);

        if (resolved === undefined) {
            let address = url;

            if (action !== "") {
                address = URL.canParse(action, base) ? new URL(action, base).href : `unparsable:${action}`;
            }

            resolved = address.split("#", 1)[0] ?? address;
            resolvedActions.set(action, resolved);
        }

        return resolved;
    };

    /** Where `form` goes when `button` (the first enabled submit button, or none) sends it. */
    const destinationOf = (form: Element, button: Element | undefined): Omit<FormTarget, "name"> => {
        const override = (name: string): string | null => (button ? attribute(button, name) : null);

        return {
            action: resolve(override("formaction") ?? attribute(form, "action") ?? ""),
            charset: attribute(form, "accept-charset") ?? "",
            enctype: enctypeOf(override("formenctype") ?? attribute(form, "enctype")),
            method: (override("formmethod") ?? attribute(form, "method") ?? "post").toLowerCase(),
            target: (override("formtarget") ?? attribute(form, "target") ?? (baseTarget ? attribute(baseTarget.element, "target") : null) ?? "").toLowerCase(),
        };
    };

    const destinations = new Map<Element, Omit<FormTarget, "name"> | typeof AMBIGUOUS>();

    /** Where `form` goes, once for each form: `AMBIGUOUS` when its submit buttons send it to different places. */
    const destinationOfForm = (form: Element): Omit<FormTarget, "name"> | typeof AMBIGUOUS => {
        const known = destinations.get(form);

        if (known) {
            return known;
        }

        const [button, ...others] = submitters.get(form) ?? [];
        const destination = destinationOf(form, button);
        // Which button is first is the page's to change (a button rendered above the form's own, by its `form` attribute).
        const found = others.every((other) => isSameDestination(destinationOf(form, other), destination)) ? destination : AMBIGUOUS;

        destinations.set(form, found);

        return found;
    };

    return html5
        .filter(({ element }) => isHtml(element, "input") && typeOf(element) === "password")
        .map((entry) => {
            const form = ownerOf(entry);

            if (!form) {
                return null;
            }

            const destination = destinationOfForm(form);

            return destination === AMBIGUOUS ? AMBIGUOUS : { ...destination, name: attribute(entry.element, "name") ?? "" };
        });
};

/**
 * Where the password may be sent: the destination of the first password field the site sent, as the field `live.name`
 * of that form. `null` unless the live form, `live`, is that very destination, the site sent a password field of that
 * name to it, and every password field the site sent in a form goes there too (content the site renders above its login
 * form, or a sign-up form beside it, could otherwise be the one filled); also when that first field is in no form parse5
 * sees (one the parser ties to a form in a table), which cannot be checked, and when any password form the site sent is
 * `AMBIGUOUS`. The live values are read in the page, whose
 * scripts could fake them: what is sent is held to the served destination and name by the request guard, so a faked
 * report only has the form not sent.
 */
export const servedTarget = (served: (FormTarget | typeof AMBIGUOUS | null)[], live: FormTarget): FormTarget | null => {
    const [first] = served;
    const targets = served.filter((target): target is FormTarget => target !== null && target !== AMBIGUOUS);

    if (
        !first ||
        first === AMBIGUOUS ||
        served.includes(AMBIGUOUS) ||
        !isSameDestination(first, live) ||
        targets.some((target) => !isSameDestination(target, first))
    ) {
        return null;
    }

    return targets.some((target) => target.name === live.name) ? { ...first, name: live.name } : null;
};

/** The most served HTML read, in bytes: a login page is far smaller, and a larger one is not checked. */
export const MAX_SERVED_BYTES = 2 * 1024 * 1024;
