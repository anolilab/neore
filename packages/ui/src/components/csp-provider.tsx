"use client";

import { CSPProvider as BaseCSPProvider } from "@base-ui/react/csp-provider";
import type * as React from "react";

interface CSPProviderProps {
    children: React.ReactNode;

    /**
     * Whether inline `<style>` elements created by Base UI components should not be rendered.
     * When enabled, you must provide the CSS styles via external stylesheets instead.
     * @default false
     */
    disableStyleElements?: boolean;

    /**
     * The nonce value to apply to inline `<style>` and `<script>` tags.
     * Required when enforcing a strict Content Security Policy.
     */
    nonce?: string;
}

/**
 * CSPProvider configures Content Security Policy behavior for Base UI components
 * that render inline `<style>` or `<script>` tags.
 *
 * Under a strict CSP, inline tags may be blocked unless they include a matching nonce.
 * This provider allows configuring this behavior globally.
 * @example
 * ```tsx
 * // With nonce for strict CSP
 * <CSPProvider nonce={serverNonce}>
 *   <App />
 * </CSPProvider>
 * ```
 * @example
 * ```tsx
 * // Disable inline styles entirely (use external CSS instead)
 * <CSPProvider disableStyleElements>
 *   <App />
 * </CSPProvider>
 * ```
 */
const CSPProvider: React.FC<CSPProviderProps> = ({ children, disableStyleElements = false, nonce }) => (
    <BaseCSPProvider disableStyleElements={disableStyleElements} nonce={nonce}>
        {children}
    </BaseCSPProvider>
);

export { CSPProvider, type CSPProviderProps };
