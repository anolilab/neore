/**
 * Build-time OG image generator.
 *
 * Generates a static 1200×630 PNG at public/og.png using @vercel/og (Node.js
 * build, reads resvg.wasm from the filesystem — no Cloudflare Workers WASM
 * concerns). Runs before `vite build` so Vite copies the file to dist/client.
 *
 * Reads optional env vars:
 *   VITE_APP_TITLE  — app name shown in the image (default: "Neore Chat")
 *   VITE_SITE_URL   — used for the short URL in the footer
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

// ─── Fonts ───────────────────────────────────────────────────────────────────
// Read directly from the installed geist npm package — no network required.
const geistRegular = readFileSync(join(__dirname, "../node_modules/geist/dist/fonts/geist-sans/Geist-Regular.ttf"));
const geistBold = readFileSync(join(__dirname, "../node_modules/geist/dist/fonts/geist-sans/Geist-Bold.ttf"));

// ─── Config ──────────────────────────────────────────────────────────────────
const title = process.env.VITE_APP_TITLE ?? "Neore Chat";
const siteUrl = (process.env.VITE_SITE_URL ?? "").replace(/\/$/, "");
const shortUrl = siteUrl ? siteUrl.replace(/^https?:\/\//, "") : undefined;
const description = "Chat with Claude, GPT, Gemini and more — in one place. Organised conversations, document canvas, and deep research tools.";

// ─── Element tree ────────────────────────────────────────────────────────────
// Plain objects accepted by satori (via @vercel/og). No JSX required.
const element = {
    props: {
        children: [
            // Gradient — top-left purple
            {
                props: {
                    style: {
                        background: "radial-gradient(ellipse at top left, rgba(120, 80, 255, 0.18) 0%, transparent 60%)",
                        height: "100%",
                        inset: "0",
                        position: "absolute",
                        width: "100%",
                    },
                },
                type: "div",
            },
            // Gradient — bottom-right blue
            {
                props: {
                    style: {
                        background: "radial-gradient(ellipse at bottom right, rgba(60, 160, 255, 0.12) 0%, transparent 60%)",
                        height: "100%",
                        inset: "0",
                        position: "absolute",
                        width: "100%",
                    },
                },
                type: "div",
            },
            // Main content
            {
                props: {
                    children: [
                        // Badge
                        {
                            props: {
                                children: "AI Chat Platform",
                                style: {
                                    background: "rgba(255, 255, 255, 0.06)",
                                    border: "1px solid rgba(255, 255, 255, 0.12)",
                                    borderRadius: "100px",
                                    color: "rgba(255, 255, 255, 0.6)",
                                    display: "flex",
                                    fontSize: "14px",
                                    fontWeight: 400,
                                    letterSpacing: "0.06em",
                                    padding: "6px 16px",
                                    textTransform: "uppercase",
                                },
                            },
                            type: "div",
                        },
                        // Title
                        {
                            props: {
                                children: title,
                                style: {
                                    color: "#ffffff",
                                    fontSize: "68px",
                                    fontWeight: 700,
                                    letterSpacing: "-0.02em",
                                    lineHeight: 1.05,
                                },
                            },
                            type: "div",
                        },
                        // Description
                        {
                            props: {
                                children: description,
                                style: {
                                    color: "rgba(255, 255, 255, 0.55)",
                                    fontSize: "26px",
                                    fontWeight: 400,
                                    lineHeight: 1.5,
                                    maxWidth: "800px",
                                },
                            },
                            type: "div",
                        },
                    ],
                    style: {
                        display: "flex",
                        flex: "1",
                        flexDirection: "column",
                        gap: "20px",
                        justifyContent: "center",
                        position: "relative",
                    },
                },
                type: "div",
            },
            // Footer — short URL
            ...(shortUrl
                ? [
                      {
                          props: {
                              children: shortUrl,
                              style: {
                                  bottom: "50px",
                                  color: "rgba(255, 255, 255, 0.35)",
                                  fontSize: "18px",
                                  fontWeight: 400,
                                  letterSpacing: "0.02em",
                                  position: "absolute",
                                  right: "70px",
                              },
                          },
                          type: "div",
                      },
                  ]
                : []),
        ],
        style: {
            background: "#0a0a0a",
            display: "flex",
            flexDirection: "column",
            fontFamily: "'Geist', sans-serif",
            height: "100%",
            padding: "60px 70px",
            position: "relative",
            width: "100%",
        },
    },
    type: "div",
};

// ─── Generate ─────────────────────────────────────────────────────────────────
// Dynamic import so Node resolves @vercel/og's "node" export condition.
const { ImageResponse } = await import("@vercel/og");

const response = new ImageResponse(element, {
    debug: false,
    fonts: [
        { data: geistRegular.buffer, name: "Geist", style: "normal", weight: 400 },
        { data: geistBold.buffer, name: "Geist", style: "normal", weight: 700 },
    ],
    height: 630,
    width: 1200,
});

const buffer = Buffer.from(await response.arrayBuffer());
const outputPath = join(__dirname, "../public/og.png");

mkdirSync(dirname(outputPath), { recursive: true });
writeFileSync(outputPath, buffer);

console.log(`✓ OG image written to public/og.png (${(buffer.length / 1024).toFixed(1)} kB)`);
