import { describe, expect, it } from "vitest";

import type { FormTarget } from "./served-form";
import { AMBIGUOUS, servedForms, servedTarget } from "./served-form";

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

    it("refuses a page with a form whose submit buttons send it to different places, wherever that form is", () => {
        const html = `<button form="f" formaction="/comments">x</button><form id="f" action="/session">${FIELDS}<button>Go</button></form>`;
        const later = servedForms(`<form action="/session">${FIELDS}</form>${html.replace(">x<", ">y<")}`, URL_OF_PAGE);

        expect(servedForms(html, URL_OF_PAGE)).toStrictEqual([AMBIGUOUS]);
        expect(later).toStrictEqual([{ ...LIVE, action: "https://id.example/session" }, AMBIGUOUS]);
        expect(servedTarget(later, { ...LIVE, action: "https://id.example/session" })).toBeNull();
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
