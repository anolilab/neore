# Auto Media Enrichment & Inline Widgets: Implementation Plan

**Date:** 2026-03-05

---

## Feature A: Auto Media Enrichment

**Goal:** Automatically inject image and video search alongside text responses when relevant, controlled by a per-user toggle in settings.

### Current State

- `imageSearchTool` (`backend/lunora/chat/tools/image-search.ts`) and `videoSearchTool` (`backend/lunora/chat/tools/video-search.ts`) exist and work.
- They are in `SEARCH_MODE_TOOLS` (`backend/lunora/chat/lib/tool-builder.ts`) for the web search mode only.
- The per-user preference `autoMediaEnrichment` is in `aiUserPreferences` (`backend/lunora/schema.ts`), and the settings toggle exists: "Auto Media Enrichment" in `apps/web/src/features/settings/components/chat/agent-settings.tsx`.
- `getToolsForModelAndMode` in `tool-builder.ts` takes `options.autoMediaEnrichment` and adds ImageSearch and VideoSearch when the search mode is not `chat`.
- The preference is read in `backend/lunora/chat/execute.ts` and passed through `buildAgentTools` (`backend/lunora/chat/lib/agent-tools.ts`).
- Not built: a composer indicator (A.5). Nothing in `apps/web/src/features/chat/` shows that enrichment is on.

### Architecture

When `autoMediaEnrichment` is on, ImageSearch and VideoSearch are added to the tool set for every search mode, not only web search. The model decides from context whether to call them.

### Implementation

#### A.1 `autoMediaEnrichment` on user preferences (done)

`autoMediaEnrichment` is an optional boolean on `aiUserPreferences`. Absent means off.

#### A.2 `getToolsForModelAndMode` (done)

`tool-builder.ts` adds ImageSearch and VideoSearch when `options.autoMediaEnrichment` is set and the search mode is not `chat`, and skips a tool that is already present.

**Key decision:** only for search modes. In pure chat mode there is no web context to enrich.

#### A.3 Pass the preference through the streaming pipeline (done)

`backend/lunora/chat/execute.ts` reads the preference and passes it to `buildAgentTools`, which passes it to `getToolsForModelAndMode`. The non-streaming path in `backend/lunora/chat/http.ts` should be checked for the same option. It is not verified in this pass.

#### A.4 Settings toggle (done)

The toggle is in `agent-settings.tsx`, with the label "Auto Media Enrichment" and the helper text that explains it applies to search modes.

#### A.5 Composer indicator (open)

When `autoMediaEnrichment` is on and a search mode is active, show a small media indicator next to the search mode selector (`apps/web/src/features/chat/thread/composer-search-mode.tsx` is the place to add it). The indicator reads the same preference the settings toggle writes.

### Effort: Low (1 day for A.5)
### Risk: Very low. It is purely additive, and the model decides when to use the tools.

---

## Feature B: Inline Widgets

**Goal:** Render rich inline widgets for weather, map/places, and calculator tool results instead of raw JSON.

### Current State

- **Weather tool**: `backend/lunora/chat/tools/weather.ts`. Returns location, current conditions, air quality and a multi-day forecast.
- **Map tools**: `backend/lunora/chat/tools/map-tools.ts`. `findPlaceTool` returns geocoding results; `nearbyPlacesSearchTool` returns places with ratings, distance, photos and open status.
- **Calculator**: no dedicated tool. Math goes through the `codeExecution` tool.
- **Widget registry**: `apps/web/src/features/chat/thread/widgets/index.tsx` maps tool names to lazy-loaded widgets. Every widget is code-split with `lazy()` and wrapped in `Suspense`.
- **Existing widgets** in `apps/web/src/features/chat/thread/widgets/`: `weather-widget.tsx`, `places-widget.tsx` (exports `FindPlaceWidget` and `NearbyPlacesWidget`), `widget-skeleton.tsx`, plus currency, crypto, flight, stock, wolfram, web search, image search, video search and generative UI widgets.
- Tools with no registered widget fall back to the default tool call view.

### Implementation

#### B.1 Weather Widget (done)

`weather-widget.tsx` is registered under the `weather` tool name.

Layout the widget follows:
- Location name and country flag emoji
- Current temperature (large) and a weather icon
- Feels-like, humidity and wind speed in a row
- Air quality badge, colour-coded (Good = green, Fair = yellow, and so on), with the label as text
- Forecast as a horizontal scroll of mini cards (day, icon, temperature)
- Units display (°C or °F)

**Design:**
- Card with rounded corners and a subtle border
- Background tint by condition (sunny = warm, cloudy = grey, rain = blue-grey)
- `max-w-sm` to stay compact inline
- Stacks vertically on mobile

#### B.2 Map/Places Widget (done)

`places-widget.tsx` exports `FindPlaceWidget` (for `findPlace`) and `NearbyPlacesWidget` (for `nearbyPlacesSearch`). Both are registered in `widgets/index.tsx`.

**For `findPlace` results:** show the address and coordinates, with a link to Google Maps. Keep the map as a link or a static image, not an embedded iframe (see decision 4).

**For `nearbyPlacesSearch` results:**
- List of place cards (up to 5 shown, expandable)
- Each card: name, rating (stars), distance, open/closed badge, type tags
- Photo thumbnail when one is available
- "View on Google Maps" link per place

#### B.3 Calculator Result Enhancement (open)

For calculator-style `codeExecution` results (a single number or short string from a simple expression), show a compact "= result" badge instead of the full code block. Otherwise keep the existing code execution view. This is a change to the existing code-execution renderer, not a new widget.

#### B.4 Widget Registration (done)

Widgets register in the tool widget registry in `widgets/index.tsx`, which the chat UI receives as the `toolWidgets` prop. Do not add a per-tool branch in `message-content.tsx`; the registry is the one place to add a widget.

#### B.5 Loading States (open)

`widget-skeleton.tsx` exists, but no caller outside itself was found, so the running state of a widget tool is not yet wired to it. Wire it for the `input-available` (running) state of the weather and places tools:
- Weather: skeleton with a temperature placeholder and a forecast row
- Places: skeleton with a list placeholder
- Use a simple shimmer

#### B.6 Lazy Loading (done)

Every widget in `widgets/index.tsx` is loaded with `lazy()`, so the widget code stays out of the initial chat bundle.

### File Structure

```
apps/web/src/features/chat/thread/widgets/
├── index.tsx                  # Tool name → widget registry (lazy)
├── weather-widget.tsx         # Weather card with forecast
├── places-widget.tsx          # Find place + nearby places cards
└── widget-skeleton.tsx        # Shared loading skeleton
```

### Effort: Low for what remains (B.3, and checking B.5 for the places and weather states)
### Risk: Low. It is purely UI, and no backend tool changes are needed.

---

## Implementation Order (Remaining)

| Phase | Feature | Days | Status |
|-------|---------|------|--------|
| 1 | Auto Media composer indicator (A.5) | 0.5 | Open |
| 2 | Calculator result badge (B.3) | 0.5 | Open |
| 3 | Loading skeletons for weather and places (B.5) | 0.5 | Open |

Features A and B are independent.

---

## Key Design Decisions

1. **Auto media is opt-in** (default: off) to avoid surprising users with extra API calls and slower responses.
2. **Auto media only in search modes**. In pure "chat" mode there is no web context to enrich.
3. **Weather widget uses OpenWeather's icon service** for condition icons.
4. **Places widget avoids embedded Google Maps iframes** for privacy. It uses a static map image or a "View on Maps" link.
5. **Widgets are code-split** to keep them out of the initial chat bundle.
6. **No new backend tools are needed** for the widgets. This is frontend rendering, plus the one preference flag that already exists.
