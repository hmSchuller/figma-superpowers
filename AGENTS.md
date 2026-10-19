# AGENTS.md — Figma Superpowers (FigmaPack)

## What this repo is

A pure-JavaScript Figma plugin (built `code.js` sandbox + `ui.html` iframe, wired by `manifest.json`) with two cooperating features:

1. **Superpowers clipboard workflow** — turns an **external AI chat** (Gemini, ChatGPT, Claude; the user pastes back and forth, the plugin makes no API calls) into a design-system assistant with read/write canvas access via pasted ` ```javascript ` blocks.
2. **FigmaPack exporter** — walks every page/layer and all local variables, modes and styles, builds an **in-memory SQLite** snapshot with an FTS index plus a companion Markdown agent prompt, and offers them for download. No network access (`manifest.json` allows `"none"`), no server, no credentials.

## Build & sources — read this before editing

**`src/` is the source of truth. Never hand-edit the root `code.js` / `ui.html`; they are build artifacts that get overwritten.**

| Source | Becomes |
| --- | --- |
| `src/exporter.js` + `src/code.js` | concatenated into root `code.js` |
| `src/ui.html` + `src/database.js` + embedded `sql.js-fts5` bundle | root `ui.html` |
| `build.mjs` | also writes `LICENSE-SQLJS.txt` and checks for unreplaced placeholders |

```sh
npm install     # fetches the FTS-enabled SQLite asm.js distribution
npm test        # exporter + prompt + changes + snapshot + envelope (Node) + schema + reconcile (Python)
npm run build   # writes manifest-adjacent artifacts: code.js, ui.html, LICENSE-SQLJS.txt
```

Distribute the built `manifest.json` + `code.js` + `ui.html` (plus `LICENSE` and `LICENSE-SQLJS.txt`) — not the source tree or `node_modules`.

`src/ui.html` contains two placeholders that `build.mjs` fills: `/*__EMBED_SQLITE__*/` (the minified SQLite engine) and `/*__EMBED_PACK_DB__*/` (the contents of `src/database.js`). Keep them, and keep the build's post-check passing.

- **Build gotcha:** `build.mjs` injects those libraries via replacer **functions** (`() => text`), not replacement strings. The minified SQLite bundle contains `$&` / `$'` sequences that `String#replace` would expand, re-injecting the placeholder and tripping the guard. Do not "simplify" this back to a string replacement.

## What "prompt" means here

A "prompt" is a **clipboard payload handed to an external chatbot**, not a call to an LLM API. Payload types, each with a fixed byte-stable header the AI keys off:

1. **System prompt** (`=== FIGMA SYSTEM INITIALIZATION (STANDARD MODE) ===` or `(EXPLORATIVE LAZY MODE)`) — one-time priming: component index + variable collections + the rules header. Built on scan, copied once per chat.
2. **Selection context** (`=== FIGMA SELECTION CONTEXT ===`) — Markdown snapshot of the user's current Figma selection, optionally followed by a `=== FIGMA NODE SNAPSHOT ===` block of whole exporter rows for the selected region. Copied on demand, pasted into the ongoing chat when the AI needs canvas detail.
3. **Tool response** (`=== FIGMA TOOL RESPONSE ===`) — result of a `[READ-ONLY]` script the plugin executed. Auto-copied by the UI (`document.execCommand('copy')`) with a confirming `alert`; the user pastes it back to continue the loop. There is currently **no** staging buffer / "Copy Result" fallback — a copy failure only surfaces as the same alert, so a README-level "clipboard fallback" still needs building (and would live in the UI, never by weakening the AI's `return` obligation).
4. **Change report** (`=== FIGMA CHANGE REPORT ===`) — emitted after a `[WRITE/MUTATION]` script run (see *In-session delta sync* below). Auto-copied like a tool response.

Both the change report and the node snapshot close with a byte-stable `=== END … ===` footer and declare their totals, so the AI can detect a truncated paste; the plugin never guesses a transport limit.

The system prompt also contains a **`STRICT CODE GENERATION & EXECUTION RULES` header** (`SYSTEM_RULES_HEADER` in `src/ui.html`). It is a behavioral contract constraining what the AI may output (selection-first, action-type flags, zero placeholders, the read/write return split, and snapshot reconciliation) so its code runs "as is" when pasted back. If you change execution semantics in `src/code.js`, update that header to match.

## Where prompts live (source of truth)

- **`src/ui.html` is the source of truth.** Runtime templates are JS constants: `SYSTEM_RULES_HEADER`, `STANDARD_PROMPT_TEMPLATE` (`{{MANIFEST}}`, `{{VARIABLES}}`), `EXPLORATIVE_PROMPT_TEMPLATE` (`{{PAGES}}`, `{{COLLECTIONS}}`). Placeholders are filled by data posted from `src/code.js` (`PRIMING_DATA_READY` handler). The same strings end up in the built `ui.html`.
- **`prompts/` is legacy and stale** (predates the Standard/Explorative split and the tooling bridge). It is never read at runtime. Do not treat it as authoritative; do not add new templates there. If you touch it at all, it should be to delete it or sync it from `src/ui.html` — never the reverse.

## Runtime architecture

### `src/code.js` — plugin sandbox (`code.js`)

- `figma.showUI`, pre-flight check (`SAFETY_LIMITS`: `MAX_PAGES: 8`, `MAX_VARIABLES: 300` enforced; `MAX_COMPONENTS: 150` defined but **unenforced**), Markdown serializers (`serializeNodeMarkdown`, component/variable index builders), `selectionchange` → `SELECTION_UPDATED` push, and the `RUNUserCode` executor (`new Function("return (async () => { … })()")`).
- `RUNUserCode` wraps the executor in the change collector: `packStartChangeCollection()` → run → `packStopChangeCollection()` → flush. A write run (returns `undefined` or throws) always emits a `CHANGE_REPORT`; a read run only emits one if node/style changes were captured. Errors still notify and flush what was captured.
- Delegates FigmaPack messages first: `figma.ui.onmessage` calls `packHandleMessage(msg)` (defined in the concatenated `exporter.js`) and returns early on a match.
- Priming (`GENERATE_DYNAMIC_PRIMING_PROMPT`) runs under `packBeginSuppression()` and primes the variable baseline in Standard mode.

### `src/exporter.js` — FigmaPack extraction + delta sync (sandbox)

- Iterative (non-recursive) layer walk over `page.loadAsync()`-ed pages with `skipInvisibleInstanceChildren = false`, so hidden instance descendants are included.
- `packPlain`/`packJSON` sanitize Figma values (drops `figma.mixed`, functions, non-finite numbers; depth-capped) into `properties_json`. `packNode` then **prunes empty containers and empty strings** (`packPrune` — absence means "empty") and **never inlines variable aliases**: `boundVariables` at the top level and inside `fills`/`strokes`/`effects`/`layoutGrids` is collected into `node_variable_bindings` instead, so each alias is stored once. Aliases nested anywhere else (e.g. `componentProperties`) have no table home and are left in the JSON.
- **Shared serializers** (used by the export, a report's `created` and a node snapshot so all three emit identical bytes): `packNode`, `packNodeRecords(root, pageId, parentId, position, depth)` (iterative subtree walk), `packCollectionRecords`, `packVariableRecords`, `packStyleRecords`.
- `packPostBatch` streams `PACK_BATCH` messages of `PACK_BATCH_SIZE: 200` records and **awaits a `PACK_ACK`** per batch → bounded queueing. `PACK_CANCEL` flips `state.cancelled`.
- Emits record kinds: `page`, `node`, `binding` (`node_variable_bindings`), `link` (`node_links`, instance + prototype), `collection`, `mode`, `variable`, `value`, `style`. Also `PACK_META` (counts, `export_complete`, etc.), `PACK_PROGRESS`, `PACK_DONE`, `PACK_ERROR`.
- `PACK_DONE` is only sent after a full successful walk — an error aborts rather than shipping a partial DB.
- **Change collector** (`packStartChangeCollection` / `packStopChangeCollection` / `packBuildChangeReport`): layers ride `figma.on('documentchange')`, styles ride `figma.on('stylechange')`, variables have no event and are diffed against a cached signature baseline (`packPrimeTokenBaseline`, re-cached after each write run). `packBeginSuppression`/`packEndSuppression` keep bulk scans out of the feed. `PROPERTY_CHANGE` property names map to exporter fields via `PACK_SCALAR_PROPERTY_FIELDS` / `PACK_STRUCTURE_PROPERTIES` / `PACK_RICH_PROPERTY_SET`; an unmapped name falls back to a whole row. `PACK_REPORT_LIMIT` sets `truncated`.
- **Snapshots** (`packBuildSnapshot`) serialize the current selection as whole `packNodeRecords` rows under `NODE_SNAPSHOT`; the UI requests one with `PACK_SNAPSHOT_REQUEST` and the sandbox replies `PACK_SNAPSHOT`.

### `src/database.js` — UI iframe (`PACK_SCHEMA`, insert helpers)

- `PACK_SCHEMA`: `metadata`, `pages`, `nodes` (+ indexes), `nodes_fts`, `node_links`, `node_variable_bindings`, `variable_collections`, `variable_modes`, `variables`, `variable_values`, `styles`. Nodes keyed by `figma_id`; parents/pages stored by ID, not repeated paths. `node_variable_bindings` is `WITHOUT ROWID` — its composite PK *is* the storage, and `idx_bindings_variable` still serves the by-variable lookup. `properties_json` is load-bearing for size: `boundVariables` is not duplicated into it and empty containers are dropped.
- `packOpenDatabase` opens `new SQL.Database()` in a single transaction with prepared inserts; `packInsertBatch` maps each record's fields.
- `packCreateFTS` tries FTS5 (`content='nodes'`, rebuild) and **falls back to FTS4** if unavailable; the choice is recorded as `fts_version` and reflected in the prompt.
- `packFinish` sets metadata, commits, builds the index, verifies `PRAGMA integrity_check` (`ok`), and returns `{ binary, prompt, fts }`. UI asserts node/page counts match before finishing (`Node/Page count mismatch`).
- `packAgentPrompt(db, fts, rulesHeader)` generates the Markdown `FIGMAPACK AGENT PROMPT` (consultant role line, counts, table guide, discovery SQL, an `## Applying change reports` section, "local-only variables" caveat, no-images caveat) and appends `rulesHeader` last. `rulesHeader` is optional but the UI always passes `SYSTEM_RULES_HEADER`, so the file prompt carries the same execution contract as the in-plugin system prompt.
- Shared clipboard envelopes: `CHANGE_REPORT_HEADER`/`_FOOTER`, `NODE_SNAPSHOT_HEADER`/`_FOOTER`, `packWrapEnvelope`, `packEnvelopeVerifies`. These live here (not in `ui.html`) so the UI and the tests share one source of truth for the byte-stable markers and the completeness check.
- `packDownload(data, filename, contentType)` builds a Blob and triggers a download click. There is **no** packaging step: the UI hands it `packFinish`'s `binary` verbatim (`figma_superpowers.db`), and the prompt is copied to the clipboard instead of shipped as a file.

### `src/ui.html` — iframe UI

- Buttons: `Evaluate & Scan File` → `Copy System Prompt`; `Copy Selection Context` / `Copy Canvas State`; `Export Complete File to SQLite` (toggles to `Cancel Export`); `Download DB`; `Copy Prompt`.
- `smartPasteField` paste zone extracts the first ` ```javascript ` block; fallback accepts raw text containing `figma` or starting with `return`.
- Status tag (`Standard` / `Explorative`) and `packStatus` live region for export progress.
- Message bridge: `parent.postMessage({ pluginMessage })` → `figma.ui.onmessage`; `figma.ui.postMessage` → `window.onmessage`.
- Superpowers message types: `GENERATE_DYNAMIC_PRIMING_PROMPT` → `PRIMING_DATA_READY` (`mode: STANDARD | EXPLORATIVE`); `SELECTION_UPDATED` (`nodeMarkdown`, `hasSelection`); `RUNUserCode` → `EXECUTION_RESULT`.
- FigmaPack message types: `PACK_BEGIN`, `PACK_BATCH`, `PACK_ACK`, `PACK_CANCEL`, `PACK_META`, `PACK_PROGRESS`, `PACK_DONE`, `PACK_ERROR`, `PACK_SNAPSHOT_REQUEST` → `PACK_SNAPSHOT`.
- Execution semantics: script `return`s a value → `[READ-ONLY]` query, result JSON/stringified and copied as `=== FIGMA TOOL RESPONSE ===`; returns `undefined` → `[WRITE/MUTATION]`, the `EXECUTION_RESULT` carries `kind: 'CHANGE_REPORT'` and is wrapped in the change-report envelope + footer; throws → error notification (still flushing captured changes). All AI-generated example code must be **ES6-only** (no `?.` / `??`) — the plugin runtime throws on modern syntax.
- `Copy Selection Context` is async: it requests a node snapshot (2.5 s timeout), appends the `NODE SNAPSHOT` envelope when it arrives, and falls back to prose-only if the sandbox does not reply.
- Standard mode scans the **current page only** for components; Explorative mode sends a file-map skeleton (page names, collection names + mode counts) and relies on selection context + `[READ-ONLY]` discovery queries.

## In-session delta sync

After a write script, the sandbox emits a `=== FIGMA CHANGE REPORT ===` (changelog: `created` whole rows, `updated` merge patches, `deleted` subtree-root ids, plus `tokens` create/patch/delete, `geometry_stale`, `truncated`). The user pastes it back and the AI applies it to its own copy of the DB; the plugin never writes to the AI's snapshot. The change report is emittable because the collector is script-scoped and the variable baseline is cached. `SYSTEM_RULES_HEADER` rule 5 is the behavioral contract on the AI side; `packAgentPrompt` mirrors it as `## Applying change reports`. When you change the report shape, update both. The report is a description, **never SQL** — do not paste our table layout into the prompt.

## Conventions for changes

- Change data and template together: a new `{{PLACEHOLDER}}` in `src/ui.html` needs a matching field in the `PRIMING_DATA_READY` payload in `src/code.js`, and vice versa. Keep header strings (`=== FIGMA … ===`) byte-stable — the AI and the paste regex depend on them.
- Change schema and both sides together: a new record `kind` needs an entry in `PACK_INSERTS`/`PACK_COLUMNS` (`src/database.js`), a matching table in `PACK_SCHEMA`, and a matching emitter in `src/exporter.js`. `tests/test-schema.py` re-parses `PACK_SCHEMA` from source, so schema drift breaks tests.
- Keep selection serialization lightweight Markdown (type, name, WxH, fill hex, 30-char text snippet, variant props, auto-layout). Do not regress to raw JSON dumps.
- Keep the rules header's guarantees intact (selection-context preference, Action Type + Expected Outcome flag, as-is execution, READ-ONLY clipboard contract, snapshot reconciliation: verify the `=== END … ===` footer + declared totals before applying) unless the execution engine changes accordingly. `SYSTEM_RULES_HEADER` in `src/ui.html` is the single source of truth: it is embedded in the inline system prompt *and* threaded through `packFinish(session, metadata, SYSTEM_RULES_HEADER)` → `packAgentPrompt` into the downloadable prompt. If you duplicate the header text anywhere, both init paths drift.
- Docs: `README.md` is the user contract; `docs/superpowers/specs/` (and `plans/`) hold design history. Update them when behavior changes. There is no ESLint config in this repo, despite older notes.

## Verification

- After any edit to `src/**`, run `npm test` then `npm run build`. A green build means every placeholder resolved and the SQLite license was found.
- Tests are small but real: `tests/test-exporter.cjs` runs `src/exporter.js` against a mocked Figma API in a `node:vm` sandbox (pages, nodes, bindings, instance links, styles); `tests/test-changes.cjs` drives the `documentchange`/`stylechange` feeds and the cached variable diff; `tests/test-snapshot.cjs` and `tests/test-envelope.cjs` cover the snapshot payload and the byte-stable footers/declared totals; `tests/test-prompt.cjs` runs `packAgentPrompt` against a stubbed `db` and asserts the role line, counts and appended rules header; `tests/test-schema.py` re-parses `PACK_SCHEMA` and checks native SQLite integrity + FTS5 search; `tests/test-reconcile.py` replays a sample report and snapshot through the documented operations (patch merge, subtree delete, token cascades) and re-checks FTS/integrity.
- Re-read the edited template + its data provider in full; confirm placeholders resolve and headers match.
- What tests do **not** cover: the live Figma `documentchange`/`stylechange` feeds, iframe SQLite execution (`sql.js-fts5` inside the plugin), download behavior, and the clipboard round-trip. Walk the affected loop (scan → copy → paste-back → report, or export → download → query) manually in Figma before releasing.
