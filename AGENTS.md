# AGENTS.md — Figma Superpowers

## What this repo is

A pure-JavaScript Figma plugin (`code.js` backend + `ui.html` frontend, wired by `manifest.json`) that turns an **external AI chat** (Gemini, ChatGPT, Claude — user pastes back and forth, no API calls from the plugin) into a design-system assistant with read/write access to the canvas via pasted ` ```javascript ` blocks.

No build step. Edit `code.js` / `ui.html` directly. `npm run lint` (ESLint) covers JS only.

## What "prompt" means here — read this first

A "prompt" in this repo is a **clipboard payload handed to an external chatbot**, not a call to an LLM API. There are exactly three payload types, each with a fixed header the AI keys off:

1. **System prompt** (`=== FIGMA SYSTEM INITIALIZATION (STANDARD MODE) ===` or `(EXPLORATIVE LAZY MODE)`) — one-time priming: component index + variable collections + the rules header. Built on scan, copied once per chat.
2. **Selection context** (`=== FIGMA SELECTION CONTEXT ===`) — Markdown snapshot of the user's current Figma selection. Copied on demand, pasted into the ongoing chat when the AI needs canvas detail.
3. **Tool response** (`=== FIGMA TOOL RESPONSE ===`) — result of a `[READ-ONLY]` script the plugin executed. Auto-copied by the plugin; the user pastes it back into the chat to continue the loop.

The system prompt also contains a **`STRICT CODE GENERATION & EXECUTION RULES` header** (`SYSTEM_RULES_HEADER` in `ui.html`). That is a behavioral contract constraining what the AI may output (selection-first, action-type flags, zero placeholders) so its code runs "as is" when pasted back. If you change execution semantics in `code.js`, you must update that header to match.

## Where prompts live (source of truth)

- **`ui.html` is the source of truth.** Runtime templates are JS constants: `SYSTEM_RULES_HEADER`, `STANDARD_PROMPT_TEMPLATE` (`{{MANIFEST}}`, `{{VARIABLES}}`), `EXPLORATIVE_PROMPT_TEMPLATE` (`{{PAGES}}`, `{{COLLECTIONS}}`). Placeholders are filled by data posted from `code.js` (`PRIMING_DATA_READY` handler).
- **`prompts/` is legacy and stale** (predates the Standard/Explorative split and the tooling bridge). It is never read at runtime. Do not treat it as authoritative; do not add new templates there. If you touch it at all, it should be to delete it or sync it from `ui.html` — never the reverse.

## Runtime architecture

- `code.js` (sandbox): pre-flight check (`SAFETY_LIMITS`: `MAX_PAGES: 8`, `MAX_VARIABLES: 300` enforced; `MAX_COMPONENTS` defined but **unenforced**), Markdown serializers (`serializeNodeMarkdown`, component/variable index builders), `selectionchange` → `SELECTION_UPDATED` push, and the `RUNUserCode` executor (`new Function("return (async () => { … })()")`).
- `ui.html` (iframe): buttons (`Evaluate & Scan File` → `Copy System Prompt`; `Copy Selection Context` / `Copy Canvas State`), `smartPasteField` paste zone (extracts first ```` ```javascript ```` block; fallback accepts raw text containing `figma` or starting with `return`), status tag (`Standard` / `Explorative`), message bridge (`parent.postMessage` → `figma.ui.onmessage`; `figma.ui.postMessage` → `window.onmessage`).
- Message types: `GENERATE_DYNAMIC_PRIMING_PROMPT` → `PRIMING_DATA_READY` (`mode: STANDARD | EXPLORATIVE`); `SELECTION_UPDATED` (`nodeMarkdown`, `hasSelection`); `RUNUserCode` → `EXECUTION_RESULT` (auto-copied as tool response).
- Execution semantics: script `return`s a value → `[READ-ONLY]` query, result JSON/stringified and auto-copied; returns `undefined` → `[WRITE/MUTATION]`; throws → error notification. All AI-generated example code must be **ES6-only** (no `?.` / `??`) — the plugin runtime throws on modern syntax.
- Standard mode scans the **current page only** for components; Explorative mode sends a file-map skeleton (page names, collection names + mode counts) and relies on selection context + `[READ-ONLY]` discovery queries.

## Conventions for changes

- Change data and template together: a new `{{PLACEHOLDER}}` in `ui.html` needs a matching field in the `PRIMING_DATA_READY` payload in `code.js`, and vice versa. Keep header strings (`=== FIGMA … ===`) byte-stable — the AI and the paste regex depend on them.
- Keep selection serialization lightweight Markdown (type, name, WxH, fill hex, 30-char text snippet, variant props, auto-layout). Do not regress to raw JSON dumps.
- Keep the rules header's three guarantees intact (selection-context preference, Action Type + Expected Outcome flag, as-is execution) unless the execution engine changes accordingly.
- Docs: `README.md` is the user contract; `docs/superpowers/specs/` holds design history. Update both when behavior changes.

## Verification

- Re-read the edited template + its data provider in full; confirm placeholders resolve and headers match.
- `npm install && npm run lint` only for JS changes; never for Markdown-only edits.
- No automated tests exist — manually walk the affected loop (scan → copy → paste-back → tool response) where possible.
