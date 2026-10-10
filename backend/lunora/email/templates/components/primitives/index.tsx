/**
 * The eleven react-email primitives our templates use, vendored.
 *
 * Ported verbatim from `@react-email/{body,button,container,head,heading,html,
 * img,link,preview,section,text}` (MIT, resend/react-email) — the rendered HTML
 * is byte-identical, which `email-render.test.ts` pins.
 *
 * WHY: npm deprecated every `@react-email/*` component package, the
 * `@react-email/components` barrel included, with "Package no longer supported"
 * and no successor — `react-email` itself is only the CLI/preview tool. So there
 * was no maintained package left to depend on, and importing eleven
 * unmaintained ones put eleven deprecation warnings on every install.
 *
 * `@react-email/render` is NOT deprecated and still renders them (through
 * `@lunora/mail`); only the element primitives are vendored. They are ~25 KB of table-based markup with
 * Outlook conditionals, and the email HTML they emit is the part that must not
 * drift — hence the byte-for-byte test rather than a visual check.
 */

/* eslint-disable perfectionist/sort-jsx-props, perfectionist/sort-objects, sonarjs/no-table-as-layout, react/no-danger --
   This module is a byte-for-byte port (see `email-render.test.ts`). JSX attribute order and CSS
   property order both reach the rendered HTML, so sorting either changes the output. Layout tables
   and the `mso-*` conditional comments are how HTML email works — Outlook cannot lay out without them. */
import type { ComponentPropsWithoutRef, CSSProperties, ReactNode } from "react";

import { computeMargins, parsePadding, pxToPt, SPACING_PROPERTIES } from "./spacing";

type WithChildren<T> = T & { children?: ReactNode };

/** `<html>`, defaulting to `lang="en" dir="ltr"`. */
export const Html = ({ children, dir: direction = "ltr", lang = "en", ...props }: WithChildren<ComponentPropsWithoutRef<"html">>) => (
    <html {...props} dir={direction} lang={lang}>
        {children}
    </html>
);

/** `<head>` with the charset and Apple reformatting-opt-out meta tags every client wants. */
export const Head = ({ children, ...props }: WithChildren<ComponentPropsWithoutRef<"head">>) => (
    <head {...props}>
        <meta content="text/html; charset=UTF-8" httpEquiv="Content-Type" />
        <meta name="x-apple-disable-message-reformatting" />
        {children}
    </head>
);

/**
 * `<body>` wrapping children in the centred presentation table clients need.
 *
 * The caller's `style` lands on the inner `<td>`, not on `<body>`: only
 * background and a ZEROED copy of any margin/padding it set go on the body, so
 * the spacing is applied once (by the td) rather than twice.
 */
export const Body = ({ children, style, ...props }: WithChildren<ComponentPropsWithoutRef<"body">>) => {
    const bodyStyle: CSSProperties = { background: style?.background, backgroundColor: style?.backgroundColor };

    if (style) {
        for (const property of SPACING_PROPERTIES) {
            (bodyStyle as Record<string, unknown>)[property] = (style as Record<string, unknown>)[property] === undefined ? undefined : 0;
        }
    }

    return (
        <body {...props} style={bodyStyle}>
            <table border={0} width="100%" cellPadding="0" cellSpacing="0" role="presentation" align="center">
                <tbody>
                    <tr>
                        <td style={style}>{children}</td>
                    </tr>
                </tbody>
            </table>
        </body>
    );
};

/** A max-width content table. */
export const Container = ({ children, style, ...props }: WithChildren<ComponentPropsWithoutRef<"table">>) => (
    <table align="center" width="100%" {...props} border={0} cellPadding="0" cellSpacing="0" role="presentation" style={{ maxWidth: "37.5em", ...style }}>
        <tbody>
            <tr style={{ width: "100%" }}>
                <td>{children}</td>
            </tr>
        </tbody>
    </table>
);

/** A full-width row table. */
export const Section = ({ children, style, ...props }: WithChildren<ComponentPropsWithoutRef<"table">>) => (
    <table align="center" width="100%" border={0} cellPadding="0" cellSpacing="0" role="presentation" {...props} style={style}>
        <tbody>
            <tr>
                <td>{children}</td>
            </tr>
        </tbody>
    </table>
);

/** `<h1>` by default; `as` picks another heading level. */
export const Heading = ({
    as: Tag = "h1",
    children,
    style,
    ...props
}: WithChildren<ComponentPropsWithoutRef<"h1"> & { as?: "h1" | "h2" | "h3" | "h4" | "h5" | "h6" }>) => (
    <Tag {...props} style={style}>
        {children}
    </Tag>
);

/**
 * `<p>` with react-email's default 14px/24px type and 16px vertical margins.
 *
 * The margins are recomputed and re-spread AFTER `style` on purpose: spreading a
 * shorthand over longhands would otherwise lose the caller's ordering.
 */
export const Text = ({ style, ...props }: ComponentPropsWithoutRef<"p">) => {
    const defaultMargins: CSSProperties = {};

    if (style?.marginTop === undefined) {
        defaultMargins.marginTop = "16px";
    }

    if (style?.marginBottom === undefined) {
        defaultMargins.marginBottom = "16px";
    }

    const margins = computeMargins({ ...defaultMargins, ...style });

    return <p {...props} style={{ fontSize: "14px", lineHeight: "24px", ...style, ...margins }} />;
};

/** `<a>` opening in a new tab, with react-email's default link colour. */
export const Link = ({ style, target = "_blank", ...props }: ComponentPropsWithoutRef<"a">) => (
    <a {...props} style={{ color: "#067df7", textDecorationLine: "none", ...style }} target={target}>
        {props.children}
    </a>
);

/** `<img>` with the resets that stop clients adding borders and underlines. */
export const Img = ({ alt, height, src, style, width, ...props }: ComponentPropsWithoutRef<"img">) => (
    <img
        {...props}
        alt={alt}
        height={height}
        src={src}
        style={{ display: "block", outline: "none", border: "none", textDecoration: "none", ...style }}
        width={width}
    />
);

const PREVIEW_MAX_LENGTH = 150;
const WHITE_SPACE_CODES = " ‌​‍‎‏﻿";

/** The hidden inbox preview line, padded so clients don't spill body copy into it. */
export const Preview = ({ children = "", ...props }: WithChildren<ComponentPropsWithoutRef<"div">>) => {
    const text = (Array.isArray(children) ? children.join("") : String(children)).slice(0, PREVIEW_MAX_LENGTH);

    return (
        <div style={{ display: "none", overflow: "hidden", lineHeight: "1px", opacity: 0, maxHeight: 0, maxWidth: 0 }} data-skip-in-text {...props}>
            {text}
            {text.length >= PREVIEW_MAX_LENGTH ? null : <div>{WHITE_SPACE_CODES.repeat(PREVIEW_MAX_LENGTH - text.length)}</div>}
        </div>
    );
};

const MAX_MSO_FONT_WIDTH = 5;

/**
 * Outlook cannot pad an anchor, so react-email fakes horizontal padding with
 * hair-space characters stretched by `mso-font-width`. This finds the smallest
 * space count whose required font-width stays within Outlook's limit.
 */
const computeFontWidthAndSpaceCount = (expectedWidth: number): [number, number] => {
    if (expectedWidth === 0) {
        return [0, 0];
    }

    let spaceCount = 0;
    const requiredFontWidth = () => (spaceCount > 0 ? expectedWidth / spaceCount / 2 : Infinity);

    while (requiredFontWidth() > MAX_MSO_FONT_WIDTH) {
        spaceCount += 1;
    }

    return [requiredFontWidth(), spaceCount];
};

/** A padded call-to-action anchor that survives Outlook. */
export const Button = ({ children, style, target = "_blank", ...props }: WithChildren<ComponentPropsWithoutRef<"a">>) => {
    const { bottom: paddingBottom, left: paddingLeft, right: paddingRight, top: paddingTop } = parsePadding(style ?? {});
    const textRaise = pxToPt((paddingTop ?? 0) + (paddingBottom ?? 0));
    const [leftFontWidth, leftSpaceCount] = computeFontWidthAndSpaceCount(paddingLeft ?? 0);
    const [rightFontWidth, rightSpaceCount] = computeFontWidthAndSpaceCount(paddingRight ?? 0);

    return (
        <a
            {...props}
            style={
                {
                    lineHeight: "100%",
                    textDecoration: "none",
                    display: "inline-block",
                    maxWidth: "100%",
                    msoPaddingAlt: "0px",
                    ...style,
                    paddingTop,
                    paddingRight,
                    paddingBottom,
                    paddingLeft,
                } as CSSProperties
            }
            target={target}
        >
            <span
                dangerouslySetInnerHTML={{
                    __html: `<!--[if mso]><i style="mso-font-width:${leftFontWidth * 100}%;mso-text-raise:${textRaise}" hidden>${"&#8202;".repeat(leftSpaceCount)}</i><![endif]-->`,
                }}
            />
            <span
                style={
                    {
                        maxWidth: "100%",
                        display: "inline-block",
                        lineHeight: "120%",
                        msoPaddingAlt: "0px",
                        msoTextRaise: pxToPt(paddingBottom),
                    } as CSSProperties
                }
            >
                {children}
            </span>
            <span
                dangerouslySetInnerHTML={{
                    __html: `<!--[if mso]><i style="mso-font-width:${rightFontWidth * 100}%" hidden>${"&#8202;".repeat(rightSpaceCount)}&#8203;</i><![endif]-->`,
                }}
            />
        </a>
    );
};
