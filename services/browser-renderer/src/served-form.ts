/**
 * The login forms of a page as the site sent it, read from the HTML of the page's own load outside the browser, where no
 * script of the page reaches. `checkForm` in `login.ts` reads the same values from the live page; the two must agree
 * exactly before anything is typed.
 */
import type { DefaultTreeAdapterTypes } from "parse5";
import { parse } from "parse5";

type Element = DefaultTreeAdapterTypes.Element;
type ParentNode = DefaultTreeAdapterTypes.ParentNode;

const HTML_NAMESPACE = "http://www.w3.org/1999/xhtml";

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

const ENCTYPES = new Set(["application/x-www-form-urlencoded", "multipart/form-data", "text/plain"]);

/** An `enctype` or `formenctype` value as the DOM reads it: an unknown one is URL-encoded. */
export const enctypeOf = (value: string | null): string => {
    const lowered = value?.toLowerCase() ?? "";

    return ENCTYPES.has(lowered) ? lowered : "application/x-www-form-urlencoded";
};

const attribute = (element: Element, name: string): string | null => element.attrs.find((pair) => pair.name === name && !pair.namespace)?.value ?? null;

const isHtml = (element: Element, tag: string): boolean => element.tagName === tag && element.namespaceURI === HTML_NAMESPACE;

/**
 * The elements of `root` in document order: each with its ancestors, nearest last. A depth-first walk, so an element's
 * descendants come right after it.
 */
const inOrder = (root: ParentNode): { ancestors: Element[]; element: Element }[] => {
    const found: { ancestors: Element[]; element: Element }[] = [];
    const stack: { ancestors: Element[]; node: Element }[] = [];
    const push = (ancestors: Element[], node: ParentNode): void => {
        const children = ("childNodes" in node ? node.childNodes : []).filter((child): child is Element => "tagName" in child);

        for (const child of children.toReversed()) {
            stack.push({ ancestors, node: child });
        }
    };

    push([], root);

    for (let entry = stack.pop(); entry; entry = stack.pop()) {
        found.push({ ancestors: entry.ancestors, element: entry.node });
        push([...entry.ancestors, entry.node], entry.node);
    }

    return found;
};

/** Whether a control is disabled: its own `disabled`, or a disabled fieldset's, unless it sits in that fieldset's first legend. */
const isDisabled = (element: Element, ancestors: Element[]): boolean =>
    attribute(element, "disabled") !== null ||
    ancestors.some((fieldset, at) => {
        if (!isHtml(fieldset, "fieldset") || attribute(fieldset, "disabled") === null) {
            return false;
        }

        const legend = fieldset.childNodes.find((child): child is Element => "tagName" in child && isHtml(child, "legend"));

        return legend === undefined || ancestors[at + 1] !== legend;
    });

/** The fields of a destination: where the form goes, how and in which window. The field's name and place are compared apart. */
const isSameDestination = (one: Omit<FormTarget, "name">, other: Omit<FormTarget, "name">): boolean =>
    one.action === other.action && one.charset === other.charset && one.enctype === other.enctype && one.method === other.method && one.target === other.target;

/**
 * Where each password field of `html` would be sent, in document order (`null` for one in no form), read the way
 * `checkForm` reads the live page: the form owner by the `form` attribute or the nearest form around it, the first enabled
 * submit button of that form, and the addresses against the first `<base href>` or `url`. A form the parser ties to a field
 * it does not hold (a form in a table) is not seen, so that field is in no form here; nor is a form whose enabled submit
 * buttons would send it to different places.
 */
export const servedForms = (html: string, url: string): (FormTarget | null)[] => {
    const elements = inOrder(parse(html));
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

    const ownerOf = ({ ancestors, element }: { ancestors: Element[]; element: Element }): Element | null => {
        const named = attribute(element, "form");

        if (named !== null) {
            const owner = ids.get(named);

            return owner && isHtml(owner, "form") ? owner : null;
        }

        return ancestors.findLast((ancestor) => isHtml(ancestor, "form")) ?? null;
    };

    const typeOf = (element: Element): string => attribute(element, "type")?.toLowerCase() ?? "";

    const submittersOf = (form: Element): Element[] =>
        html5
            .filter(
                (entry) =>
                    (isHtml(entry.element, "button")
                        ? !["button", "reset"].includes(typeOf(entry.element))
                        : isHtml(entry.element, "input") && ["image", "submit"].includes(typeOf(entry.element))) &&
                    ownerOf(entry) === form &&
                    !isDisabled(entry.element, entry.ancestors),
            )
            .map(({ element }) => element);

    /** Where `form` goes when `button` (the first enabled submit button, or none) sends it. */
    const destinationOf = (form: Element, button: Element | undefined): Omit<FormTarget, "name"> => {
        const override = (name: string): string | null => (button ? attribute(button, name) : null);
        const action = override("formaction") ?? attribute(form, "action") ?? "";
        const resolved = URL.canParse(action, base) ? new URL(action, base).href : `unparsable:${action}`;
        // An empty action is the document's own address, whatever its base.
        const address = action === "" ? url : resolved;

        return {
            action: address.split("#", 1)[0] ?? address,
            charset: attribute(form, "accept-charset") ?? "",
            enctype: enctypeOf(override("formenctype") ?? attribute(form, "enctype")),
            method: (override("formmethod") ?? attribute(form, "method") ?? "post").toLowerCase(),
            target: (override("formtarget") ?? attribute(form, "target") ?? (baseTarget ? attribute(baseTarget.element, "target") : null) ?? "").toLowerCase(),
        };
    };

    return html5
        .filter(({ element }) => isHtml(element, "input") && typeOf(element) === "password")
        .map((entry) => {
            const form = ownerOf(entry);

            if (!form) {
                return null;
            }

            const [button, ...others] = submittersOf(form);
            const destination = { ...destinationOf(form, button), name: attribute(entry.element, "name") ?? "" };

            // A form whose submit buttons send it to different places: which one is first is the page's to change (a
            // button rendered above the form's own, by its `form` attribute).
            return others.every((other) => isSameDestination(destinationOf(form, other), destination)) ? destination : null;
        });
};

/**
 * Where the password may be sent: the destination of the first password field the site sent, as the field `live.name`
 * of that form. `null` unless the live form, `live`, is that very destination, the site sent a password field of that
 * name to it, and every password field the site sent in a form goes there too (content the site renders above its login
 * form, or a sign-up form beside it, could otherwise be the one filled); also when that first field is in no form parse5
 * sees (one the parser ties to a form in a table), which cannot be checked. The live values are read in the page, whose
 * scripts could fake them: what is sent is held to the served destination and name by the request guard, so a faked
 * report only has the form not sent.
 */
export const servedTarget = (served: (FormTarget | null)[], live: FormTarget): FormTarget | null => {
    const [first] = served;

    if (!first || !isSameDestination(first, live) || served.some((target) => target !== null && !isSameDestination(target, first))) {
        return null;
    }

    return served.some((target) => target?.name === live.name) ? { ...first, name: live.name } : null;
};

/** The most served HTML read, in bytes: a login page is far smaller, and a larger one is not checked. */
export const MAX_SERVED_BYTES = 2 * 1024 * 1024;
