// @vitest-environment jsdom

import { FetchableOriginsProvider } from "@ui/components/file-renderers/fetchable-origins-provider";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import { isFetchableUrl, originsOf } from "./use-fetchable-origins";
import { useFetchedText } from "./use-fetched-text";

const BACKEND = "https://api.example";

const Probe = ({ url }: { url: string }) => <output>{useFetchedText(url).status}</output>;

describe(originsOf, () => {
    it("keeps the origin of each http(s) URL once, and drops unset, malformed and other-scheme ones", () => {
        expect(originsOf(`${BACKEND}/path?x=1`, `${BACKEND}/other`, "http://localhost:8788", undefined, "", "not a url", "ftp://files.example")).toStrictEqual([
            BACKEND,
            "http://localhost:8788",
        ]);
    });
});

describe(isFetchableUrl, () => {
    afterEach(() => {
        vi.unstubAllGlobals();
    });

    const onPage = (origin: string) => vi.stubGlobal("location", { origin });

    it("allows the page's own non-loopback origin, and the configured origins", () => {
        onPage("https://app.example");

        expect(isFetchableUrl("https://app.example/a.pdf", [])).toBe(true);
        expect(isFetchableUrl(`${BACKEND}/files/a.pdf?sig=1`, originsOf(BACKEND))).toBe(true);
    });

    it.each(["http://localhost:5173", "http://127.0.0.1:5173", "http://[::1]:5173"])(
        "refuses the page's own loopback origin %s, which is not an approved origin",
        (origin) => {
            onPage(origin);

            expect(isFetchableUrl(`${origin}/a.pdf`, [])).toBe(false);
        },
    );

    it("allows a configured loopback backend, such as a local one in development", () => {
        onPage("http://localhost:5173");

        expect(isFetchableUrl("http://localhost:8788/files/a.pdf?sig=1", originsOf("http://localhost:8788"))).toBe(true);
    });

    it("refuses other origins, other schemes and loopback hosts that were not configured", () => {
        onPage("https://app.example");

        expect(isFetchableUrl("https://elsewhere.example/a.pdf", originsOf(BACKEND))).toBe(false);
        expect(isFetchableUrl("http://127.0.0.2:8788/a.pdf", originsOf(BACKEND))).toBe(false);
        expect(isFetchableUrl("ftp://app.example/a.pdf", [])).toBe(false);
    });

    it("still allows data: and blob: URLs", () => {
        onPage("http://localhost:5173");

        expect(isFetchableUrl("data:application/pdf;base64,AA==", [])).toBe(true);
        expect(isFetchableUrl("blob:http://localhost:5173/1", [])).toBe(true);
    });
});

describe("a preview's fetch", () => {
    afterEach(() => {
        vi.unstubAllGlobals();
        document.body.replaceChildren();
    });

    const render = async (withProvider: boolean) => {
        const fetchSpy = vi.fn(async () => new Response("ok"));

        vi.stubGlobal("fetch", fetchSpy);

        const container = document.createElement("div");

        document.body.append(container);

        const probe = <Probe url={`${BACKEND}/files/a.csv?sig=1`} />;

        await act(async () => {
            createRoot(container).render(withProvider ? <FetchableOriginsProvider origins={originsOf(BACKEND)}>{probe}</FetchableOriginsProvider> : probe);
        });

        return { fetchSpy, status: container.querySelector("output")?.textContent };
    };

    it("reads a backend-origin URL under the provider", async () => {
        const { fetchSpy, status } = await render(true);

        expect(fetchSpy).toHaveBeenCalledTimes(1);
        expect(status).toBe("ready");
    });

    it("refuses the same URL without one, making no request", async () => {
        const { fetchSpy, status } = await render(false);

        expect(fetchSpy).not.toHaveBeenCalled();
        expect(status).toBe("error");
    });
});
