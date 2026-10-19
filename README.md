# Figma Superpowers — FigmaPack prototype

Adds an **Export Complete File to SQLite** action to the existing
[Figma Superpowers](https://github.com/hmSchuller/figma-superpowers) plugin. The
original Evaluate & Scan, Copy Selection Context, and Tooling Clipboard Bridge
remain present. Instead of flooding a chat with Figma JSON, the plugin exports
an agent-oriented **SQLite snapshot** and generates a companion Markdown prompt,
just like GitPack, delivered as a single `figma_superpowers.zip` archive.

The generated prompt carries the same consultant role and the same
`STRICT CODE GENERATION & EXECUTION RULES` header as the plugin's inline
**Copy System Prompt** button, so a chat primed from either path returns
paste-ready ` ```javascript ` blocks instead of loose prose.

## For designers (after the maintainer packages the plugin)

1. Open the Figma design file and launch Figma Superpowers.
2. Click **Export Complete File to SQLite**. The export explicitly loads all
   pages, walks all layers, collects local variables/modes, and collects local styles.
3. Wait for the scan and SQLite index generation to finish.
4. Click **Download ZIP**. The archive holds `figma_superpowers.db` and
   `FIGMAPACK_AGENT_PROMPT.md` (use **Download Prompt** on its own if you prefer
   the Markdown by itself). Separate downloads are intentional because some Figma
   environments restrict automatic downloads.
5. Extract the archive and upload **both** files to ChatGPT or another LLM and ask
   about the screens, design system, accessibility, token usage, components, or
   implementation plan.

No Node.js, Python, Figma personal access token, external server, or
network access is needed by designers. The Figma plugin reads data locally using
Figma's built-in Plugin API. The database engine is pre-bundled into the plugin's
iframe. The manifest explicitly disallows network access.

## Keeping the snapshot current (in-session delta sync)

After the first export you do not need to re-export to stay in sync. When the AI
emits a `[WRITE/MUTATION]` script and you paste it into the Tooling Clipboard
Bridge, the plugin executes it and then emits an authoritative
**`=== FIGMA CHANGE REPORT ===`**, auto-copied to the clipboard. Paste it back into
the chat and the AI applies the same change to its copy of `design.db`.

The report is a changelog, not SQL: `created` carries whole rows (with their
bindings and links), `updated` carries minimal patches of only the changed fields,
and `deleted` carries subtree-root ids. Variable, mode and style edits ride the
same structure under `tokens`. Every payload ends with a byte-stable
`=== END … ===` footer and declares its totals, so the AI can tell a complete paste
from a truncated one without the plugin guessing any chat's size limit.

The **Copy Selection Context** button also carries a machine-applicable
`=== FIGMA NODE SNAPSHOT ===` block beside its prose. A snapshot is an
upsert-only resync of the region you selected, for when you edited the canvas by
hand. Treat reports and snapshots as the sanctioned way to keep one snapshot fresh
for the whole session; request a full re-export only when a report is `truncated`,
when `geometry_stale` is set and exact geometry matters, or when the AI and the
canvas disagree.


## For the plugin maintainer

The checked-in files in `src/` are the **source** and are deliberately small.
The SQLite library is installed **only when preparing the plugin release**.

```sh
npm install
npm test
npm run build
```

The build writes `code.js` and `ui.html` alongside `manifest.json`. Distribute
those **three built files** (plus `LICENSE` and generated `LICENSE-SQLJS.txt`). Designers install the prepared
Figma plugin, not the source repository. In Figma: Plugins → Development →
Import plugin from manifest, selecting the built `manifest.json`.

The build uses an offline, embedded `sql.js-fts5` asm.js distribution. This is
larger/slower than a WASM build but avoids external fetches and extra binary
assets. It falls back to FTS4 if the runtime reports no FTS5 support. The
companion prompt automatically reflects which search engine was built.

Downloads are bundled into `figma_superpowers.zip` by `src/zip.js`. Entries are
Deflate-compressed when `CompressionStream('deflate-raw')` is available and
stored uncompressed otherwise, so the archive is always valid and needs no
third-party packaging dependency at runtime.

> **Prototype verification status:** `npm test` (Node-based mocked Figma API
> export + change collector + snapshot + envelope + agent prompt + native;
> SQLite schema/FTS5 search and report/snapshot reconciliation) and `npm run build`
> (placeholder resolution, embedded SQLite injection, license copy) pass locally and
> produce the distributable `code.js` + `ui.html`. What remains unverified here is
> the live Figma runtime: executing the bundled `sql.js-fts5` inside the plugin
> iframe, the live `documentchange` / `stylechange` feeds, the download flow, and the
> clipboard round-trip. The maintainer should verify the built plugin inside Figma
> before distributing it to designers.

## Database contents

| Table | Use |
| --- | --- |
| `metadata` | File information, export counts, completeness, embedded agent prompt (DB context **plus** the shared execution-rules header), search engine |
| `pages` | Every Figma page, order and page-specific mode overrides |
| `nodes` | Every layer with Figma ID, parent/page relationships, name, full text, geometry, properties JSON |
| `nodes_fts` | FTS5 or FTS4 index of layer names and text |
| `node_links` | Component-instance references and prototype navigation |
| `node_variable_bindings` | Concrete node property paths bound to variable IDs |
| `variable_collections` | Local collection details |
| `variable_modes` | Every named collection mode |
| `variables` | Local variable identity, type, scopes, syntax |
| `variable_values` | Per-mode values and alias relationships |
| `styles` | Local paint/text/effect/grid styles |

Nodes are keyed by a stable Figma ID. Parent and page IDs are stored instead
of repeating long hierarchy paths in every row. The UI sends bounded batches
with explicit acknowledgments, preventing unbounded queued messages.

### Example SQL

```sql
-- Find top-level frames/screens
SELECT p.name AS page, n.figma_id, n.name, n.width, n.height
FROM nodes n JOIN pages p ON p.figma_id=n.page_id
WHERE n.depth=0 AND n.type='FRAME';

-- Find button labels and text
SELECT n.figma_id,n.name,n.text,n.properties_json
FROM nodes_fts JOIN nodes n ON n.id=nodes_fts.rowid
WHERE nodes_fts MATCH 'confirm';

-- Find where a token is used
SELECT n.figma_id,n.name,b.field
FROM node_variable_bindings b
JOIN nodes n ON n.figma_id=b.node_id
JOIN variables v ON v.figma_id=b.variable_id
WHERE v.name='color/action/primary';
```

## Scope and tradeoffs

- **Complete node enumeration**, including pages that aren't currently loaded,
  and hidden instance descendants. No arbitrary page-count or node-count cutoff.
- All local variables, variable modes, and their values are extracted. Library
  variables not local to the file are not expanded; unresolved aliases remain
  visible as IDs and are called out in the prompt.
- No generated code, network calls, credentials, collaboration comments,
  version history, or live synchronization is included.
- Design properties are compacted into `properties_json`; image bytes and image
  previews are **not** exported. This keeps the database much smaller than a
  screenshot archive. Use Copy Selection Context or provide screenshots when
  visual fidelity is essential.
- SQLite is created in memory. Truly enormous Figma documents can exceed the
  plugin iframe memory budget. A later version could add page-selective
  snapshotting, preview packs, or a multi-part exporter. In-session freshness is
  handled by the implemented change-report / node-snapshot delta sync
  (`docs/superpowers/specs/2026-10-19-live-snapshot-delta-sync.md`), so the whole
  file only needs re-exporting on drift, truncation, or exact-geometry requests.
- Old original `RUNUserCode` executes pasted code with Figma privileges: only
  paste code you trust. The SQLite exporter itself is **read-only**.
- An error aborts the export rather than providing a silently incomplete DB.
- The source is a prototype patch, not a published Figma release.

## Project layout

```text
manifest.json       existing plugin ID, dynamic page loading and network restriction
src/code.js         original Superpowers clipboard workflow, adapted to dynamic pages
src/exporter.js     new API extraction + bounded streaming to UI
src/ui.html         combined Superpowers UI template with FigmaPack buttons
src/database.js     SQL schema, inserts, full-text index, prompt, downloads
src/zip.js          minimal ZIP writer (Deflate via CompressionStream, stored fallback)
build.mjs           assembles the actual distributable plugin files
package.json        maintainer-only FTS-enabled SQLite dependency
tests/              mock Figma export/change collector, ZIP writer, agent prompt,
                    snapshot + envelope checks, native SQLite schema and reconciliation
```

## Licensing

Figma Superpowers is MIT licensed. `sql.js-fts5` is also MIT licensed; retain
its license notice when distributing a bundled copy. No token or usage data
is ever sent to a hosted service by this exporter.
