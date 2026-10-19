# In-Session Snapshot Delta Sync Spec

Date: 2026-10-19
Status: **Proposed — design only, no runtime changes made.**
Relates to: `2026-09-03-large-file-tooling-bridge.md` (execution loop, `SYSTEM_RULES_HEADER`),
`src/exporter.js` (row serialization), `src/database.js` (`packAgentPrompt`), `README.md`.

## Context

FigmaPack currently exports the **whole file** on demand: every page, every layer, all
local variables/modes and local styles, streamed to the iframe and written into an
in-memory SQLite snapshot. On a large file this is slow, so the intended usage is
"export rarely".

That intent breaks down because the snapshot has no way to stay current. Today:

- `[READ-ONLY]` scripts return data → `EXECUTION_RESULT` → auto-copied as
  `=== FIGMA TOOL RESPONSE ===`. Good.
- `[WRITE/MUTATION]` scripts return `undefined` → the plugin only fires
  `figma.notify('✅ [WRITE/MUTATION] Canvas updated cleanly.')`.

So after the agent's first write, the plugin's canvas and the agent's `design.db`
silently diverge. The only fix available to the user is a full re-export, which is
exactly the expensive operation this feature was supposed to avoid.

## Goal

Keep **one** snapshot usable for the whole session by feeding write results back into
the chat, so the agent can apply the same change to its copy of the database.

```text
agent emits [WRITE/MUTATION] ```javascript
  → user pastes into smartPasteField
  → plugin executes it
  → plugin emits  === FIGMA CHANGE REPORT ===   (what actually changed, SQL-ready)
  → auto-copied, user pastes back into the chat
  → agent applies upserts/deletes to its design.db
  → agent continues answering from an up-to-date snapshot
```

## Correction to the working assumption

The plugin **cannot** update the agent's SQLite. `design.db` is a downloaded file that
lives in the chat's context, not in Figma. "Update the affected rows" is an action the
**agent** performs in the chat. The plugin's only job is to produce a complete,
machine-applicable description of what changed.

## Change capture

Use Figma's native change feed rather than diffing or trusting the agent's script:

```js
figma.on('documentchange', function (event) {
  // event.documentChanges: [{ type: 'CREATE' | 'DELETE' | 'PROPERTY_CHANGE', id, origin }]
});
```

Why this over the alternatives:

| Option | Verdict |
| --- | --- |
| `figma.on('documentchange')` | Passive, cheap, authoritative, gives node IDs and change kinds. **Chosen.** |
| Full before/after document walk + diff | Correct but costs a full traversal per write — defeats the point. |
| Require the agent's script to `return` a manifest | Unreliable (model-authored), and rule 4 currently forbids it. |

Requirements:

- **Scoped to script runs.** Register before `RUNUserCode` executes, flush after it
  settles (including on throw, so partial mutations are still reported).
- **Suppressed during bulk scans.** The exporter and the priming scan must not pollute
  the feed; wrap them in a suppression counter (`suppressChanges++ / --`), since
  `page.loadAsync()` and traversal are not user-visible edits.
- **Out-of-band edits are a bonus, not v1.** `documentChanges` also reports the user's
  own canvas edits (`origin: 'LOCAL'`). Capturing those continuously would keep the DB
  fresh with no script at all, but it is noisy and deferred (see Open Questions).

## Report format

New byte-stable header, consistent with the existing `=== FIGMA … ===` family:

```text
=== FIGMA CHANGE REPORT ===
```

Payload: one JSON object (the existing tool response already permits JSON or string).

```json
{
  "kind": "CHANGE_REPORT",
  "script": "created 4 nodes, changed 2, deleted 1",
  "counts": { "created": 4, "updated": 2, "deleted": 1 },
  "upserts": [
    {
      "node": { "figma_id": "12:7", "parent_id": "12:3", "page_id": "0:1",
                "position": 2, "depth": 1, "type": "FRAME", "name": "Card",
                "visible": 1, "x": 0, "y": 0, "width": 320, "height": 200,
                "text": null, "component_key": null, "properties_json": "{}" },
      "bindings": [ { "node_id": "12:7", "field": "fills[0]", "variable_id": "VariableID:1" } ],
      "links": [ { "source_id": "12:7", "target_id": "20:1", "kind": "instance", "label": "Button" } ]
    }
  ],
  "deletes": ["12:3"],
  "truncated": false
}
```

Notes:

- **Upserts, not property diffs.** A `PROPERTY_CHANGE` reports only property *names*;
  mapping those to columns is fragile. Emitting the whole current row via the exporter's
  existing `packNode()` is exact, and it also carries the `position`/`parent_id` updates
  that reparenting and reordering produce. `CREATE` and `PROPERTY_CHANGE` both become
  upserts; the agent writes them the same way.
- **Deletes carry the root ID only.** Children of a deleted subtree are already gone and
  are not enumerable. The agent resolves descendants from its **own** `nodes` table
  (which has `parent_id`) with a recursive delete — the DB is the source of truth for
  the subtree shape.
- **Size cap.** A script that rebuilds a page can produce a large report; cap total
  upserts and set `"truncated": true` with a "ask for a targeted re-export" instruction
  when hit.

## Reuse from the exporter

The delta is the same shape the exporter already streams, so serialization is shared,
not duplicated:

- `packNode(node, parentId, pageId, order, depth)` → `{ node, bindings, links }`
- `packBindingRows`, `packPlain` / `packJSON` — identical sanitization
- Record kinds line up 1:1 with `PACK_INSERTS` keys (`node`, `binding`, `link`), so the
  agent can reuse the insert skeletons it already has.

This is the main reason the report can be "SQL-ready" without a second schema mapping.

## Runtime changes

### `src/code.js`

- Add the change collector + suppression counter.
- Wrap `RUNUserCode`: register → run → unregister → flush.
- On flush, post an `EXECUTION_RESULT` with `kind: 'CHANGE_REPORT'` (reusing the existing
  message avoids a parallel UI branch; the UI picks the header from `kind`).
- Keep the success notify but make it actionable, e.g.
  `📋 Change report copied — paste it back so the snapshot stays current.`
- Errors still notify and additionally flush whatever was captured before the throw.

### `src/ui.html`

- Add `const CHANGE_REPORT_HEADER = '=== FIGMA CHANGE REPORT ===';`.
- In the `EXECUTION_RESULT` branch, choose `CHANGE_REPORT_HEADER` vs
  `FIGMA TOOL RESPONSE` from `msg.kind`.
- Keep the existing auto-copy + alert contract (no new staging buffer; consistent with
  the current clipboard behaviour).

## Prompt changes

This is a real behavioral-contract change, so `SYSTEM_RULES_HEADER` must move with it.

### Rule 4 — split the two contracts

Current rule 4 requires a `return` for `[READ-ONLY]` and forbids a return for
`[WRITE/MUTATION]`. Keep both, but state *why* the write path returns nothing:

> Conversely, `[WRITE/MUTATION]` blocks MUST NOT return a value. The plugin emits an
> authoritative `=== FIGMA CHANGE REPORT ===` describing what your script changed; you
> must not attempt to summarize or diff the change yourself.

### New rule 5 — Snapshot reconciliation

Draft:

> 5. SNAPSHOT RECONCILIATION (keeps the SQLite export fresh):
>    - If the user has provided a FigmaPack `design.db` snapshot, treat
>      `=== FIGMA CHANGE REPORT ===` as the only sanctioned way it is updated.
>    - After every change report, apply it to your copy **before** answering further
>      questions: upsert the reported rows, recursively delete the reported subtrees,
>      refresh the full-text index, and recompute the count metadata.
>    - Do NOT ask the user to re-run the full export for an ordinary edit. Only request a
>      new export when a report is marked `truncated`, when variables or styles changed,
>      or when the report and the database disagree.
>    - Never treat the report as the source of truth for anything it does not mention.

### Generated file prompt (`packAgentPrompt`, `src/database.js`)

The downloadable prompt is the one that actually holds the DB, so it needs the concrete
reconciliation SQL, not just the principle. Add a section mirroring
`## Discovery queries`, e.g. `## Applying change reports`, with:

```sql
-- upsert a reported row (keeps nodes.id stable, so the FTS rowid stays valid)
INSERT INTO nodes (figma_id,parent_id,page_id,position,depth,type,name,visible,
                   x,y,width,height,text,component_key,properties_json)
VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
ON CONFLICT(figma_id) DO UPDATE SET
  parent_id=excluded.parent_id, position=excluded.position, depth=excluded.depth,
  name=excluded.name, visible=excluded.visible, x=excluded.x, y=excluded.y,
  width=excluded.width, height=excluded.height, text=excluded.text,
  component_key=excluded.component_key, properties_json=excluded.properties_json;

-- recursive delete for a reported subtree root
WITH RECURSIVE gone(figma_id) AS (
  SELECT ? UNION ALL
  SELECT n.figma_id FROM nodes n JOIN gone g ON n.parent_id = g.figma_id
)
DELETE FROM nodes WHERE figma_id IN (SELECT figma_id FROM gone);

-- refresh the index after applying a batch
INSERT INTO nodes_fts(nodes_fts) VALUES ('rebuild');
```

Plus a note that `metadata.count_*` goes stale and can be recomputed with
`UPDATE metadata SET value=(SELECT count(*) FROM nodes) WHERE key='count_node';`.

## Gaps and risks

- **Deletes** — only the root ID is reported; the agent must recurse via `parent_id`.
  Covered above, but it is an implicit contract that a naive implementation gets wrong.
- **Variables and styles** — `figma.variables` edits do not reliably appear in
  `documentchange`; styles have a separate `figma.on('stylechange')`. v1 does **not**
  cover them, so the rule 5 text must tell the agent to request a targeted re-export
  when tokens/components change. This is the biggest correctness hole.
- **`OR REPLACE` vs `ON CONFLICT`** — `INSERT OR REPLACE` deletes and re-inserts, giving
  the row a new `id` and invalidating the FTS5 `content_rowid`. The upsert form above
  avoids that; the prompt must not hand the agent the naive form.
- **Dynamic-page loading** — changes to a page that was never `loadAsync()`ed may not be
  reported. Existing `documentAccess: "dynamic-page"` behaviour applies.
- **Noise** — a drag or a bulk rename produces a `PROPERTY_CHANGE` per frame; the cap
  and `truncated` flag exist for this.
- **Ordering** — reports are per-script and must be applied in order; out-of-order
  application on the agent side would corrupt parent/position data.
- **Untestable here** — the live Figma listener cannot be exercised in this environment;
  only mocked coverage plus a SQL-side replay is possible.

## Testing plan

- `tests/test-changes.cjs` — mock `figma.on('documentchange')` and assert the collector
  turns CREATE/DELETE/PROPERTY_CHANGE events into the documented report shape.
- `tests/test-reconcile.py` — build a database from `PACK_SCHEMA`, apply a sample report
  with the prompt's SQL, then assert row contents, recursive delete, FTS search hits and
  `PRAGMA integrity_check`. This validates the contract the prompt teaches the agent,
  independently of Figma.
- Manual: one live session in Figma — create, reparent, rename, delete a subtree, confirm
  each report and re-query the DB after applying it.

## Out of scope (v1)

- Variable and style change capture.
- Continuous capture of the user's own canvas edits (non-script).
- Partial/page-scoped re-export as a fallback.
- A `change_log` / `schema_version: 2` history table.

## Open questions

- Flush granularity: one report per script, or debounce identical rapid changes?
- Cap threshold and the exact `truncated` recovery wording.
- Should a script that both mutates and returns a value emit one report (with the return
  value embedded) or two messages?
- Do we bump `metadata.schema_version` when reports become the sanctioned update path?
