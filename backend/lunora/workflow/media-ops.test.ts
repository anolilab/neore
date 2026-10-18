import { afterEach, describe, expect, it, vi } from "vitest";

import { EXTRACT_DEADLINE_MS, extractFrameImage, FRAME_EXTRACT_ENDPOINT, FRAME_MAX_BYTES } from "./media-ops";

const QUEUE = `https://queue.fal.run/${FRAME_EXTRACT_ENDPOINT}`;
const json = (body: unknown, status = 200) => Response.json(body, { status });

// The leading bytes each stored type is sniffed by; the rest is filler.
const JPEG_BYTES = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]);
const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2]);
const WEBP_BYTES = new Uint8Array([0x52, 0x49, 0x46, 0x46, 4, 0, 0, 0, 0x57, 0x45, 0x42, 0x50, 1, 2]);
const MIB = 1024 * 1024;

/** A fake fal queue: submit, then one status poll that is COMPLETED, then the result, then the image. */
const falQueue = (overrides: { download?: Response; images?: unknown; status?: unknown; statusResponse?: Response; submit?: Response } = {}) => {
    const calls: { init?: RequestInit; url: string }[] = [];
    const fake = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);

        calls.push({ init, url });

        if (url === QUEUE) {
            return overrides.submit ?? json({ response_url: "https://queue.fal.run/r/result", status_url: "https://queue.fal.run/r/status" });
        }

        if (url.endsWith("/status")) {
            return overrides.statusResponse ?? json(overrides.status ?? { status: "COMPLETED" });
        }

        if (url.endsWith("/result")) {
            return json({ images: overrides.images ?? [{ content_type: "image/jpeg", url: "https://v3.fal.media/frame.jpg" }] });
        }

        return overrides.download ?? new Response(JPEG_BYTES, { headers: { "content-type": "image/jpeg" } });
    });

    vi.stubGlobal("fetch", fake);

    return { calls, fake };
};

afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
});

describe("extractFrameImage", () => {
    it("submits once, asks for the last frame of an end wire, and returns the frame's bytes with its type", async () => {
        const { calls, fake } = falQueue();
        const frame = await extractFrameImage("https://x.example/clip.mp4", "end", "key-1", 0);

        expect(fake.mock.calls.filter(([input]) => String(input) === QUEUE)).toHaveLength(1);
        expect(JSON.parse(String(calls[0]?.init?.body))).toStrictEqual({ frame_type: "last", video_url: "https://x.example/clip.mp4" });
        expect((calls[0]?.init?.headers as Record<string, string>).Authorization).toBe("Key key-1");
        expect(frame.type).toBe("image/jpeg");
        expect(frame.size).toBe(JPEG_BYTES.byteLength);
    });

    it("gives every request a deadline, so a stalled fal call cannot hold the run", async () => {
        const { calls } = falQueue();

        await extractFrameImage("https://x.example/clip.mp4", "start", "key-1", 0);

        expect(calls.length).toBeGreaterThan(1);

        for (const call of calls) {
            expect(call.init?.signal).toBeInstanceOf(AbortSignal);
        }
    });

    it("polls until the request completes, then fetches the result", async () => {
        const statuses = [{ status: "IN_QUEUE" }, { status: "IN_PROGRESS" }, { status: "COMPLETED" }];
        const fake = vi.fn(async (input: RequestInfo | URL) => {
            const url = String(input);

            if (url === QUEUE) {
                return json({ response_url: "https://queue.fal.run/r/result", status_url: "https://queue.fal.run/r/status" });
            }

            if (url.endsWith("/status")) {
                return json(statuses.shift());
            }

            if (url.endsWith("/result")) {
                return json({ images: [{ content_type: "image/png", url: "https://v3.fal.media/frame.png" }] });
            }

            return new Response(PNG_BYTES);
        });

        vi.stubGlobal("fetch", fake);
        await extractFrameImage("https://x.example/clip.mp4", "start", "key-1", 0);

        expect(fake.mock.calls.filter(([input]) => String(input).endsWith("/status"))).toHaveLength(3);
    });

    it("reports the submit only once fal has accepted it, so a refused submit is not billed", async () => {
        const accepted = vi.fn();

        falQueue();
        await extractFrameImage("https://x.example/clip.mp4", "start", "key-1", 0, accepted);
        expect(accepted).toHaveBeenCalledTimes(1);

        falQueue({ submit: new Response("no credit", { status: 403, statusText: "Forbidden" }) });
        const refused = vi.fn();

        await expect(extractFrameImage("https://x.example/clip.mp4", "start", "key-1", 0, refused)).rejects.toThrow("403");
        expect(refused).not.toHaveBeenCalled();
    });

    it("reports a submit that is then followed by a failed poll, since fal has billed it", async () => {
        falQueue({ status: { error: "bad video", status: "FAILED" } });
        const accepted = vi.fn();

        await expect(extractFrameImage("https://x.example/clip.mp4", "end", "key-1", 0, accepted)).rejects.toThrow("bad video");
        expect(accepted).toHaveBeenCalledTimes(1);
    });

    it("throws on a rejected submit without submitting again", async () => {
        const { fake } = falQueue({ submit: new Response("no credit", { status: 403, statusText: "Forbidden" }) });

        await expect(extractFrameImage("https://x.example/clip.mp4", "start", "key-1", 0)).rejects.toThrow("fal.ai frame extraction failed: 403 Forbidden");
        expect(fake.mock.calls.filter(([input]) => String(input) === QUEUE)).toHaveLength(1);
    });

    it("throws when fal reports the request failed, and does not resubmit it", async () => {
        const { fake } = falQueue({ status: { error: "bad video", status: "FAILED" } });

        await expect(extractFrameImage("https://x.example/clip.mp4", "end", "key-1", 0)).rejects.toThrow("fal.ai frame extraction failed: bad video");
        expect(fake.mock.calls.filter(([input]) => String(input) === QUEUE)).toHaveLength(1);
    });

    it("throws when the completed result carries no frame", async () => {
        falQueue({ images: [] });

        await expect(extractFrameImage("https://x.example/clip.mp4", "end", "key-1", 0)).rejects.toThrow("returned no frame image");
    });

    it("never sends the key to a status or result URL off the queue host, and sends nothing to it", async () => {
        const offHost = falQueue({ submit: json({ response_url: "https://queue.fal.run/r/result", status_url: "https://evil.example/status" }) });

        await expect(extractFrameImage("https://x.example/clip.mp4", "start", "key-1", 0)).rejects.toThrow("status URL outside queue.fal.run");
        expect(offHost.fake.mock.calls.some(([input]) => String(input).includes("evil.example"))).toBe(false);

        const resultOff = falQueue({
            submit: json({ response_url: "https://queue.fal.run.evil.example/r/result", status_url: "https://queue.fal.run/r/status" }),
        });

        await expect(extractFrameImage("https://x.example/clip.mp4", "start", "key-1", 0)).rejects.toThrow("result URL outside queue.fal.run");
        expect(resultOff.fake.mock.calls.some(([input]) => String(input).includes("evil.example"))).toBe(false);
        expect(resultOff.fake.mock.calls).toHaveLength(1);
    });

    it("refuses a malformed status URL before any keyed request", async () => {
        const { fake } = falQueue({ submit: json({ response_url: "https://queue.fal.run/r/result", status_url: "not a url" }) });

        await expect(extractFrameImage("https://x.example/clip.mp4", "start", "key-1", 0)).rejects.toThrow("outside queue.fal.run");
        expect(fake.mock.calls).toHaveLength(1);
    });

    it("gives up at the extraction deadline, and polls no more than that window allows", async () => {
        vi.useFakeTimers();

        const fake = vi.fn(async (input: RequestInfo | URL) => {
            if (String(input) === QUEUE) {
                return json({ response_url: "https://queue.fal.run/r/result", status_url: "https://queue.fal.run/r/status" });
            }

            return json({ status: "IN_QUEUE" });
        });

        vi.stubGlobal("fetch", fake);

        const outcome = extractFrameImage("https://x.example/clip.mp4", "end", "key-1", 1000)
            .then(() => undefined)
            .catch((error: unknown) => error);

        await vi.advanceTimersByTimeAsync(EXTRACT_DEADLINE_MS + 60_000);

        const error = await outcome;
        const polls = fake.mock.calls.filter(([input]) => String(input).endsWith("/status")).length;

        expect(error).toBeInstanceOf(Error);
        expect((error as Error).message).toBe("fal.ai frame extraction timed out");
        expect(polls).toBeGreaterThan(0);
        expect(polls).toBeLessThanOrEqual(EXTRACT_DEADLINE_MS / 1000 + 1);
    });

    it("refuses a redirect on every request that carries the key, so a 3xx never sends the key onward", async () => {
        const redirect = new Response(null, { headers: { Location: "https://attacker.example/collect" }, status: 302 });
        const { calls, fake } = falQueue({ statusResponse: redirect });

        await expect(extractFrameImage("https://x.example/clip.mp4", "start", "key-1", 0)).rejects.toThrow("fal.ai frame status failed: 302");

        const keyed = calls.filter((call) => call.url !== "https://v3.fal.media/frame.jpg");

        expect(keyed.map((call) => call.url)).toStrictEqual([QUEUE, "https://queue.fal.run/r/status"]);

        for (const call of keyed) {
            expect(call.init?.redirect).toBe("error");
        }

        expect(fake.mock.calls.some(([input]) => String(input).includes("attacker.example"))).toBe(false);
    });

    it("fetches the frame only from fal's media host, and charges the submit before refusing any other", async () => {
        // Plain http on fal's own host: the scheme is what is refused, so it is built with the protocol switched.
        const plainHttp = new URL("https://v3.fal.media/frame.jpg");

        plainHttp.protocol = "http:";

        for (const url of ["https://evil.example/frame.jpg", plainHttp.href, "https://fal.media.evil.example/frame.jpg", "https://evilfal.media/frame.jpg"]) {
            const { fake } = falQueue({ images: [{ content_type: "image/jpeg", url }] });
            const accepted = vi.fn();

            await expect(extractFrameImage("https://x.example/clip.mp4", "end", "key-1", 0, accepted)).rejects.toThrow("outside fal.media");
            expect(accepted).toHaveBeenCalledTimes(1);
            expect(fake.mock.calls.some(([input]) => String(input) === url)).toBe(false);
        }
    });

    it("downloads the frame from fal's media host with no key and no redirect", async () => {
        const { calls } = falQueue({
            download: new Response(PNG_BYTES),
            images: [{ content_type: "image/png", url: "https://v3.fal.media/files/frame.png" }],
        });

        await extractFrameImage("https://x.example/clip.mp4", "start", "key-1", 0);

        const download = calls.find((call) => call.url === "https://v3.fal.media/files/frame.png");

        expect(download?.init?.redirect).toBe("error");
        expect((download?.init?.headers as Record<string, string> | undefined)?.Authorization).toBeUndefined();
    });

    it("does not follow a redirect on the frame download, so a 3xx to another host is never requested", async () => {
        const redirect = new Response(null, { headers: { Location: "https://attacker.example/frame.jpg" }, status: 302 });
        const { fake } = falQueue({ download: redirect });

        await expect(extractFrameImage("https://x.example/clip.mp4", "start", "key-1", 0)).rejects.toThrow("Frame download failed: 302");
        expect(fake.mock.calls.some(([input]) => String(input).includes("attacker.example"))).toBe(false);
    });

    it.each([
        ["image/jpeg", JPEG_BYTES],
        ["image/png", PNG_BYTES],
        ["image/webp", WEBP_BYTES],
    ])("stores a %s frame whose leading bytes match its declared type", async (type, bytes) => {
        falQueue({ download: new Response(bytes), images: [{ content_type: type, url: "https://v3.fal.media/frame" }] });

        const frame = await extractFrameImage("https://x.example/clip.mp4", "start", "key-1", 0);

        expect(frame.type).toBe(type);
        expect(new Uint8Array(await frame.arrayBuffer())).toStrictEqual(bytes);
    });

    it("refuses a declared length over the cap before reading any of the body", async () => {
        const download = new Response(JPEG_BYTES, { headers: { "content-length": String(FRAME_MAX_BYTES + 1) } });

        falQueue({ download, images: [{ content_type: "image/jpeg", url: "https://v3.fal.media/frame.jpg" }] });

        await expect(extractFrameImage("https://x.example/clip.mp4", "start", "key-1", 0)).rejects.toThrow("exceeds");
        expect(download.bodyUsed).toBe(true);
    });

    it("cuts off an undeclared-length body once it passes the cap, and cancels it", async () => {
        let cancelled = false;
        let sent = 0;
        // An endless frame with no declared length: only the stream can say it is too large, and the cap must cut it off.
        const chunk = new Uint8Array(MIB);

        chunk.set(JPEG_BYTES);

        const stream = new ReadableStream<Uint8Array>({
            cancel() {
                cancelled = true;
            },
            pull(controller) {
                sent += 1;
                controller.enqueue(chunk);
            },
        });

        falQueue({ download: new Response(stream), images: [{ content_type: "image/jpeg", url: "https://v3.fal.media/frame.jpg" }] });

        await expect(extractFrameImage("https://x.example/clip.mp4", "start", "key-1", 0)).rejects.toThrow("exceeds");
        expect(cancelled).toBe(true);
        // The cap is 20 MiB, so the read stops at the 21st one-MiB chunk, not after the stream is drained.
        expect(sent).toBeLessThanOrEqual(22);
    });

    it("refuses a declared type that is not a still image, and downloads nothing", async () => {
        const { fake } = falQueue({ images: [{ content_type: "image/gif", url: "https://v3.fal.media/frame.gif" }] });

        await expect(extractFrameImage("https://x.example/clip.mp4", "start", "key-1", 0)).rejects.toThrow("only JPEG, PNG and WebP");
        expect(fake.mock.calls.some(([input]) => String(input) === "https://v3.fal.media/frame.gif")).toBe(false);
    });

    it("refuses a frame whose leading bytes are not the type it declared", async () => {
        falQueue({ download: new Response(JPEG_BYTES), images: [{ content_type: "image/png", url: "https://v3.fal.media/frame.png" }] });

        await expect(extractFrameImage("https://x.example/clip.mp4", "start", "key-1", 0)).rejects.toThrow("do not match the declared type image/png");
    });

    it("stores a frame fal leaves untyped as the PNG its download says it is", async () => {
        falQueue({ download: new Response(PNG_BYTES, { headers: { "content-type": "image/png" } }), images: [{ url: "https://v3.fal.media/frame" }] });

        const frame = await extractFrameImage("https://x.example/clip.mp4", "start", "key-1", 0);

        expect(frame.type).toBe("image/png");
    });

    it("refuses a frame with no usable type from fal or its download", async () => {
        const download = new Response(JPEG_BYTES, { headers: { "content-type": "application/octet-stream" } });

        falQueue({ download, images: [{ url: "https://v3.fal.media/frame" }] });

        await expect(extractFrameImage("https://x.example/clip.mp4", "start", "key-1", 0)).rejects.toThrow("only JPEG, PNG and WebP");
        expect(download.bodyUsed).toBe(true);
    });
});
