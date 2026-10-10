import { Body, Container, Head, Html, Img, Link, Preview, Text } from "./primitives";
import type { ReactNode } from "react";
import { Fragment } from "react";

import { styles } from "./styles";

export interface BaseEmailProperties {
    brandLogoUrl?: string;
    brandName?: string;
    brandTagline?: string;
    children: ReactNode;
    footerLinks?: { href: string; text: string }[];
    footerText?: string;
    previewText: string;
}

/** Hoisted so the default prop is referentially stable across renders. */
const NO_FOOTER_LINKS: { href: string; text: string }[] = [];

export const BaseEmail = ({
    brandLogoUrl,
    brandName = "Better Auth",
    brandTagline = "Simple, secure authentication for your applications",
    children,
    footerLinks = NO_FOOTER_LINKS,
    footerText,
    previewText,
}: BaseEmailProperties) => (
    <Html>
        <Head />
        <Body style={styles.main}>
            <Preview>{previewText}</Preview>
            <Container style={styles.container}>
                {children}

                {brandLogoUrl && <Img alt={`${brandName} Logo`} height="32" src={brandLogoUrl} width="32" />}

                <Text style={styles.footer}>
                    {footerLinks.map((link, index) => (
                        <Fragment key={link.href}>
                            <Link href={link.href} style={{ ...styles.link, color: "#898989" }} target="_blank">
                                {link.text}
                            </Link>
                            {index < footerLinks.length - 1 && " • "}
                        </Fragment>
                    ))}
                    {footerLinks.length > 0 && <br />}
                    {footerText || (
                        <>
                            {brandName},{brandTagline.toLowerCase()}
                        </>
                    )}
                </Text>
            </Container>
        </Body>
    </Html>
);
