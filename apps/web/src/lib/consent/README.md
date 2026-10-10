# Consent Management for TanStack Start

This directory contains the consent management system migrated from Next.js to work with TanStack Start.

## Overview

The consent management system automatically detects user location and jurisdiction requirements server-side using TanStack Start's `createIsomorphicFn` and provides appropriate consent banners based on privacy regulations (GDPR, PIPEDA, etc.).

## Files

### `show-banner.ts`

Contains the core logic for:

- Detecting user location from request headers
- Mapping countries to privacy jurisdictions
- Determining consent requirements
- Language preference detection

### `../providers/consent-manager.tsx`

TanStack Start-compatible provider that:

- Uses server-side functions to detect user location
- Integrates with `@c15t/react` consent management
- Provides initial data to the client-side consent system

## Usage

The system is already integrated into the root component (`src/routes/__root.tsx`):

```tsx
import { ConsentManagerDialog, CookieBanner } from "@c15t/react";

import { ConsentManagerProvider } from "@/providers/consent-manager";

// In your root component
<ConsentManagerProvider
    options={{
        mode: "offline",
        store: {
            initialGdprTypes: ["measurement", "necessary"],
        },
    }}
>
    <CookieBanner />
    <ConsentManagerDialog />
    {/* Your app content */}
</ConsentManagerProvider>;
```

## Key Features

1. **Automatic Location Detection**: Uses various hosting provider headers (Cloudflare, Vercel, etc.)
2. **Jurisdiction Mapping**: Supports GDPR, PIPEDA, LGPD, and other privacy frameworks
3. **Server-Side Processing**: Initial consent determination happens server-side for better performance
4. **Language Detection**: Automatically detects user's preferred language for consent UI
5. **TanStack Start Integration**: Uses `createIsomorphicFn` for seamless server/client coordination

## Supported Headers

The system checks for location information in these headers:

- `cf-ipcountry` (Cloudflare)
- `x-vercel-ip-country` (Vercel)
- `x-amz-cf-ipcountry` (AWS CloudFront)
- `x-country-code` (Generic)
- `x-vercel-ip-country-region` (Vercel region)
- `x-region-code` (Generic region)
- `accept-language` (Browser language preferences)

## Jurisdiction Support

- **GDPR**: EU countries + EEA + UK
- **PIPEDA**: Canada
- **LGPD**: Brazil
- **Swiss Data Protection**: Switzerland
- **Privacy Act**: Australia
- **APPI**: Japan
- **PIPA**: South Korea

## Migration Notes

This system replaces the Next.js `headers()` function with TanStack Start's `getHeaders()` and uses `createIsomorphicFn` for server/client coordination. The core logic remains the same but is adapted for TanStack Start's architecture.

### Key Differences from Next.js

1. **Headers Format**: TanStack Start's `getHeaders()` returns a plain object `Record<string, string | undefined>` instead of a Headers instance
2. **Server Functions**: Uses `createIsomorphicFn` instead of Next.js server actions
3. **Header Access**: Direct property access (`headers[headerName]`) instead of method calls (`headers.get(headerName)`)

### Troubleshooting

**Error: "headers.get is not a function"**

- Ensure you're using the TanStack Start version of the consent manager provider from `src/providers/consent-manager.tsx` instead of the Next.js version.

**Error: "Cannot destructure property 'translations' of 'data' as it is undefined"**

- This was fixed by ensuring the server function always returns a valid data structure, even when no location headers are present (like in development/localhost).
- The system now provides fallback data instead of returning `undefined`.

**Development/Localhost Behavior**

- When running locally without location headers, the system defaults to showing consent banners with English translations and "NONE" jurisdiction.
- Check the browser console for debug logs showing which headers were detected.
