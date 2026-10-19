# In-Session Snapshot Delta Sync Spec

Date: 2026-10-19
Status: **Proposed — design only, no runtime changes made.**
Revision 2 (2026-10-19): variable and style capture moved **into v1** (was listed as the
biggest correctness hole and deferred). Styles ride Figma's `stylechange` feed; variables
have no event at all, so they are captured by a bounded local-token snapshot diff.
Revision 3 (2026-10-19): three design-review decisions.
(a) The variable baseline is **cached** — primed once, re-cached after each run — so a
write run enumerates once, not twice.
(b) The report is **self-describing, not SQL**: `created` carries a full row,
`updated` carries a minimal patch of only the changed fields, `deleted` carries an id.
The plugin describes changes; the agent applies them with its own tooling.
(c) A user-initiated **node snapshot** rides the existing "Copy Selection Context" paste so
the agent can reconcile without a re-export.
The guiding constraint throughout is **complete but bounded** — the clipboard payload and
the agent's context are both finite.
Revision 4 (2026-10-19): completeness is **delegated to the agent**, not guessed by the
plugin. Every payload gains a byte-stable `=== END … ===` footer and declared totals, and
rule 5 primes the agent to refuse any payload it cannot see the end of. This removes the
unknowable transport limit from the plugin entirely.
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
silently diverge — both in **layers** and in **design tokens** (variables, modes, styles).
The only fix available to the user is a full re-export, which is exactly the expensive
operation this feature was supposed to avoid.

## Goal

Keep **one** snapshot usable for the whole session by feeding write results back into
the chat, so the agent can apply the same change to its copy of the database — layer
edits **and** variable / mode / style edits alike.

```text
agent emits [WRITE/MUTATION] ```javascript
  → user pastes into smartPasteField
  → plugin executes it
  → plugin emits  === FIGMA CHANGE REPORT ===   (what actually changed, self-describing)
  → auto-copied, user pastes back into the chat
  → agent applies created / updated / deleted to its copy
  → agent continues answering from an up-to-date snapshot
```

## Correction to the working assumption

The plugin **cannot** update the agent's copy of the snapshot. `design.db` is a downloaded
file that lives in the chat's context, not in Figma. Applying the change is an action the
**agent** performs in the chat. The plugin's only
job is to produce a description that is **complete but bounded**: enough to apply, no more.

## Change capture

The report has to cover **three kinds of mutation**, because Figma exposes them through
three different mechanisms:

| Mutation | Mechanism | Cost |
| --- | --- | --- |
| Layers (create / delete / property) | `figma.on('documentchange')` | passive |
| Styles (create / delete / property) | `figma.on('stylechange')` | passive |
| Variables, values, collections, modes | **no event exists** → bounded local-token snapshot diff | one enumeration per run |

### Layers — `documentchange`

```js
figma.on('documentchange', function (event) {
  // event.documentChanges: [{ type: 'CREATE' | 'DELETE' | 'PROPERTY_CHANGE', id, origin }]
});
```

### Styles — `stylechange`

Figma's `documentchange` feed does carry `STYLE_CREATE` / `STYLE_DELETE` /
`STYLE_PROPERTY_CHANGE`, but the dedicated `figma.on('stylechange')` event is the
documented, granular alternative and is the right one here. Listen to it:

```js
figma.on('stylechange', function (event) {
  // event.styleChanges: [{ type: 'STYLE_CREATE' | 'STYLE_DELETE' | 'STYLE_PROPERTY_CHANGE',
  //                        id, style }]   // style is null for STYLE_DELETE
});
```

`STYLE_CREATE` / `STYLE_PROPERTY_CHANGE` → re-serialize the whole style row via the
exporter's style serializer and report it as a create/patch. `STYLE_DELETE` carries only
the id → report a delete by `figma_id`.

### Variables — no event, so diff a bounded snapshot

Figma does **not** report variable or variable-collection edits in any change feed
(`DocumentChange` is limited to node and style changes). So variables are captured by
enumerating the local token tables around a script run and emitting the difference:

- **Baseline — cached, not re-enumerated.** The signature map (`id → hash of the serialized
  record`) is built once during priming/export and held in the sandbox for the session.
  Each write run enumerates **once** (the "after" state), diffs against the cache, then
  **overwrites** the cache with the new state. One enumeration per run, not two.
- **Diff** — for every id that is new or whose signature changed, emit upserts
  (`collection`, `mode`, `variable`, `value`); for every id that disappeared, emit a delete;
  then re-cache from the post-run state.
- **Bounded by design.** This is *not* the full-document walk the alternatives table
  rejects: it touches only token tables, and `SAFETY_LIMITS.MAX_VARIABLES` (300) caps the
  local-variable count. A collection/variable created *and* deleted inside a single script
  is invisible (net zero), which is acceptable.
- **Cached-baseline caveat — mis-attribution, not corruption.** A variable the user edits
  by hand between runs sits in the cache as its old value, so the next script's report
  lists it as changed even though the script did not touch it. This is narrative noise, not
  data loss: every run re-caches the true current state, so the agent's copy still
  converges to Figma after each run.

Why this over the alternatives:

| Option | Verdict |
| --- | --- |
| `documentchange` + `stylechange` + local-variable diff | Passive for layers/styles; one small, capped enumeration for variables. **Chosen.** |
| Full before/after document walk + diff | Correct but costs a full traversal per write — defeats the point. |
| Require the agent's script to `return` a manifest | Unreliable (model-authored), and rule 4 currently forbids it. |

Requirements:

- **Scoped to script runs.** Register the listeners before `RUNUserCode` executes; flush
  after it settles (including on throw, so partial mutations are still reported), then
  re-cache the variable baseline.
- **Suppressed during bulk scans.** The exporter and the priming scan must not pollute
  the feed; wrap them in a suppression counter (`suppressChanges++ / --`), since
  `page.loadAsync()` and traversal are not user-visible edits.
- **Out-of-band edits are a bonus, not v1.** The feeds also report the user's own canvas
  edits (`origin: 'LOCAL'`), and an out-of-band variable edit would surface as a diff the
  next time a script runs. Capturing these continuously would keep the copy fresh with no
  script at all, but it is noisy and deferred (see Out of scope). The user-initiated node
  snapshot is the v1 answer instead.

## Report format

Byte-stable header **and footer**, consistent with the existing `=== FIGMA … ===` family:

```text
=== FIGMA CHANGE REPORT ===
{ … one JSON object, shape below … }
=== END FIGMA CHANGE REPORT ===
```

Payload: one JSON object (the existing tool response already permits JSON or string). The
footer is not decoration — it is how the agent tells a complete paste from a cut-off one.
See *Payload completeness* below.

The report is a **changelog, not a set of database instructions**. It describes what
changed; the agent applies it with whatever store it keeps. Three operations, sized by
one rule: *never re-send what the agent already has.*

```json
{
  "kind": "CHANGE_REPORT",
  "script": "created 4 nodes, changed 2, deleted 1, updated 3 tokens",
  "counts": { "created": 4, "updated": 2, "deleted": 1, "tokens": 3 },
  "created": [
    {
      "node": { "figma_id": "12:7", "parent_id": "12:3", "page_id": "0:1",
                "position": 2, "depth": 1, "type": "FRAME", "name": "Card",
                "visible": 1, "x": 0, "y": 0, "width": 320, "height": 200,
                "text": null, "component_key": null, "properties_json": "{}" },
      "bindings": [ { "node_id": "12:7", "field": "fills[0]", "variable_id": "VariableID:1" } ],
      "links": [ { "source_id": "12:7", "target_id": "20:1", "kind": "instance", "label": "Button" } ]
    }
  ],
  "updated": [
    { "figma_id": "12:9", "set": { "name": "Card 2", "width": 340 } },
    { "figma_id": "12:4", "set": { "properties_json": "{...}" },
      "bindings": [ { "node_id": "12:4", "field": "fills[0]", "variable_id": "VariableID:2" } ] }
  ],
  "deleted": ["12:3"],
  "tokens": {
    "created": [ { "kind": "variable", "data": { "figma_id": "VariableID:1", "name": "color/primary" } } ],
    "updated": [ { "kind": "value", "key": { "variable_id": "VariableID:1", "mode_id": "9:0" },
                   "set": { "value_json": "{...}", "alias_variable_id": null } } ],
    "deleted": [ { "kind": "variable", "figma_id": "VariableID:9" },
                 { "kind": "style", "figma_id": "S:cd" } ]
  },
  "geometry_stale": false,
  "truncated": false
}
```

Notes:

- **`created` carries a full row.** The agent has no base to patch, so a new node (and
  its `bindings` / `links`) is sent whole, using the exporter's existing `packNode()` shape.
- **`updated` carries a minimal patch.** `set` lists only the fields that actually changed,
  keyed by the exporter's own field names (`name`, `visible`, `x`, `y`, `width`, `height`,
  `text`, `component_key`, `parent_id`, `position`, `depth`, `properties_json`). The
  agent assigns each named field onto the existing row; everything absent is unchanged.
  `parent_id` / `position` / `depth` appear when reparenting or reordering occurs.
- **Updates are safe without a baseline.** Figma's `PROPERTY_CHANGE` reports property
  *names*; the collector maps those names to exporter fields and reads the **current**
  value through the existing accessors. A patch needs the new value, not the old one — so
  no stored copy of node state is required. If a reported property has no mapping, fall
  back to sending the whole row for that node (correctness over size).
- **`properties_json` is atomic.** Design/layout/paint/effect detail lives inside one JSON
  column, so a change to any of it ships the whole refreshed `properties_json`, never a
  sub-patch. When nothing rich changed it is omitted — the single largest saving, since
  `properties_json` dominates row size.
- **Bindings and links are replaced, not patched.** They are small and keyed; when they
  change, the update carries the node's new `bindings` / `links` sets, which replace the
  old ones wholesale (a partial add/remove list would be ambiguous).
- **`deleted` carries the root ID only.** Children of a deleted subtree are already gone
  and are not enumerable. The agent resolves descendants from its **own** copy (which
  has `parent_id`) — the copy, not the report, is the source of truth for subtree shape.
- **Token operations follow the same split.** New definitions go in `tokens.created` (full
  `{ kind, data }` records in the exporter's envelope); changed definitions go in
  `tokens.updated` as `{ kind, key, set }` patches; removals go in `tokens.deleted` as
  `{ kind, figma_id }`. Token deletes cascade to dependents (a `variable` takes its
  `variable_values`; a `collection` takes its `variable_modes` and `variables`).
- **`geometry_stale`.** A changed `value` or `style` can change the *resolved* geometry of
  nodes bound to it, and those nodes emit no node change of their own. Set
  `geometry_stale: true` whenever a `value` or `style` changes; rule 5 tells the agent to
  request a re-export only when exact geometry actually matters.
- **Size cap — a hang guard, and the `truncated` flag.** A script that rebuilds a page can
  produce a huge report; the plugin stops at a **plugin-sanity** ceiling and sets
  `"truncated": true` with an "ask for a targeted re-export" instruction. That ceiling keeps
  the payload buildable — it does not model any chat's limit, which is unknowable. This flag
  covers the plugin *choosing* to stop early; a payload cut in **transit** is caught
  differently, by the footer and declared counts (see *Payload completeness*).

## Payload completeness — the agent's check, not our guess

Applies to **both** clipboard payloads — the change report and the node snapshot.

We cannot know any transport limit. The chat's input field and, more often, the model's
**context window** both vary by product, model and version, with no API to query — so the
plugin does not guess a number. Instead every payload is **self-verifying**, and the agent is
primed to verify it:

- **Explicit footer.** Every payload ends with a byte-stable footer
  (`=== END FIGMA CHANGE REPORT ===` / `=== END FIGMA NODE SNAPSHOT ===`). If it is missing,
  the paste was cut off.
- **Declared totals.** A report states its own `counts`; a snapshot states `node_count`. If
  the totals do not match what the agent actually received, the content was cut.
- **Primed to report, not to guess.** Rule 5 tells the agent: a payload is complete only if
  the footer is present and the totals agree. If not, it must **not apply it** — it says the
  message was cut off and asks the user to copy a smaller selection or request a targeted
  re-export.

This replaces a limit we cannot know with a signal the agent can always check, and it costs
the plugin nothing. The UI still shows the measured size before copying (*"312 nodes, ~410 KB
— this may exceed your chat's paste limit"*) so the user can pre-empt a wasted round-trip, but
it does not refuse: the agent is the authority on whether the paste survived.

The only remaining plugin-side number is the **hang guard** from the report's size cap, whose
job is to stop the iframe locking up while serializing — an engineering guard, not a size
policy.

## Node snapshots (user-initiated)

The change report only covers what a *script* changed. The user's own manual edits — drag,
rename, restyle by hand — are invisible to the script-scoped listeners. Rather than watch
the canvas continuously, the plugin reuses a paste the user already performs: "Copy
Selection Context" gains a machine-applicable block beside its existing prose.

```text
=== FIGMA SELECTION CONTEXT ===
- **FRAME**: "Card" [320x200] | Fills: #FFFFFF        <- existing prose, unchanged

=== FIGMA NODE SNAPSHOT ===
{"kind":"NODE_SNAPSHOT","page_id":"0:1","node_count":312,
 "nodes":[{"node":{<full row>},"bindings":[...],"links":[...]}]}
=== END FIGMA NODE SNAPSHOT ===
```

All three markers are byte-stable and belong to the `=== FIGMA … ===` family. The agent reads
the prose for spatial reasoning and applies the snapshot block — through the *same* routine
it uses for a change report, so there is only one reconciliation path to reason about.

- **Whole rows, not patches.** A snapshot is the **resync** channel — it exists because the
  agent's copy may have drifted with no record of what moved, so it must stand alone. See
  the format decision below.
- **Upsert-only.** A snapshot shows what exists; it cannot see what was deleted. Deletions
  arrive through a change report or a re-export.
- **Nodes, bindings and links only.** A node records which variable it is bound to, but not
  the variable's definition or per-mode value, so a snapshot never rewrites token
  definitions.
- **Ancestors may be absent.** A deep selection carries `parent_id`s that may not be in the
  payload; the agent keeps its existing parent row and applies only what the snapshot
  lists.
- **Never silently partial.** A snapshot is either whole or it is not applied — see
  *Payload completeness*.

This is the manual counterpart to the deferred automatic capture below: out-of-band edits
reach the agent when the user chooses to share a region, not continuously.

### Format decision — whole rows, not a bespoke format or SQL

Three options were weighed for the snapshot payload:

| Option | Verdict |
| --- | --- |
| Whole exporter rows | **Chosen.** The region becomes provably correct regardless of what the agent held before. |
| A custom, concise format | Rejected — it cannot be both smaller and complete. It would compress by dropping fields, and it would break byte-identity with export rows, adding a second mapping to keep in sync. |
| Raw SQL statements | Rejected — verbose (keywords, quoting, escaping of `properties_json`), couples the payload to our table layout (making the plugin the storage layer it is not), and useless to an agent that reasons over the file rather than executing it. |

Whole rows are **not a necessary evil — they are the point of this channel.** A patch is safe
in the change report because the agent's base was *just* brought current by the export or a
prior report. A snapshot exists for precisely the case where that base is *not* trustworthy,
so it must be self-sufficient. The cost is controlled by **scope, not format**: the user
selects a region, and the payload is capped.

If measurements ever show a selected region routinely overflowing, the fix is **not** a new
format — it is to give snapshots the change report's patch shape, which means caching a node
baseline the same way the variable baseline is cached (Option B above). Same vocabulary,
smaller payload, at the cost of the repair guarantee. Deferred as a v2 option.

## Reuse from the exporter

The delta reuses the exporter's serialization rather than duplicating it, so a `created`
row, a snapshot row and an export row are all literally the same bytes:

- `packNode(node, parentId, pageId, order, depth)` → `{ node, bindings, links }` — used by
  the exporter, by a change report's `created`, and by a node snapshot.
- `packBindingRows`, `packPlain` / `packJSON` — identical sanitization.
- Token records reuse the exporter's `{ kind, data }` envelope, so `created` /
  `tokens.created` entries are byte-identical to what `PACK_BATCH` streams.

The one deliberate divergence is the change report's `updated` patch, which is *smaller*
than a row by construction. It is built from the same field accessors, so the field names
and value shapes still match the exported row exactly — the agent assigns them onto the
row it already holds.

This shared shape is why the delta is self-describing without a second mapping layer — and
it is what lets the agent apply a report using nothing but the file it already has.

**Required extraction.** The variable and style records (`collection` / `mode` /
`variable` / `value` / `style`) are currently built *inline* inside `packExport`
(`src/exporter.js`, the `figma.variables` and `styleGetters` blocks). Extract them into
named functions so the exporter and the delta collector share one implementation:

- `packCollectionRecords(collection, position)` → `collection` + `mode` records
- `packVariableRecords(variable)` → `variable` + `value` records
- `packStyleRecords(style, styleType)` → `style` record
- `packNodeRecords(root, pageId)` → the iterative subtree walk the exporter already
  performs inline (`packExport`'s stack loop), returning the same `{ node, bindings, links }`
  entries. Used by a change report's `created` roots and by node snapshots.

The node serializer is already factored (`packNode`); the walk and the token serializers are
not. Extraction must not change the emitted bytes, so `tests/test-exporter.cjs` keeps
passing unchanged.

## Runtime changes

### `src/code.js`

- Add the change collector: node feed (`documentchange`), style feed (`stylechange`),
  and the local-variable baseline/diff, plus the suppression counter.
- Extract `packCollectionRecords` / `packVariableRecords` / `packStyleRecords` /
  `packNodeRecords` from `packExport` so the collector and the exporter emit identical rows.
- Wrap `RUNUserCode`: register listeners → run → unregister + enumerate → flush → re-cache
  the variable baseline.
- Build the report as `created` (whole `packNode` rows) / `updated` (minimal `set` patches,
  mapped from `PROPERTY_CHANGE` property names to exporter fields via a fixed table) /
  `deleted` (ids), plus the `tokens` create/patch/delete block and the `geometry_stale` flag.
- On flush, post an `EXECUTION_RESULT` with `kind: 'CHANGE_REPORT'` (reusing the existing
  message avoids a parallel UI branch; the UI picks the header from `kind`).
- Add a selection-snapshot responder: on the UI's request, run `packNodeRecords` over
  `figma.currentPage.selection` and post the rows back. Computing on demand (not on every
  `selectionchange`) keeps the hover path cheap and lets instance links resolve via
  `getMainComponentAsync`.
- Keep the success notify but make it actionable, e.g.
  `📋 Change report copied — paste it back so the snapshot stays current.`
- Errors still notify and additionally flush whatever was captured before the throw.

### `src/ui.html`

- Add `const CHANGE_REPORT_HEADER` / `CHANGE_REPORT_FOOTER` and
  `const NODE_SNAPSHOT_HEADER` / `NODE_SNAPSHOT_FOOTER` (the `=== END … ===` pair).
- In the `EXECUTION_RESULT` branch, choose `CHANGE_REPORT_HEADER` vs
  `FIGMA TOOL RESPONSE` from `msg.kind`, and always close a report with its footer.
- Make `contextBtn.onclick` async: copy `SELECTION CONTEXT` prose + the `NODE SNAPSHOT`
  block and its footer in one clipboard write, and show the measured size (nodes + KB) in
  the alert so the user can pre-empt a cut-off. If the snapshot request fails or times out,
  fall back to the prose-only payload (the button must never block on the sandbox).
- Keep the existing auto-copy + alert contract (no new staging buffer; consistent with
  the current clipboard behaviour).

## Prompt changes

This is a real behavioral-contract change, so `SYSTEM_RULES_HEADER` must move with it.

### Rule 4 — split the two contracts

Current rule 4 requires a `return` for `[READ-ONLY]` and forbids a return for
`[WRITE/MUTATION]`. Keep both, but state *why* the write path returns nothing:

> Conversely, `[WRITE/MUTATION]` blocks MUST NOT return a value. The plugin emits an
> authoritative `=== FIGMA CHANGE REPORT ===` describing what your script changed —
> including variable, mode and style edits; you must not attempt to summarize or diff the
> change yourself.

### New rule 5 — Snapshot reconciliation

Draft:

> 5. SNAPSHOT RECONCILIATION (keeps your copy of the file current):
>    - `=== FIGMA CHANGE REPORT ===` and `=== FIGMA NODE SNAPSHOT ===` are the only
>      sanctioned updates to your copy. Apply each one, in the order given, before
>      answering further questions.
>    - **First, check the payload arrived whole.** A payload is complete only if its
>      `=== END … ===` footer is present *and* its declared totals (`counts` on a report,
>      `node_count` on a snapshot) match what you actually received. If the footer is
>      missing or the totals do not agree, the message was **cut off**: do NOT apply it,
>      tell the user it was truncated, and ask them to copy a smaller selection or request a
>      targeted re-export. Never apply a payload you cannot see the end of.
>    - A change report is a **changelog, not instructions**: `created` carries whole rows,
>      `updated` carries merge patches (assign only the named fields onto the row you
>      already hold), `deleted` carries subtree-root ids (remove each node and its
>      descendants as you hold them).
>    - A node snapshot is the user's current truth for the region they selected: add or
>      replace the rows it lists. It cannot express deletions and never rewrites token
>      definitions.
>    - You own the mechanics. The report describes *what changed*; how you store it is
>      yours to decide.
>    - Only ask for a full re-export when a report is `truncated` (the plugin stopped
>      early), when `geometry_stale` is set and you need exact geometry, or when a report and
>      your copy disagree.
>    - Never treat a report or snapshot as the source of truth for anything it does not
>      mention.

**Numbering note.** The Explorative template already uses `5.` for
`EXPLORATIVE DISCOVERY METHOD`. The new rule becomes `5` and the discovery rule is
renumbered to `6` in that template (the prompt text is not parsed, so the number is
cosmetic, but the two must not collide).

### Generated file prompt (`packAgentPrompt`, `src/database.js`)

The downloadable prompt is the one that actually holds the agent's copy, so it should
describe the reconciliation **semantics**, not dictate storage. Add an
`## Applying change reports` section stating:

- The three operations and how to apply each: `created` = add the whole rows; `updated` =
  assign only the named fields onto the row already held; `deleted` = remove the subtree
  rooted at that id. Tokens split the same way.
- That a payload is **complete only if its `=== END … ===` footer is present and its declared
  totals match** — otherwise it was cut off and must not be applied; ask for a smaller copy
  or a re-export.
- That a report is applied in order and is authoritative for everything it mentions.
- That `=== FIGMA NODE SNAPSHOT ===` is an upsert-only resync of a user-selected region.
- That a token change can leave resolved node geometry stale (`geometry_stale`).

Do **not** paste SQL into the prompt. The agent applies the report with its own tooling;
handing it our table layout would make the plugin the storage layer, which it is not — and
it would spend the agent's budget on instructions instead of facts.

Also update the existing `## Workflow with the live plugin` paragraph: today it says ask
for a new export "for recent edits". Replace that with "apply the latest
`=== FIGMA CHANGE REPORT ===` / `=== FIGMA NODE SNAPSHOT ===`", keeping a re-export as the
`truncated` / `geometry_stale` fallback only.

## Gaps and risks

- **Deletes carry an id and nothing else.** Only the subtree root is reported, because the
  children are already gone and cannot be enumerated. The agent must recurse through the
  copy it holds. Token deletes are the same shape and must cascade to dependents (a
  `variable` takes its values; a `collection` takes its modes and variables).
- **Patches trust the base row.** An `updated` patch is a merge — the agent assigns the
  named fields onto the row it already holds. If its copy is missing that row (drifted, or
  a fresh start), the patch has nowhere to land. The remedy is a node snapshot or a
  re-export, not a fatter report; the size cap is deliberate.
- **Property-name mapping is the fragile edge.** `PROPERTY_CHANGE` names are mapped to
  exporter fields through a fixed table. A change we do not map is silently dropped, and an
  unmapped-but-real change (e.g. a rich field hidden inside `properties_json`) must fall
  back to sending the whole row. This mapping is the main place correctness can leak.
- **Variables have no change event** — the one non-event-driven path. The *cached* baseline
  (Option B) means an out-of-band variable edit is attributed to the next script run rather
  than caught immediately; it is narrative noise, not corruption, because each run re-caches
  the true state. A variable created and destroyed inside one script is invisible entirely.
- **Geometry staleness after token edits** — changing a variable value or a style changes
  the *resolved* geometry of the nodes bound to it, and those nodes emit no node change of
  their own. The `geometry_stale` flag is the mitigation: it tells the agent to request a
  targeted re-export when exact geometry actually matters. Token *definitions* are fully
  covered; resolved geometry is not.
- **Snapshots are lossy by nature** — upsert-only, nodes/bindings/links only, no deletions.
  They reconcile drift, they do not replace a re-export.
- **The completeness check depends on the agent cooperating.** Detection is only as good as
  the primed rule: a model that ignores the missing footer can still apply a cut-off payload.
  The footer plus declared totals make the check cheap and unambiguous, but they cannot force
  it. This is the residual risk of refusing to guess a limit.
- **Dynamic-page loading** — changes to a page that was never `loadAsync()`ed may not be
  reported. Existing `documentAccess: "dynamic-page"` behaviour applies. `stylechange`
  and the variables APIs are usable without `loadAllPagesAsync`, which is why styles do
  not use the `STYLE_*` `documentchange` entries.
- **Noise** — a drag or a bulk rename produces a `PROPERTY_CHANGE` per frame; the cap
  and `truncated` flag exist for this.
- **Ordering** — reports are per-script and must be applied in order; out-of-order
  application would corrupt parent/position data.
- **Untestable here** — the live Figma listeners cannot be exercised in this environment;
  only mocked coverage plus a replay through a real SQLite file is possible.

## Testing plan

- `tests/test-changes.cjs` (nodes) — mock `figma.on('documentchange')` and
  `figma.on('stylechange')` and assert the collector turns CREATE / DELETE /
  PROPERTY_CHANGE and STYLE_* events into `created` / `updated` / `deleted`.
- `tests/test-changes.cjs` (patches) — assert a `PROPERTY_CHANGE` produces a *minimal* `set`
  (only the changed fields, exporter field names), that reparenting adds
  `parent_id`/`position`/`depth`, and that an unmapped property falls back to a whole row.
- `tests/test-changes.cjs` (variables) — mock the token APIs around two states and assert
  the cached-baseline diff emits the right create/patch/delete entries and sets
  `geometry_stale` when a value changed.
- `tests/test-snapshot.cjs` — mock a selection and assert it serializes to a
  `NODE_SNAPSHOT` block of whole rows via `packNodeRecords`, wrapped by its header and
  footer.
- `tests/test-envelope.cjs` — assert every payload (report and snapshot) is closed by its
  `=== END … ===` footer and that its declared totals match the arrays it carries; and that a
  truncated copy fails the check.
- `tests/test-reconcile.py` — build a database from `PACK_SCHEMA`, apply a sample report
  *and* a sample snapshot through the documented operations, then assert row contents,
  patch application, subtree delete, token cascade deletes, FTS search hits and
  `PRAGMA integrity_check`. This validates the semantics the prompt describes, independently
  of Figma.
- Manual: one live session in Figma — create, reparent, rename, delete a subtree, recolor a
  variable and edit a style, then paste a selection snapshot; confirm each payload and
  re-query the DB after applying it.

## Out of scope (v1)

- Automatic / continuous capture of the user's own canvas edits. (The *user-initiated* node
  snapshot is in v1; the plugin does not watch the canvas.)
- Automatic capture of out-of-band variable edits (they surface on the next script run).
- Partial/page-scoped re-export as a fallback.
- A `change_log` / `schema_version: 2` history table.

## Open questions

- Flush granularity: one report per script, or debounce identical rapid changes?
- Should a script that both mutates and returns a value emit one report (with the return
  value embedded) or two messages?
- Hang-guard default: what is the plugin-sanity ceiling that stops the iframe locking up
  while serializing? It is an engineering guard, not a size policy — the agent owns the
  transport limit now.
- Node baseline for snapshots (v2): is a cached node signature worth the memory to let
  snapshots use the report's patch shape instead of whole rows?
- Do we bump `metadata.schema_version` when reports become the sanctioned update path
  (the token tables already exist, so no DDL change is strictly required)?
