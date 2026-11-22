import { describe, expect, it, vi } from "vitest";

import type { FormTarget } from "./served-form";
import { AMBIGUOUS, MAX_TAG_ATTRIBUTES, servedForms, servedTarget } from "./served-form";

const URL_OF_PAGE = "https://id.example/login?x=1";

const FIELDS = '<input name="user"><input name="pw" type="password">';

const LIVE: FormTarget = {
    action: "https://id.example/session?session_code=Kq7aB9xZ2mQ4",
    charset: "",
    enctype: "application/x-www-form-urlencoded",
    method: "post",
    name: "pw",
    target: "",
};

describe(servedForms, () => {
    it("reads where a form sends its password field, as the DOM reads it", () => {
        expect(servedForms(`<form method="POST" action="/session?session_code=Kq7aB9xZ2mQ4">${FIELDS}<button>Go</button></form>`, URL_OF_PAGE)).toStrictEqual([
            LIVE,
        ]);
    });

    it("takes the first enabled submit button's overrides, wherever it sits", () => {
        const html = `<form id="f" action="/elsewhere" enctype="bogus">${FIELDS}<button disabled formaction="/disabled">x</button><fieldset disabled><button formaction="/fieldset">x</button></fieldset><button type="button" formaction="/plain">x</button></form><input type="image" form="f" formaction="/session" formenctype="MULTIPART/form-data" formtarget="_Self" formmethod="Post">`;

        expect(servedForms(html, URL_OF_PAGE)).toStrictEqual([
            { ...LIVE, action: "https://id.example/session", enctype: "multipart/form-data", target: "_self" },
        ]);
    });

    it("takes a button in a disabled fieldset's first legend as enabled, unless an outer fieldset disables it", () => {
        const inLegend = (outer: string): string =>
            `<form action="/form">${FIELDS}<fieldset ${outer}><fieldset disabled><legend><button formaction="/session?session_code=Kq7aB9xZ2mQ4">x</button></legend></fieldset></fieldset></form>`;

        expect(servedForms(inLegend(""), URL_OF_PAGE)).toStrictEqual([LIVE]);
        expect(servedForms(inLegend("disabled"), URL_OF_PAGE)).toStrictEqual([{ ...LIVE, action: "https://id.example/form" }]);
    });

    it("reads a page nested a thousand deep", () => {
        const html = `${"<div>".repeat(1000)}<form method="post" action="/session?session_code=Kq7aB9xZ2mQ4">${FIELDS}<button>Go</button></form>`;

        expect(servedForms(html, URL_OF_PAGE)).toStrictEqual([LIVE]);
    });

    it.each([
        ["elements nested deep", "<div>".repeat(7000)],
        // Each text reopens every formatting element still open: far more elements than there are tags.
        [
            "formatting elements reopened around each text",
            `<div>${Array.from({ length: 1000 }, (_, at) => `<b a${at}>`).join("")}</div>${"<div>x</div>".repeat(20_000)}`,
        ],
        ["end tags that match no open element", `${"<span>".repeat(1000)}${"</zz>".repeat(30_000)}`],
        ["formatting elements that differ in one attribute", Array.from({ length: 7000 }, (_, at) => `<b z=${at}>`).join("")],
        // Each text looks the formatting element at the foot up among all the open elements.
        ["texts under a formatting element deep down", `<b>${"<span>".repeat(3000)}${"x<!---->".repeat(10_000)}`],
    ])("does not read a page whose %s take the parser past its work limit", (_what, markup) => {
        expect(servedForms(`${markup}<form action="/session">${FIELDS}</form>`, URL_OF_PAGE)).toStrictEqual([null]);
    });

    it("does not read a page with a tag of more attributes than it looks up in time", () => {
        const tagOf = (count: number): string => `<div ${Array.from({ length: count }, (_, at) => `a${at}`).join(" ")}></div>`;
        const form = `<form method="post" action="/session?session_code=Kq7aB9xZ2mQ4">${FIELDS}<button>Go</button></form>`;

        expect(servedForms(`${tagOf(MAX_TAG_ATTRIBUTES)}${form}`, URL_OF_PAGE)).toStrictEqual([LIVE]);
        expect(servedForms(`${tagOf(MAX_TAG_ATTRIBUTES + 1)}${form}`, URL_OF_PAGE)).toStrictEqual([null]);

        // Repeats of one name are each looked up before the parser drops them.
        const repeatsOf = (count: number): string => `<div ${"a ".repeat(count)}></div>`;

        expect(servedForms(`${repeatsOf(MAX_TAG_ATTRIBUTES)}${form}`, URL_OF_PAGE)).toStrictEqual([LIVE]);
        expect(servedForms(`${repeatsOf(MAX_TAG_ATTRIBUTES + 1)}${form}`, URL_OF_PAGE)).toStrictEqual([null]);
    });

    it("resolves a form's own action once, however many submit buttons send it there", () => {
        const canParse = vi.spyOn(URL, "canParse");
        const buttons = "<button>Go</button>".repeat(1000);

        servedForms(`<form method="post" action="/session">${FIELDS}${buttons}</form>`, URL_OF_PAGE);

        expect(canParse.mock.calls.filter(([address]) => address === "/session")).toHaveLength(1);
        canParse.mockRestore();

        // Nor is its address cut at the fragment again for each button.
        const split = vi.spyOn(String.prototype, "split");

        servedForms(`<form method="post" action="/session#f">${FIELDS}${buttons}</form>`, URL_OF_PAGE);

        expect(split.mock.contexts.filter((text) => String(text).endsWith("/session#f"))).toHaveLength(1);
        split.mockRestore();
    });

    it("does not read a page whose actions, resolved against a long base, take past the parse budget", () => {
        const base = `<base href="https://id.example/${"a".repeat(1_000_000)}/">`;
        const forms = Array.from({ length: 20 }, (_, at) => `<form method="post" action="s${at}">${FIELDS}<button>Go</button></form>`).join("");

        expect(servedForms(`${base}${forms}`, URL_OF_PAGE)).toStrictEqual([null]);
        // An ordinary base and as many forms read as before.
        expect(servedForms(`<base href="https://id.example/a/">${forms}`, URL_OF_PAGE)).toHaveLength(20);
    });

    it("resolves against the first base address and takes the first base target", () => {
        const html = `<base target="_top"><base href="https://id.example/a/"><base href="https://other.example/"><form action="s">${FIELDS}</form>`;

        expect(servedForms(html, URL_OF_PAGE)).toStrictEqual([{ ...LIVE, action: "https://id.example/a/s", target: "_top" }]);
    });

    it("leaves out template contents and script text, and counts a field in no form", () => {
        const html = `<template><form action="/t"><input type="password" name="t"></form></template><noscript><form><input type="password"></form></noscript><input type="password" name="loose"><form action="/session?session_code=Kq7aB9xZ2mQ4">${FIELDS}</form>`;

        expect(servedForms(html, URL_OF_PAGE)).toStrictEqual([null, LIVE]);
    });

    it("sends a form with an empty action to the page's own address, whatever its base", () => {
        expect(servedForms(`<base href="/other/"><form action="">${FIELDS}<button formaction="">x</button></form>`, `${URL_OF_PAGE}#top`)).toStrictEqual([
            { ...LIVE, action: URL_OF_PAGE },
        ]);
    });

    it("takes a form attribute that names no form as no form", () => {
        expect(servedForms(`<div id="d"></div><form><input type="password" form="d"></form>`, URL_OF_PAGE)).toStrictEqual([null]);
    });
});

describe(servedTarget, () => {
    const served = servedForms(`<form method="post" action="/session?session_code=Kq7aB9xZ2mQ4">${FIELDS}</form>`, URL_OF_PAGE);

    it("accepts the form the site sent, with its own per-load code", () => {
        expect(servedTarget(served, LIVE)).toStrictEqual(LIVE);
    });

    it.each([
        ["a swapped code", { action: "https://id.example/session?session_code=Zp3cD8yW1nR5" }],
        ["another path", { action: "https://id.example/profile?session_code=Kq7aB9xZ2mQ4" }],
        ["another key", { action: "https://id.example/session?tenant=Kq7aB9xZ2mQ4" }],
        ["a renamed field", { name: "bio" }],
        ["another method", { method: "dialog" }],
        ["another encoding", { enctype: "multipart/form-data" }],
        ["another target", { target: "_top" }],
        ["another charset", { charset: "iso-8859-1" }],
    ])("refuses %s", (_what, change) => {
        expect(servedTarget(served, { ...LIVE, ...change })).toBeNull();
    });

    it("refuses every form of a page whose password fields the site sent to different places", () => {
        const two = servedForms(`<form action="/session">${FIELDS}</form><form action="/register"><input type="password" name="pw"></form>`, URL_OF_PAGE);

        expect(servedTarget(two, { ...LIVE, action: "https://id.example/register" })).toBeNull();
        expect(servedTarget(two, { ...LIVE, action: "https://id.example/session" })).toBeNull();
    });

    it("refuses a page with a password form whose submit buttons send it to different places, wherever that form is, and no other form", () => {
        const html = `<button form="f" formaction="/comments">x</button><form id="f" action="/session">${FIELDS}<button>Go</button></form>`;
        const later = servedForms(`<form action="/session">${FIELDS}</form>${html.replace(">x<", ">y<")}`, URL_OF_PAGE);
        const search = servedForms(
            `<form action="/search"><input name="q"><button>Go</button><button formaction="/advanced">More</button></form><form action="/session">${FIELDS}</form>`,
            URL_OF_PAGE,
        );
        const session = { ...LIVE, action: "https://id.example/session" };

        expect(servedForms(html, URL_OF_PAGE)).toStrictEqual([AMBIGUOUS]);
        expect(later).toStrictEqual([session, AMBIGUOUS]);
        expect(servedTarget(later, session)).toBeNull();
        expect(servedTarget(search, session)).toStrictEqual(session);
    });

    it("checks every one of a form's many submit buttons, the last included", () => {
        const buttons = "<button>Go</button>".repeat(20_000);
        const agreeing = servedForms(`<form action="/session">${FIELDS}${buttons}</form>`, URL_OF_PAGE);
        const lastDisagrees = servedForms(`<form action="/session">${FIELDS}${buttons}<button formaction="/comments">x</button></form>`, URL_OF_PAGE);

        expect(agreeing).toStrictEqual([{ ...LIVE, action: "https://id.example/session" }]);
        expect(lastDisagrees).toStrictEqual([AMBIGUOUS]);
    });

    it("accepts another password field of that same form, and refuses a page whose first one is in no form", () => {
        const trap = servedForms(`<form action="/session"><input type="password" name="trap"><input type="password" name="pw"></form>`, URL_OF_PAGE);
        const loose = servedForms(`<input type="password"><form action="/session">${FIELDS}</form>`, URL_OF_PAGE);
        const session = { ...LIVE, action: "https://id.example/session" };

        expect(servedTarget(trap, session)).toStrictEqual(session);
        expect(servedTarget(loose, session)).toBeNull();
    });

    it("refuses a form in a table, which the parser ties to its fields without holding them", () => {
        const table = servedForms(
            `<table><form action="/session"><tr><td>${FIELDS}</td></tr></form></table><form action="/comments"><input type="password" name="pw"></form>`,
            URL_OF_PAGE,
        );

        expect(table[0]).toBeNull();
        expect(servedTarget(table, { ...LIVE, action: "https://id.example/comments" })).toBeNull();
    });
});
