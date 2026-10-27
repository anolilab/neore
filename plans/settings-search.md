# Settings search

Status: plan, 2026-10-26. Part of [agent-host-roadmap.md](agent-host-roadmap.md).
Small, independent. One PR for S1 and one for S2.

## 1. Goal and decision

A user types a word in the settings modal and reaches the setting, without knowing
which tab holds it.

Decisions:

- **Client-side only.** The index is built in the browser from the modal's own
  definitions. No backend call, no stored index, no analytics on queries.
- **Translated text.** Labels are translated at render time, so the index is built
  from the translated strings the user sees, and a search works in every locale.
- **Two levels.** Tabs are searchable from the navigation data. Individual settings
  inside a tab are searchable from a keyword list each tab declares next to its
  component.

## 2. Current state (checked)

- The settings modal is `apps/web/src/components/settings/settings-modal.tsx`
  (563 lines). The tab type is `SettingsTab`, a union of 20 values.
- The navigation is data: a list of `SettingsNavItem` entries with `icon`, `label`,
  `tab` and `requiresAuth`, with labels passed through `t` (lingui). Nothing in the
  modal searches it.
- Settings rows are components inside each tab (`features/settings/components/`).
  They have no index. A tab cannot be searched by its row labels without a list.
- The active tab is read from the `settingsTab` URL search parameter, and the modal
  clears its own parameters on close (`MODAL_SEARCH_KEYS`). A search must not add a
  new parameter that survives close.
- Keyboard shortcuts are registered in `apps/web/src/features/keyboard/`.

## 3. Design

- **Index.** Built when the search opens: one entry per tab from the navigation
  data, plus one entry per keyword in a tab's keyword list. Each entry holds the
  tab, its section heading if any, and the translated label.
- **Keyword lists.** Each tab that has settings declares its own list beside its
  component, as data: an array of `{ tab, section, label, keywords }`. Labels are
  `t` strings. A test fails when a tab in the navigation data has no keyword list.
- **Matching.** Case-insensitive, accent-insensitive substring match over label and
  keywords. Results are grouped by tab, in navigation order.
- **Opening a result.** Sets `settingsTab`, scrolls the section into view, and
  highlights the row for two seconds. The search does not add or keep its own URL
  parameter.
- **Shortcut.** A search shortcut is registered in `features/keyboard/`, and it
  works only while the modal is open.
- **Accessibility.** The field follows the ARIA combobox pattern. The result count
  is announced with `aria-live="polite"` (`CLAUDE.md`, accessibility). Arrow keys
  move through results, Enter opens one, and Escape clears the field and then closes
  the search, not the modal.

## 4. Slices

**S1 — Tab search and index.** The search field, tab-level results from the
navigation data, the test that each tab has a keyword list (an empty list is
allowed, but must exist).
- Acceptance: typing a tab's label, in each supported locale, finds that tab; the
  test fails when a tab is added without a keyword list.

**S2 — Setting-level keywords and jump.** Keyword lists for the tabs with the most
settings first, then the rest. Result opening with scroll and highlight.
- Acceptance: typing a setting's name opens its tab and scrolls to the row (end-to-
  end test on three tabs chosen from the navigation); the search leaves no URL
  parameter after the modal closes; the result count is announced.

**S3 — Keyboard and accessibility pass.** Arrow keys, Enter, Escape, screen reader
check.
- Acceptance: the whole search works without a pointer; a screen reader reads the
  count and the selected result (manual check, recorded in the PR).

## 5. Invariants crossed

- No new backend call and no new procedure, so no authz-matrix row.
- The modal's URL-parameter handling stays as it is (`MODAL_SEARCH_KEYS`).
- Accessibility rules in `CLAUDE.md` apply: no focus trap, labels on every control.

## 6. Risks

- **Index drift.** A new setting that has no keyword entry is not found. Mitigated by
  the per-tab test, which catches a missing list, not a missing row. Stated plainly:
  a row-level miss is not caught automatically.
- **Translations.** A label that is not translated falls back to English. The
  translation check already in the repo covers the new strings.

## 7. Open questions

1. **Row-level coverage.** Recommendation: maintain the keyword lists by hand in S2,
   and revisit automatic extraction only if drift shows up.
2. **Shortcut key.** Recommendation: the search key used elsewhere in the app, if one
   exists in `features/keyboard/`; otherwise the platform's find shortcut.
