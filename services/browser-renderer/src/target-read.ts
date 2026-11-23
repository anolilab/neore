/** The read options the renderer and its tests give `readTarget`: the longest name read, and the patterns it matches with. */
export const TARGET_READ_OPTIONS = {
    max: 15_000,
    pathSplitter: /\P{L}+/u,
    payment: /pay|stripe|adyen|braintree|checkout|klarna|mollie|sumup|worldpay|saferpay|sofort|wirecard/iu,
    splitter: /\s+/u,
    submit: /^(?:confirm|submit|continue|complete|place|subscribe|weiter|bestätigen|absenden|abonnieren)[.!]?$/iu,
    subscribe: /^(?:subscribe|abonnieren)[.!]?$/iu,
};

/** What one read of an element reports. `target` is the fingerprint: SHA-256 of `canonical`, computed in the page. */
export interface TargetRead {
    canonical: string;
    checkout: boolean;
    /** The click was dispatched (`click` given, and the check passed). */
    clicked: boolean;
    label: string;
    labelTruncated: boolean;
    /** Why a click given `click` or `expect` did not run: the target changed, or the control is disabled or hidden. */
    /** `changed`: the target differs before any click. `moved`: the click ran, and a page handler moved its destination, so the browser was stopped. */
    refused?: "changed" | "covered" | "disabled" | "hidden" | "moved" | "pressed";
    shown: string;
    submitLike: boolean;
    subscribeLike: boolean;
    target: string;
}

/** One read of the element: what `readTarget` reports, and the destinations its click guards compare against. */
type ReadNow = Omit<TargetRead, "clicked" | "refused"> & { destinations: string; destinationsOf: () => string };

/**
 * Reads a control the way a click reaches it, in the page: `label`, its accessible name (capped; `labelTruncated` when cut),
 * and `target`, a fingerprint of the element (its place in the page, its name and its shown text). A click given that
 * `target` runs only on the element that still has it. The read is one function, so the check and the click agree.
 *
 * With `click`, the check and the click are one synchronous step inside the page: the fingerprint is compared, the control
 * is checked for being disabled or hidden, and the click is dispatched, with nothing the page does able to run in between.
 * The click is a DOM click, not Playwright's pointer press: no scroll, no hover, and no user activation.
 */
export function readTarget(
    control: Element,
    options: {
        click?: boolean;
        expect?: string;
        max: number;
        pathSplitter: RegExp;
        payment: RegExp;
        splitter: RegExp;
        /** An approved click: an element opacity hides is refused too. An ordinary click ignores opacity (a styled checkbox's input is 0). */
        strict?: boolean;
        submit: RegExp;
        subscribe: RegExp;
    },
): TargetRead {
    // The read, as one function. A click reads the element again after its press, so a change inside a child element (which the
    // names above read) is seen before the click. Written as an array element, so the bundler does not name it.
    const [readNow] = [
        (): ReadNow => {
            // This function is serialized into the page by Playwright (`element.evaluate`). A bundler wraps a named inner function in a
            // helper the page does not have, so this function declares none: every step is written out in its body.
            // The elements the click lands in: the control, then each actionable ancestor. A visible child (an icon in a button, a
            // span in a clickable div) is clicked as those ancestors too. A shadow root is crossed to its host.
            const actionableSelector =
                "button, a[href], [role='button'], [role='link'], [onclick], [tabindex]:not([tabindex='-1']), label, summary, input[type='button'], input[type='submit'], input[type='reset']";
            const nodes: Element[] = [control];
            let climb: Element | null = control;

            while (climb !== null) {
                const root = climb.getRootNode();
                const parent: Element | null = climb.parentElement ?? (root instanceof ShadowRoot ? root.host : null);

                if (parent !== null && parent.matches(actionableSelector) && !nodes.includes(parent)) {
                    nodes.push(parent);
                }

                climb = parent;
            }

            // The nearest actionable element is the one the click lands on, so its text and content count. A farther one (a clickable
            // list or grid around other items) contributes only its names: its text would make every item in it read as a purchase.
            const scope = control.matches(actionableSelector) ? control : (nodes[1] ?? control);
            const names: string[] = [];

            // The label-reference budget (every reference of this read, in total) and whether it ran out.
            let referenceBudget = 2000;
            let isReferenceCapped = false;

            // The elements between the control and the scope (a span with an aria-label around an icon inside a button): their names
            // count, so an icon named that way does not read as unnamed. Their text does not, as the scope's is what the click reads.
            const between: Element[] = [];
            let climbing: Element | null = control;

            while (climbing !== null && climbing !== scope) {
                const root = climbing.getRootNode();
                const parent: Element | null = climbing.parentElement ?? (root instanceof ShadowRoot ? root.host : null);

                if (parent !== null && parent !== scope) {
                    between.push(parent);
                }

                climbing = parent;
            }

            for (const node of [...nodes, ...between]) {
                names.push(node.getAttribute("aria-label") ?? "", node.getAttribute("title") ?? "");

                // Ids are separated by any ASCII whitespace, not only a space.
                const ids = (node.getAttribute("aria-labelledby") ?? "").split(options.splitter).filter(Boolean);

                for (const id of ids) {
                    const target = (node.getRootNode() as Document).querySelector(`#${CSS.escape(id)}`);

                    if (target !== null) {
                        // The referenced element's own name (an image's alt, its aria-label or title), then its text and the names inside it.
                        // One budget covers every reference of this read: past it the read is capped (the gate asks), and no more text is read.
                        names.push(target.getAttribute("alt") ?? "", target.getAttribute("aria-label") ?? "", target.getAttribute("title") ?? "");
                        const innerWalk = document.createTreeWalker(target, NodeFilter.SHOW_ELEMENT);
                        const inners: Element[] = [];

                        for (let walked = innerWalk.nextNode(); walked !== null && !isReferenceCapped; walked = innerWalk.nextNode()) {
                            referenceBudget--;

                            if (referenceBudget < 0) {
                                isReferenceCapped = true;
                            } else if ((walked as Element).matches("img[alt], [aria-label], [title]")) {
                                inners.push(walked as Element);
                            }
                        }

                        if (!isReferenceCapped) {
                            names.push(target.textContent ?? "");
                        }

                        for (const inner of inners) {
                            names.push(inner.getAttribute("alt") ?? "", inner.getAttribute("aria-label") ?? "", inner.getAttribute("title") ?? "");
                        }
                    }
                }

                // A submit-style button's value is its label. A text field's value is never read: a person may have typed into it.
                if (node instanceof HTMLInputElement && ["button", "reset", "submit"].includes(node.type)) {
                    names.push(node.value);
                }

                // A label is clicked as the control it labels (a submit input, or a button): that control's name and value count too.
                const labelled = node instanceof HTMLLabelElement ? node.control : null;

                if (labelled !== null) {
                    names.push(labelled.getAttribute("aria-label") ?? "", labelled.getAttribute("title") ?? "");

                    if (labelled instanceof HTMLInputElement && ["button", "reset", "submit"].includes(labelled.type)) {
                        names.push(labelled.value);
                    }
                }

                // The rendered text of the control and of the element it lands on: a child with ordinary text can sit beside a purchase
                // word the person sees.
                if ((node === control || node === scope) && node instanceof HTMLElement) {
                    // eslint-disable-next-line unicorn/prefer-dom-node-text-content -- rendered text on purpose: textContent keeps hidden descendants
                    names.push(node.innerText);
                }
            }

            // The elements inside the scope, including those in an open shadow root (a shadow tree is part of the button it draws).
            // querySelectorAll stops at a shadow root, so each root found is walked too.
            const roots: (Element | ShadowRoot)[] = [scope];

            if (scope.shadowRoot !== null) {
                roots.push(scope.shadowRoot);
            }

            // A large control is not walked in full: each node costs style and layout reads, so past this many the scan stops and the
            // read says so (`labelTruncated`), which makes the gate ask rather than clear a target it did not finish reading.
            const inside: Element[] = [];
            let isScanCapped = false;

            for (let index = 0; index < roots.length; index++) {
                // A walk, not querySelectorAll: that lists every descendant before the cap is checked, so a huge control would be listed whole.
                const walker = document.createTreeWalker(roots[index], NodeFilter.SHOW_ELEMENT);

                for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
                    if (inside.length >= 2000) {
                        isScanCapped = true;
                        break;
                    }

                    const element = node as Element;

                    inside.push(element);

                    if (element.shadowRoot !== null) {
                        roots.push(element.shadowRoot);
                    }
                }

                if (isScanCapped) {
                    break;
                }
            }

            // Names that come from inside the scope: an image's alt, a child's aria-label or title, an SVG title.
            const scanned = [scope, ...inside];

            for (const node of scanned) {
                // What is drawn names the control: a hidden element's aria-label or title does not (only a referenced one does, below).
                const isDrawn = node.getClientRects().length > 0 && getComputedStyle(node).visibility !== "hidden";

                // An image (`img`) or an image button (`input type="image"`) names itself by its alt text.
                if (isDrawn && node.matches("img[alt], input[type='image'][alt], [aria-label], [title]")) {
                    names.push(node.getAttribute("alt") ?? "", node.getAttribute("aria-label") ?? "", node.getAttribute("title") ?? "");
                }

                // An SVG's title names the drawn SVG (a `<title>` itself is never drawn, so its parent is what is checked).
                if (node.localName === "title" && node.parentElement?.localName === "svg" && node.parentElement.getClientRects().length > 0) {
                    names.push(node.textContent ?? "");
                }

                // A descendant's aria-labelledby names its text from elsewhere in the page (or its shadow tree): that text is its name.
                const referenced = (node.getAttribute("aria-labelledby") ?? "").split(options.splitter).filter(Boolean);

                for (const id of referenced) {
                    const target = (node.getRootNode() as Document).querySelector(`#${CSS.escape(id)}`);

                    if (target !== null) {
                        // The referenced element's own name (an image's alt, its aria-label or title), then its text and the names inside it.
                        // One budget covers every reference of this read: past it the read is capped (the gate asks), and no more text is read.
                        names.push(target.getAttribute("alt") ?? "", target.getAttribute("aria-label") ?? "", target.getAttribute("title") ?? "");
                        const innerWalk = document.createTreeWalker(target, NodeFilter.SHOW_ELEMENT);
                        const inners: Element[] = [];

                        for (let walked = innerWalk.nextNode(); walked !== null && !isReferenceCapped; walked = innerWalk.nextNode()) {
                            referenceBudget--;

                            if (referenceBudget < 0) {
                                isReferenceCapped = true;
                            } else if ((walked as Element).matches("img[alt], [aria-label], [title]")) {
                                inners.push(walked as Element);
                            }
                        }

                        if (!isReferenceCapped) {
                            names.push(target.textContent ?? "");
                        }

                        for (const inner of inners) {
                            names.push(inner.getAttribute("alt") ?? "", inner.getAttribute("aria-label") ?? "", inner.getAttribute("title") ?? "");
                        }
                    }
                }
            }

            // Generated text (CSS `content`) drawn by the control, the scope, and the elements inside the scope: it is on screen but in
            // neither innerText nor textContent. An element nothing is drawn for shows none of its own. Stops once past the cap.
            let generatedLength = 0;
            const drawn = new Set<Element>([control, scope, ...inside]);

            for (const node of drawn) {
                if (node.getClientRects().length === 0 || getComputedStyle(node).visibility === "hidden") {
                    continue;
                }

                // `::marker` is a list item's bullet, which the stylesheet can set to words (a "Buy" marker); it is drawn text too.
                for (const pseudo of ["::before", "::after", "::marker"]) {
                    const { content } = getComputedStyle(node, pseudo);

                    if (content !== "none" && content !== "normal") {
                        // CSS `content` is a sequence of quoted strings (their text) and attr(name) calls (the attribute's value). url()
                        // and counters draw no words of their own, so they add nothing.
                        // A url("...") holds a file name, not text: its quoted part is dropped before the quoted strings are read.
                        const withoutUrls = content
                            .split("url(")
                            .map((part, index) => (index === 0 ? part : part.slice(part.indexOf(")") + 1)))
                            .join("");
                        const quoted = withoutUrls.split('"').filter((_, index) => index % 2 === 1);
                        const attributes = content
                            .split("attr(")
                            .slice(1)
                            .map((part) => node.getAttribute(part.split(")", 1)[0]?.trim() ?? "") ?? "");

                        for (const text of [...quoted, ...attributes]) {
                            names.push(text);
                            generatedLength += text.length;
                        }
                    }
                }

                // Past the cap the rest of the drawn text is not read: the read is cut short, so it counts as truncated (the gate asks).
                if (generatedLength > options.max) {
                    isScanCapped = true;
                    break;
                }
            }

            // Each name source on its own: a submit word is a name only when a source is exactly that word (joined names never are).
            const isSubmitLike = names.some((part) => options.submit.test(part.trim()));
            // The same for a bare subscription word ("Subscribe", "Abonnieren"): the gate asks for it on any page.
            const isSubscribeLike = names.some((part) => options.subscribe.test(part.trim()));
            // A name found by two sources (the control's own aria-label is read in both the nodes and the scan) counts once: it would
            // otherwise use up the cap twice.
            const joined = [...new Set(names.filter(Boolean))].join(" ");
            const label = joined.slice(0, options.max);
            // eslint-disable-next-line unicorn/prefer-dom-node-text-content -- the shown text on purpose: textContent keeps hidden descendants
            const shown = control instanceof HTMLElement ? control.innerText : (control.textContent ?? "");

            // The element's place: the tag and position of each ancestor, from the root down, crossing shadow roots like the walk above.
            const steps: string[] = [];
            let current: Element | null = control;

            while (current !== null && current !== document.documentElement) {
                // The position among its siblings, in the parent node: a child of a shadow root has no parent element, so its
                // siblings are the root's children (indexing those as zero would make two different controls share a place).
                const { parentNode } = current;
                const index = parentNode === null ? 0 : [...(parentNode as Element | ShadowRoot).children].indexOf(current);
                const root = current.getRootNode();

                steps.unshift(`${current.localName}.${index}`);
                current = current.parentElement ?? (root instanceof ShadowRoot ? root.host : null);
            }

            // Where the click goes: a link's href, a button's formaction, and the form it submits to. Changing one changes what the
            // click does, so it is part of the fingerprint.
            // The form a click submits: a button's own form (its `form` attribute can name one outside it), else the enclosing form.
            let enclosingForm: HTMLFormElement | null = control.closest("form");

            for (const node of nodes) {
                if ((node instanceof HTMLButtonElement || node instanceof HTMLInputElement) && node.form !== null) {
                    enclosingForm = node.form;
                }
            }

            // The form the getter reads (a field named "action" would shadow the form's own property, so the prototype's getter is used).
            const formActionGetter = Object.getOwnPropertyDescriptor(HTMLFormElement.prototype, "action")?.get;
            // The click's destinations, as the page holds them. A function, inside an array so the bundler does not name it: it runs for
            // the fingerprint, and again after the page's own click handlers, which can move a destination during the click.
            const [destinationsOf] = [
                (): string => {
                    let destinations = "";

                    // The owner now: a submit control's `form` attribute can move it to another form after the check, and the browser
                    // submits to the form it has now.
                    let ownerNow: HTMLFormElement | null = control.closest("form");

                    for (const node of nodes) {
                        if ((node instanceof HTMLButtonElement || node instanceof HTMLInputElement) && node.form !== null) {
                            ownerNow = node.form;
                        }
                    }

                    for (const node of nodes) {
                        // The resolved address (the `href` and `formAction` properties), not the raw attribute: a `<base>` change or a relative
                        // path moves the same attribute to another site.
                        const link = node instanceof HTMLAnchorElement || node instanceof HTMLAreaElement ? node.href : "";
                        const formTarget = node instanceof HTMLButtonElement || node instanceof HTMLInputElement ? node.formAction : "";
                        // A button's type decides whether its click submits the form ("submit" by default, "button" does not): a change to it
                        // is a change of what the click does.
                        // What a submit sends with the form: a submit control's name and value (an order intent is often a value), and how it
                        // submits (its method). A text field's value is never read: a person may have typed into it.
                        const submitter = node instanceof HTMLButtonElement || node instanceof HTMLInputElement ? node : null;
                        const isSubmitValued =
                            submitter instanceof HTMLButtonElement ||
                            (submitter instanceof HTMLInputElement && ["button", "image", "reset", "submit"].includes(submitter.type));
                        const kind =
                            submitter === null ? "" : [submitter.type, submitter.name, isSubmitValued ? submitter.value : "", submitter.formMethod].join("#");

                        destinations += `${link}|${formTarget}|${kind}|`;
                    }

                    // The form's method is part of what a submit does (a GET form puts its fields in the address).
                    destinations += ownerNow === null ? "" : `|${Element.prototype.getAttribute.call(ownerNow, "method") ?? ""}`;

                    // The form's destination: the browser's own resolved `action`, read through the native getter. A `<base>` change moves it.
                    return destinations + (ownerNow === null || formActionGetter === undefined ? "" : String(formActionGetter.call(ownerNow)));
                },
            ];
            const destinations = destinationsOf();
            const formAction = enclosingForm === null || formActionGetter === undefined ? "" : String(formActionGetter.call(enclosingForm));

            // The page's own address too: the same markup on another page (after a navigation during the approval) is another target.
            // A checkout: a form the control submits with card or bank fields in it, or a page whose address says so. A bare "Confirm"
            // there pays, so the gate reads a submit-like label on a checkout as a purchase.
            // A card form is also one whose fields sit in a frame the page cannot read (a hosted card element), or one that posts to
            // another site: its fields are not in the DOM, so the field check alone misses it. Only a payment provider's frame or
            // host counts: a login or contact form with a captcha frame, or one that posts to another site, is not a checkout.
            // Card fields are read in the form when there is one, and on the page when there is not (a card form built from divs).
            // A frame or a cross-origin action only counts inside a form, since those are what a hosted card form is.
            const cardSelector =
                "input[autocomplete^='cc-'], input[name*='card' i], input[name*='cc-' i], input[name*='cvc' i], input[name*='cvv' i], input[name*='iban' i], input[name*='bic' i], input[name*='routing' i], input[name*='bank' i], input[name*='account_number' i], input[name*='accountnumber' i]";
            const hasCardFields =
                (enclosingForm === null ? document.querySelector(cardSelector) : Element.prototype.querySelector.call(enclosingForm, cardSelector)) !== null;
            const frameSources =
                enclosingForm === null
                    ? []
                    : [...Element.prototype.querySelectorAll.call(enclosingForm, "iframe")].map(
                          (frame) => Element.prototype.getAttribute.call(frame, "src") ?? "",
                      );
            // A frame whose address does not parse is no payment frame: the read itself must not fail on it.
            const isPaymentFrame = frameSources.some((source) => {
                try {
                    return source !== "" && options.payment.test(new URL(source, document.URL).hostname);
                } catch {
                    return false;
                }
            });
            const formUrl = new URL(formAction, document.URL);
            const isPaymentPost = formUrl.origin !== new URL(document.URL).origin && options.payment.test(formUrl.hostname);
            const isCardFields = hasCardFields || isPaymentFrame || isPaymentPost;
            // The address's path words, not the whole address: "cart" is a page's word, "cartoon" or a host name containing it is not.
            // The path is decoded first: an encoded separator ("%2F") is a separator too. A path that will not decode is read as a checkout,
            // so a bare submit label there asks rather than clears.
            let decodedPath = "";
            let isUndecodable = false;

            try {
                decodedPath = decodeURIComponent(new URL(document.URL).pathname);
            } catch {
                isUndecodable = true;
            }

            const pathWords = decodedPath.toLowerCase().split(options.pathSplitter);
            const isCheckoutPage =
                isUndecodable ||
                pathWords.some((word) => ["basket", "cart", "checkout", "kasse", "payment", "warenkorb"].includes(word) || word.startsWith("bestell"));

            // The whole canonical string, the checkout flag included (a field that appears after the decision changes it), so no two
            // different targets share a fingerprint. The page digests it below.
            const isCheckout = isCardFields || isCheckoutPage;
            // The submit-like and subscribe-like flags are part of it too: a name change that makes a control submit-like (an arrow named
            // "Review" with a title "Confirm") or subscription-like (one name source "Subscribe" with a title "Monthly plan") invalidates
            // an earlier approval, as the checkout flag does, even when the joined name reads the same.
            const canonical = [
                document.URL,
                steps.join(">"),
                joined,
                shown,
                destinations,
                String(isCheckout),
                String(isSubmitLike),
                String(isSubscribeLike),
                String(isScanCapped || isReferenceCapped),
            ].join("\u{0}");

            // SHA-256 of the canonical string, computed here, in the page, with no `await`: a digest the page could only await would
            // leave a gap in which the page changes the element between the check and the click (`clicked` below).
            const bytes = new TextEncoder().encode(canonical);
            const padded = new Uint8Array(Math.ceil((bytes.length + 9) / 64) * 64);
            const view = new DataView(padded.buffer);
            const bitLength = bytes.length * 8;

            padded.set(bytes);
            padded[bytes.length] = 0x80;
            view.setUint32(padded.length - 8, Math.floor(bitLength / 4_294_967_296));
            view.setUint32(padded.length - 4, bitLength >>> 0);

            // The round constants: the first 32 bits of the fractional parts of the cube roots of the first 64 primes (FIPS 180-4).
            const constants =
                "428a2f98 71374491 b5c0fbcf e9b5dba5 3956c25b 59f111f1 923f82a4 ab1c5ed5 d807aa98 12835b01 243185be 550c7dc3 72be5d74 80deb1fe 9bdc06a7 c19bf174 e49b69c1 efbe4786 0fc19dc6 240ca1cc 2de92c6f 4a7484aa 5cb0a9dc 76f988da 983e5152 a831c66d b00327c8 bf597fc7 c6e00bf3 d5a79147 06ca6351 14292967 27b70a85 2e1b2138 4d2c6dfc 53380d13 650a7354 766a0abb 81c2c92e 92722c85 a2bfe8a1 a81a664b c24b8b70 c76c51a3 d192e819 d6990624 f40e3585 106aa070 19a4c116 1e376c08 2748774c 34b0bcb5 391c0cb3 4ed8aa4a 5b9cca4f 682e6ff3 748f82ee 78a5636f 84c87814 8cc70208 90befffa a4506ceb bef9a3f7 c67178f2"
                    .split(" ")
                    .map((word) => Number.parseInt(word, 16));
            const state = [0x6a_09_e6_67, 0xbb_67_ae_85, 0x3c_6e_f3_72, 0xa5_4f_f5_3a, 0x51_0e_52_7f, 0x9b_05_68_8c, 0x1f_83_d9_ab, 0x5b_e0_cd_19];
            const schedule = new Uint32Array(64);

            for (let block = 0; block < padded.length; block += 64) {
                for (let t = 0; t < 16; t++) {
                    schedule[t] = view.getUint32(block + t * 4);
                }

                for (let t = 16; t < 64; t++) {
                    const x = schedule[t - 15];
                    const y = schedule[t - 2];
                    const sigma0 = ((x >>> 7) | (x << 25)) ^ ((x >>> 18) | (x << 14)) ^ (x >>> 3);
                    const sigma1 = ((y >>> 17) | (y << 15)) ^ ((y >>> 19) | (y << 13)) ^ (y >>> 10);

                    schedule[t] = schedule[t - 16] + sigma0 + schedule[t - 7] + sigma1;
                }

                let [wa, wb, wc, wd, we, wf, wg, wh] = state;

                for (let t = 0; t < 64; t++) {
                    const sum1 = ((we >>> 6) | (we << 26)) ^ ((we >>> 11) | (we << 21)) ^ ((we >>> 25) | (we << 7));
                    const choose = (we & wf) ^ (~we & wg);
                    const temporary1 = wh + sum1 + choose + constants[t] + schedule[t];
                    const sum0 = ((wa >>> 2) | (wa << 30)) ^ ((wa >>> 13) | (wa << 19)) ^ ((wa >>> 22) | (wa << 10));
                    const majority = (wa & wb) ^ (wa & wc) ^ (wb & wc);
                    const temporary2 = sum0 + majority;

                    wh = wg;
                    wg = wf;
                    wf = we;
                    we = (wd + temporary1) >>> 0;
                    wd = wc;
                    wc = wb;
                    wb = wa;
                    wa = (temporary1 + temporary2) >>> 0;
                }

                for (const [index, word] of [wa, wb, wc, wd, we, wf, wg, wh].entries()) {
                    state[index] = (state[index] + word) >>> 0;
                }
            }

            const target = state.map((word) => word.toString(16).padStart(8, "0")).join("");

            return {
                canonical,
                checkout: isCheckout,
                destinations,
                destinationsOf,
                label,
                labelTruncated: joined.length > options.max || isScanCapped || isReferenceCapped,
                shown,
                submitLike: isSubmitLike,
                subscribeLike: isSubscribeLike,
                target,
            };
        },
    ];
    const first = readNow();

    // The check and the click are this same step: nothing the page does can run between them. The press runs the page's handlers,
    // so the element is read again after it, and nothing is clicked if it no longer reads as it did.
    // Helpers for the click check, each an array element so the bundler does not name it. Disabled: the control or an ancestor, across
    // shadow roots, is disabled. Covered: the element at the control's centre is neither the control, its ancestors nor its
    // descendants, so another element (a dialog, an overlay) takes the press.
    const [isDisabledIn] = [
        (node: Element): boolean => {
            for (let current: Element | null = node; current !== null;) {
                if (current.matches(":disabled") || current.getAttribute("aria-disabled") === "true") {
                    return true;
                }

                const owner = current.getRootNode();

                current = current.parentElement ?? (owner instanceof ShadowRoot ? owner.host : null);
            }

            return false;
        },
    ];
    const [isCoveredIn] = [
        (node: Element): boolean => {
            const box = node.getBoundingClientRect();
            const owner = node.getRootNode() as Document | ShadowRoot;
            const hit = owner.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);

            if (hit === null) {
                return true;
            }

            if (node.contains(hit)) {
                return false;
            }

            for (let current: Element | null = node; current !== null;) {
                if (current === hit) {
                    return false;
                }

                const root = current.getRootNode();

                current = current.parentElement ?? (root instanceof ShadowRoot ? root.host : null);
            }

            return true;
        },
    ];

    let refused: TargetRead["refused"];
    let isClicked = false;

    if (options.expect !== undefined && first.target !== options.expect) {
        refused = "changed";
    } else if (options.click === true) {
        // A control scrolled out of view is brought into view first (as a click does), so the cover check below can see it.
        control.scrollIntoView({ block: "center", inline: "center" });

        if (isDisabledIn(control)) {
            refused = "disabled";
        } else if (
            control.getClientRects().length === 0 ||
            getComputedStyle(control).visibility === "hidden" ||
            control.checkVisibility?.({ opacityProperty: options.strict === true, visibilityProperty: true }) === false
        ) {
            refused = "hidden";
        } else if (isCoveredIn(control)) {
            refused = "covered";
        } else {
            // The page's handlers run during the click. A destination one of them moved is refused at the boundary where it would
            // be used: a click (the window's bubble phase), a form's submission (its destination is set back to the approved one, below),
            // and a link's navigation (the Navigation API, where the page has it). A canceled boundary activates nothing.
            const stop = new AbortController();
            let isMoved = false;
            const clickScope = globalThis;

            clickScope.addEventListener(
                "click",
                (event) => {
                    if (first.destinationsOf() === first.destinations) {
                        return;
                    }

                    isMoved = true;
                    event.preventDefault();
                },
                { signal: stop.signal },
            );
            // A form the click submits: the browser submits it itself, as a submit button's click does, reading the form's and the
            // submitter's destination attributes when it does. Those attributes are read here, at the check's approval, and the
            // window's submit listener (the last of the bubble phase) sets them back before the submission, so a page handler that
            // moved one is not submitted there. A handler that cancelled the submission keeps it cancelled. Known limit: a page that
            // stops the submit event's propagation before it reaches the window, or adds a window listener during the click after
            // this one, is submitted to whatever destination it set.
            // The browser activates the nearest activatable element: a click on a child of a button (a span in it) submits through that
            // button, and a label's click activates the control it labels (`HTMLLabelElement.control`).
            const activatable = control.closest("button, input, label, a");
            const activated: Element | null = activatable instanceof HTMLLabelElement ? activatable.control : activatable;
            const submitter = activated instanceof HTMLButtonElement || activated instanceof HTMLInputElement ? activated : null;
            const isSubmitter =
                submitter !== null && (submitter instanceof HTMLButtonElement ? submitter.type === "submit" : ["image", "submit"].includes(submitter.type));
            const ownForm = isSubmitter && submitter !== null ? submitter.form : null;
            // The approved attributes (null when absent): the form's destination and the submitter's own overrides.
            const approved: [Element, string, string | null][] = [];
            // The page's values, as they were when the submit listener set the approved ones: put back once the click is dispatched.
            const pageValues: [Element, string, string | null][] = [];

            if (isSubmitter && submitter !== null && ownForm !== null) {
                for (const name of ["action", "method", "enctype", "target"]) {
                    approved.push([ownForm, name, ownForm.getAttribute(name)]);
                }

                for (const name of ["formaction", "formmethod", "formenctype", "formtarget"]) {
                    approved.push([submitter, name, submitter.getAttribute(name)]);
                }
            }

            clickScope.addEventListener(
                "submit",
                (event) => {
                    if (approved.length === 0 || event.target !== ownForm || event.defaultPrevented) {
                        return;
                    }

                    for (const [element, name, value] of approved) {
                        pageValues.push([element, name, element.getAttribute(name)]);
                        element.removeAttribute(name);

                        if (value !== null) {
                            element.setAttribute(name, value);
                        }
                    }
                },
                { signal: stop.signal },
            );
            const { navigation } = clickScope as typeof clickScope & { navigation?: EventTarget };

            navigation?.addEventListener(
                "navigate",
                (event) => {
                    if (first.destinationsOf() === first.destinations) {
                        return;
                    }

                    isMoved = true;
                    event.preventDefault();
                },
                { signal: stop.signal },
            );

            // The pointer sequence of a press, so hover, mouse-down and focus handlers respond as they do to a person's click. The
            // events are synthetic (isTrusted is false), so a popup that needs a user gesture is still blocked.
            const press = { bubbles: true, cancelable: true, composed: true };

            control.dispatchEvent(new PointerEvent("pointerdown", press));
            control.dispatchEvent(new MouseEvent("mousedown", press));

            if (control instanceof HTMLElement) {
                control.focus();
            }

            control.dispatchEvent(new PointerEvent("pointerup", press));
            control.dispatchEvent(new MouseEvent("mouseup", press));

            // The press's handlers ran after the check: the element is read again, and nothing is clicked if it reads differently
            // (a label, a name or a child's text changed in them). That refusal is `pressed`, not `changed`: the press already ran
            // its handlers, so the caller must not retry it as a changed target.
            if (readNow().target !== first.target) {
                refused = "pressed";
            } else if (isDisabledIn(control)) {
                // A press handler can disable the control without changing the fingerprint: it is not clicked then.
                refused = "disabled";
            } else if (
                control.getClientRects().length === 0 ||
                getComputedStyle(control).visibility === "hidden" ||
                control.checkVisibility?.({ opacityProperty: options.strict === true, visibilityProperty: true }) === false
            ) {
                refused = "hidden";
            } else if (isCoveredIn(control)) {
                refused = "covered";
            } else {
                control.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, composed: true }));
                isClicked = true;

                // The browser read the submission's destination during the click: the page's own values come back now.
                for (const [element, name, value] of pageValues) {
                    element.removeAttribute(name);

                    if (value !== null) {
                        element.setAttribute(name, value);
                    }
                }
            }

            stop.abort();

            // The click was dispatched; a moved destination is what stops it from being submitted.
            // A moved destination, or a form whose submission was cancelled and never made (a handler stopped the event): refused.
            if (isMoved) {
                refused = "moved";
            }
        }
    }

    return {
        canonical: first.canonical,
        checkout: first.checkout,
        clicked: isClicked,
        label: first.label,
        labelTruncated: first.labelTruncated,
        ...(refused !== undefined && { refused }),
        shown: first.shown,
        submitLike: first.submitLike,
        subscribeLike: first.subscribeLike,
        target: first.target,
    };
}
