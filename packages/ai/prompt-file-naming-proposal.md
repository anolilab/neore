# Prompt Files Naming Proposal

## Current Structure

```text
packages/ai/src/prompts/
├── index.ts           (807 lines) - Variable utilities + Prompt generators
├── cinema.ts          (11K) - Cinema-specific prompts
└── prompts.test.ts    (29K) - Tests
```

## Analysis

**index.ts contains TWO distinct concerns:**

1. **Variable Template System** (~10 functions, ~150 lines)
    - `extractVariables()`, `hasVariables()`, `replaceVariables()`, etc.
    - Generic template variable handling
    - Could be reused outside prompts

2. **AI Prompt Generators** (~5 functions, ~650 lines)
    - `getSystemPrompt()`, `getComplexTaskPrompt()`, etc.
    - AI-specific prompt building
    - Core business logic

---

## Option 1: Simple Rename (Minimal Change) ⭐

**Change**: Just rename `index.ts` to be more descriptive

```text
packages/ai/src/prompts/
├── system-prompts.ts       (was index.ts)
├── cinema.ts               (unchanged)
└── system-prompts.test.ts  (was prompts.test.ts)
```

**Pros**:

- ✅ Minimal changes
- ✅ More descriptive than "index"
- ✅ Clear what the file contains
- ✅ No refactoring needed

**Cons**:

- ❌ Still mixes two concerns
- ❌ Large file (807 lines)

**Import Changes**:

```text
// Before
import { getSystemPrompt } from "@neore/ai/prompts";
// After
import { getSystemPrompt } from "@neore/ai/prompts/system-prompts";
```

---

## Option 2: Split into Modules (Recommended) 🎯

**Change**: Separate concerns into focused files

```text
packages/ai/src/prompts/
├── builders.ts              (NEW - Prompt generators, ~650 lines)
├── variables.ts             (NEW - Variable utilities, ~150 lines)
├── cinema.ts                (unchanged)
├── index.ts                 (NEW - Re-exports for backward compat)
├── builders.test.ts         (was prompts.test.ts - prompt tests)
└── variables.test.ts        (NEW - variable tests)
```

**File Contents**:

### `builders.ts`

```text
// All prompt generation functions
export const getSystemPrompt = (...) => { ... };
export const getFollowupSuggestionsPrompt = (...) => { ... };
export const getThreadTitlePrompt = (...) => { ... };
export const getTaskSpecificPrompt = (...) => { ... };
export const getComplexTaskPrompt = (...) => { ... };

// Types
export interface UserPersonalization { ... }
export interface AgentModeConfig { ... }
export interface SkillMetadata { ... }
export type TaskType = ...;
```

### `variables.ts`

```text
// Template variable system
export const VARIABLE_REGEX = /\{\{([a-zA-Z0-9_-]+)\}\}/g;

export interface PromptVariable { ... }

export function extractVariables(...) { ... }
export function hasVariables(...) { ... }
export function replaceVariables(...) { ... }
export function replaceWithDefaults(...) { ... }
export function validateVariables(...) { ... }
export function syncVariablesWithContent(...) { ... }
```

### `index.ts` (Barrel export)

```typescript
// Re-export everything for backward compatibility
export * from "./builders";
export * from "./cinema";
export * from "./variables";
```

**Pros**:

- ✅ Separation of concerns (Single Responsibility Principle)
- ✅ Smaller, focused files
- ✅ Easier to maintain and test
- ✅ Backward compatible (imports still work)
- ✅ Variable system can be reused elsewhere
- ✅ Clear module boundaries

**Cons**:

- ⚠️ More files to manage
- ⚠️ Requires refactoring

**Import Changes**:

```text
// Old way still works (via index.ts)
import { getSystemPrompt } from "@neore/ai/prompts";
// New explicit way (better for tree-shaking)
import { getSystemPrompt } from "@neore/ai/prompts/builders";
import { replaceVariables } from "@neore/ai/prompts/variables";
```

---

## Option 3: Domain-Driven Naming (Alternative)

**Change**: Name files by their domain purpose

```text
packages/ai/src/prompts/
├── ai-system.ts           (Prompt generators)
├── template-engine.ts     (Variable utilities)
├── cinema.ts              (unchanged)
├── ai-system.test.ts
└── template-engine.test.ts
```

**Pros**:

- ✅ Domain-driven naming
- ✅ Separation of concerns
- ✅ Descriptive names

**Cons**:

- ❌ "ai-system" is vague
- ❌ "template-engine" might be overkill
- ❌ Less intuitive than Option 2

---

## Recommendation: **Option 2 (Split into Modules)** 🎯

### Why?

1. **Single Responsibility**: Each file has one clear purpose
2. **Maintainability**: Easier to find and modify code
3. **Testability**: Separate test files for each concern
4. **Reusability**: Variable system can be used independently
5. **Backward Compatible**: Old imports still work via index.ts
6. **Industry Standard**: Barrel exports are common in TypeScript

### Migration Path

**Step 1**: Create new files

```bash
# Create builders.ts with prompt generators
# Create variables.ts with variable utilities
# Update index.ts to re-export both
```

**Step 2**: Update tests

```bash
# Split prompts.test.ts into:
# - builders.test.ts (prompt generation tests)
# - variables.test.ts (variable utility tests)
```

**Step 3**: Update package.json exports (optional)

```json
{
    "exports": {
        "./prompts": "./src/prompts/index.ts",
        "./prompts/builders": "./src/prompts/builders.ts",
        "./prompts/variables": "./src/prompts/variables.ts",
        "./prompts/cinema": "./src/prompts/cinema.ts"
    }
}
```

**Step 4**: Verify no breaking changes

```bash
# Run type check
pnpm lint:types

# Run tests
pnpm test
```

---

## File Size Comparison

| File         | Current   | After Split            |
| ------------ | --------- | ---------------------- |
| index.ts     | 807 lines | ~20 lines (re-exports) |
| builders.ts  | -         | ~650 lines             |
| variables.ts | -         | ~150 lines             |
| **Total**    | 807       | 820 (+13 for index)    |

**Net Result**: Same total code, better organization

---

## Import Pattern Comparison

### Current (Option 1)

```text
import { getSystemPrompt, replaceVariables } from "@neore/ai/prompts/system-prompts";
```

### Recommended (Option 2)

```text
// Via barrel export (backward compatible)
import { getSystemPrompt, replaceVariables } from "@neore/ai/prompts";
// Via specific modules (explicit, better tree-shaking)
import { getSystemPrompt } from "@neore/ai/prompts/builders";
import { replaceVariables } from "@neore/ai/prompts/variables";
```

---

## Test File Naming

### Current

```text
prompts.test.ts (29K, 73 tests)
```

### Option 1

```text
system-prompts.test.ts
```

### Option 2 (Recommended)

```text
builders.test.ts      (~50 tests - prompt generation)
variables.test.ts     (~23 tests - variable utilities)
```

### Option 3

```text
ai-system.test.ts
template-engine.test.ts
```

---

## Summary

| Aspect              | Option 1    | Option 2 ⭐      | Option 3 |
| ------------------- | ----------- | ---------------- | -------- |
| **Clarity**         | Good        | Excellent        | Good     |
| **Maintainability** | Fair        | Excellent        | Good     |
| **Backward Compat** | Breaking    | Compatible       | Breaking |
| **File Size**       | Large (807) | Small (~400 avg) | Medium   |
| **Separation**      | None        | Clean            | Clean    |
| **Effort**          | Low         | Medium           | Medium   |
| **Recommendation**  | ⭐⭐⭐      | ⭐⭐⭐⭐⭐       | ⭐⭐⭐⭐ |

---

## Decision Matrix

Choose based on your priorities:

- **Need quick fix?** → **Option 1** (Simple rename)
- **Want best practices?** → **Option 2** (Split modules) ⭐
- **Prefer semantic names?** → **Option 3** (Domain-driven)

**My Strong Recommendation**: **Option 2**

- Best long-term solution
- Minimal breaking changes
- Follows TypeScript best practices
- Easier to maintain and extend
