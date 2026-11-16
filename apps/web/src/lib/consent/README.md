# Consent Management

Cookie and analytics consent for the web app, on c15t 3.

## Live setup

- `src/routes/__root.tsx` mounts c15t's `ConsentProvider`, `ConsentBanner` and `ConsentDialog`.
- Mode:
    - `local()` (the default): the policy is resolved in the browser, with no geolocation, so every visitor counts as
      an unknown location and is asked to opt in.
    - `hosted({ backendURL })`: used when `VITE_C15T_MODE=c15t`. It needs `VITE_C15T_BACKEND_URL`; env validation
      (`src/lib/env.ts`) refuses the mode without it.
- `PostHogConsentSync` (`src/providers/analytics-provider.tsx`) follows the effective `measurement` permission. A
  state that arrives before PostHog has loaded is applied from its `loaded` callback (`onPostHogLoaded`).
- The settings "Manage Consent Preferences" button opens the same dialog through `useSetActiveUI`.
- The stock components render their own styles, so `styles.css` does not import c15t's stylesheet.

### Upgrading from c15t 2

c15t 3 reads the same `c15t` cookie and storage key. A stored v2 grant was given under v2's offline policy, which
v3 treats as changed, so a returning visitor who accepted is asked once more. A stored rejection is kept.

## `show-banner.ts` (not wired in)

A server-side helper from the earlier setup, kept for a hosted or server-rendered banner. Nothing imports it today.
It reads the visitor's country from hosting headers (`cf-ipcountry`, `x-vercel-ip-country`, `x-amz-cf-ipcountry`,
`x-country-code`, and the region headers), maps it to a jurisdiction (GDPR for the EU, EEA and UK; PIPEDA, LGPD,
the Swiss and Australian acts, APPI, PIPA), and picks the banner language from `accept-language` with
`@c15t/translations`. Without location headers (local development) it falls back to English and the `NONE`
jurisdiction.
