# Figma Superpowers

A Figma plugin that bridges your design system with AI chat assistants. Scan the file into a system prompt, discuss with any AI assistant (Gemini, ChatGPT, Claude, etc.), then paste AI-generated code back into Figma to run layout queries or mutations — with results copied back to the chat.

## How It Works

1. **Evaluate & Scan File** — Click `Evaluate & Scan File`. The plugin pre-flights file size and builds a system prompt (Standard or Explorative, see below). Click again to copy it (`Copy System Prompt`) and paste into a new AI chat.
2. **Chat with AI** — Ask design-system questions, request critique, or plan changes. The AI answers from the scanned index first.
3. **Copy Selection Context When Needed** — Select layers in Figma and click `Copy Selection Context` (or `Copy Canvas State` when nothing is selected). Paste the `=== FIGMA SELECTION CONTEXT ===` markdown into the chat for canvas-specific advice or executable changes.
4. **Paste Code to Execute** — When the AI returns a ` ```javascript ` block, paste it into the plugin's **Tooling Clipboard Bridge** field. The plugin extracts the code and runs it against your Figma document.
5. **Paste Tool Results Back** — If the script `return`s data (`[READ-ONLY]` query), the plugin auto-copies a `=== FIGMA TOOL RESPONSE ===` payload. Paste it back into the chat to continue the loop. If it mutates the canvas (`[WRITE/MUTATION]`), you just get a success notification.

## Scan Modes

`code.js` runs a pre-flight check before indexing (`SAFETY_LIMITS`: `MAX_PAGES: 8`, `MAX_VARIABLES: 300`):

| Mode | Trigger | System prompt contains |
|---|---|---|
| **Standard** | ≤ 8 pages and ≤ 300 local variables | `=== FIGMA SYSTEM INITIALIZATION (STANDARD MODE) ===` + Markdown component index (`name`, `type`, `key`, props) for the current page + variable collection list |
| **Explorative (lazy)** | > 8 pages or > 300 variables | `=== FIGMA SYSTEM INITIALIZATION (EXPLORATIVE LAZY MODE) ===` + file-map skeleton only (page names, collection names + mode counts). No layer nodes pre-loaded |

The UI shows the active mode in a status tag (`⚡ Standard Mode Active` / `🔍 Large File: Explorative Mode Active`).

In Explorative mode the AI has no canvas nodes up front. The preferred discovery path is: select a frame → `Copy Selection Context`. Global searches (find components by name, list variables) go through lightweight `[READ-ONLY]` query scripts ending in `return`.

## AI Contract (Human-in-the-Loop Rules)

Every system prompt embeds a `STRICT CODE GENERATION & EXECUTION RULES` header the AI must follow:

1. **Selection-context first** — For inspecting the element the user is looking at, ask for `Copy Selection Context` instead of generating a `figma.currentPage.selection` reader. Only generate `[READ-ONLY]` queries for global searches (unselected pages, find-by-name, variable details).
2. **Action Type + Expected Outcome flag** — Immediately before any ` ```javascript ` block the AI must state `**Action Type**: [READ-ONLY] or [WRITE/MUTATION]` and `**Expected Outcome**: ...`.
3. **Zero placeholders / "as is" execution** — Code must run immediately when pasted. No `YOUR_NODE_ID_HERE` / `<component-name>` placeholders. Missing IDs must be resolved via dynamic query (`findOne`, `selection[0]`) or by asking for selection context first.

## Tooling Clipboard Bridge

The paste zone (`smartPasteField`) accepts:

- A full AI reply containing a single ` ```javascript ... ``` ` block (extracted via regex), or
- Raw code containing `figma` or starting with `return` (fences stripped).

Execution (`code.js` `RUNUserCode` handler) wraps the code in `(async () => { ... })()` via `new Function`:

- Returns a value → treated as `[READ-ONLY]` query. Result is posted back as `EXECUTION_RESULT`, auto-copied as `=== FIGMA TOOL RESPONSE ===`, notification: `📋 [READ-ONLY] Output copied to clipboard.` Paste it back into the AI chat.
- Returns `undefined` → treated as `[WRITE/MUTATION]`. Notification: `✅ [WRITE/MUTATION] Canvas updated cleanly.`
- Throws → notification: `❌ Script Execution Error: ...`

Generated AI code must stay ES6-compatible: no optional chaining (`?.`) or nullish coalescing (`??`) — the plugin runtime throws on those.

## Selection Context Format

Selection is serialized in `code.js` (`serializeNodeMarkdown`) as lightweight Markdown (~70% smaller than raw JSON):

```markdown
=== FIGMA SELECTION CONTEXT ===
- **FRAME**: "Hero" [1440x900] | Fills: #FFFFFF | AutoLayout: VERTICAL (gap: 24px)
  - **TEXT**: "Welcome" [200x40] | Text: "Welcome to..."
  - **COMPONENT**: "Button/Primary" [120x40] | Props: {"Variant":"Primary"}
```

Per node: `type`, `name`, `WxH`, fill hex colors, 30-char text snippet, variant props, auto-layout direction + gap; children recursed with indentation.

## Project Structure

```
figma-superpowers/
├── code.js            # Plugin backend — pre-flight check, Markdown serialization, code execution
├── ui.html            # Plugin UI + runtime prompt templates (source of truth for prompts)
├── manifest.json      # Figma plugin manifest
├── package.json       # Dev dependencies (ESLint, TypeScript, Figma typings)
├── prompts/           # Legacy reference only — stale, not read at runtime
│   ├── system-prompt.txt
│   └── context-capsule.txt
├── docs/superpowers/  # Design specs and implementation plans
└── README.md
```

> **Note:** `ui.html` is the source of truth for prompts (`SYSTEM_RULES_HEADER`, `STANDARD_PROMPT_TEMPLATE`, `EXPLORATIVE_PROMPT_TEMPLATE`). The files in `prompts/` predate the Standard/Explorative split and the tooling-bridge loop and are kept for reference only.

## Setup

1. Download the latest release and unzip it
2. In Figma, go to **Plugins > Development > Import plugin from manifest**
3. Select the `manifest.json` file from the unzipped folder

That's it — no compilation or build step required. The plugin runs on pure JavaScript (UI: 240×340 `Superpowers Hub` panel).

## Development

The plugin is pure JavaScript — no compilation needed. Edit `code.js` or `ui.html` directly.

For linting:

```bash
npm install
npm run lint
```

See `docs/superpowers/specs/` for design history, including the large-file / tooling-bridge spec.

## License

MIT
