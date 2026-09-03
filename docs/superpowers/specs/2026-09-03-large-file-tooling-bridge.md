# Large-File Mode + Tooling Bridge Spec

Date: 2026-09-03
Status: Implemented (`code.js`, `ui.html`); `prompts/` stale, `README.md` updated.

Supersedes assumptions in `2026-06-22-consulting-flow-design.md` where noted.

## Context

Since the consulting-flow work, three changes landed without doc updates:

1. **Large file mode** (`c4821d2`) — pre-flight check + Standard vs Explorative prompts + status tag.
2. **Human-in-the-loop prompting** (`2f1cd32`, `00d6347`) — `SYSTEM_RULES_HEADER`, selection-context preference, action-type flags, zero-placeholder guarantee; exemplar discovery queries removed in favor of selection-first.
3. **Tooling clipboard bridge** — `EXECUTION_RESULT` auto-copy loop, `[READ-ONLY]` vs `[WRITE/MUTATION]` notifications, `return`-based query support, Markdown selection serialization.

`README.md` still described the old flow (`Scan Project Library`, JSON `{{MANIFEST}}` / `{{VARIABLES}}` / `{{COLLECTIONS}}` / `{{TARGET_DATA}}`, `prompts/` as source of truth). This spec records actual behavior.

## Actual Behavior

### Pre-flight check (`code.js`)

```js
const SAFETY_LIMITS = { MAX_PAGES: 8, MAX_COMPONENTS: 150, MAX_VARIABLES: 300 };
```

- `isHugeFile = pageCount > MAX_PAGES`, or local variable count `> MAX_VARIABLES`.
- `MAX_COMPONENTS` is defined but currently unenforced (no component-count branch).
- Explorative path posts `{ mode: "EXPLORATIVE", pageNames, collectionsSummary }` (collection `name + mode count` only). No traversal.
- Standard path scans **current page only** (`findAllWithCriteria({ types: ["COMPONENT", "COMPONENT_SET"] })`, deduped from sets) into Markdown lines `- **name** (type) | Key: \`key\` | Props: [...]`, plus collection name + mode-count list. Full variable detail dump was removed.

### Prompt templates (`ui.html` — source of truth)

- `SYSTEM_RULES_HEADER`: (1) selection-context preference, (2) Action Type + Expected Outcome flag before every ` ```javascript ` block, (3) zero placeholders / as-is execution.
- `STANDARD_PROMPT_TEMPLATE`: `=== FIGMA SYSTEM INITIALIZATION (STANDARD MODE) ===` + `[COMPONENT INDEX] {{MANIFEST}}` + `[VARIABLE COLLECTIONS] {{VARIABLES}}` + rules header.
- `EXPLORATIVE_PROMPT_TEMPLATE`: `=== FIGMA SYSTEM INITIALIZATION (EXPLORATIVE LAZY MODE) ===` + `[FILE MAP SKELETON]` (`{{PAGES}}`, `{{COLLECTIONS}}`) + rules header + rule 4 (no pre-loaded nodes; prefer `Copy Selection Context`; global searches via lightweight `[READ-ONLY]` scripts ending in `return`).
- Old `SYSTEM_PROMPT_TEMPLATE` / `CONTEXT_CAPSULE_TEMPLATE` (with `{{TARGET_DATA}}`, `{{PAGE_NAME}}`, `{{TARGETING_STATE}}`, consultation/execution modes A/B) no longer exist at runtime.

### Selection context

- `serializeNodeMarkdown(node, depth)`: `- **TYPE**: "name" [WxH]` + `| Fills: #HEX,...` + `| Text: "30-char snippet"` + `| Props: {...}` + `| AutoLayout: DIR (gap: Npx)`, children recursed with 2-space indent.
- UI copies `=== FIGMA SELECTION CONTEXT ===\n` + markdown, or a `No layer selected...` fallback. Button label toggles `Copy Selection Context` / `Copy Canvas State`.
- Old JSON capsule + `GLOBAL PAGE SCOPE` / `LOCAL SELECTION BOUNDS` states are gone.

### Execution loop

- Paste zone extracts first `/```javascript([\s\S]*?)```/` match; fallback accepts raw text containing `figma` or starting with `return`.
- `code.js` runs `new Function("return (async () => { " + code + " })()")`.
- `result !== undefined` → `EXECUTION_RESULT` → UI auto-copies `=== FIGMA TOOL RESPONSE ===\n` + data, alert to paste back; notify `📋 [READ-ONLY] Output copied to clipboard.`
- `result === undefined` → notify `✅ [WRITE/MUTATION] Canvas updated cleanly.`
- Throw → notify `❌ Script Execution Error: ...`.
- UI panel is now 240×340 with labels `Environment Sync` / `Work with AI` / `Tooling Clipboard Bridge` and buttons `Evaluate & Scan File` → `Copy System Prompt`.

## Docs Updates Made

- `README.md` rewritten: 5-step loop, scan-mode table, AI contract section, bridge semantics, selection format example, `prompts/` marked legacy, `ui.html` marked source of truth.
- This spec added under `docs/superpowers/specs/`.

## Open Issues / Follow-ups

- `prompts/system-prompt.txt` + `prompts/context-capsule.txt` still describe the pre-split consulting flow. Either refresh them from `ui.html` templates or delete the folder to avoid a second source of truth.
- `SAFETY_LIMITS.MAX_COMPONENTS` is dead config — wire it into the pre-flight check or remove it.
- Standard-mode variable index is collection names only; token-level detail requires a `[READ-ONLY]` query round-trip — call this out if users expect full token dumps.
- No automated tests for the paste extraction regex or the explorative/standard branching; verify manually after template edits.
