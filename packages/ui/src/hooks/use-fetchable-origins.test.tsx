// @vitest-environment jsdom

import { FetchableOriginsProvider } from "@ui/components/file-renderers/fetchable-origins-provider";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import { originsOf } from "./use-fetchable-origins";
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
