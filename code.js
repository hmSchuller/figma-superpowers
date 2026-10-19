/* FigmaPack: runs inside Figma's plugin sandbox, not Node.js. */
const PACK_BATCH_SIZE = 200;
const PACK_REPORT_LIMIT = 2000;
let activeExport = null;

/* Change-report collector state. Listeners are bound lazily and only record while a
   script run is active (packChangeCollector is non-null) and suppression is off. */
let packChangeCollector = null;
let packSuppressChanges = 0;
let packTokenBaseline = null;
let packListenersBound = false;

function packSafe(object, property, fallback) {
  try {
    const value = object[property];
    return value === undefined || value === figma.mixed ? fallback : value;
  } catch (error) {
    return fallback;
  }
}

function packPlain(value, depth) {
  if (depth > 7) return null;
  if (value === undefined || value === null || value === figma.mixed) return null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string' || typeof value === 'boolean') return value;
  if (Array.isArray(value)) return value.map(function (item) { return packPlain(item, depth + 1); });
  if (typeof value !== 'object') return null;
  const result = {};
  Object.keys(value).forEach(function (key) {
    const item = value[key];
    if (typeof item !== 'function' && item !== undefined) result[key] = packPlain(item, depth + 1);
  });
  return result;
}

function packJSON(value) {
  return JSON.stringify(packPlain(value, 0));
}

function packProperty(object, key) {
  const value = packSafe(object, key, undefined);
  return value === undefined ? undefined : packPlain(value, 0);
}

function packBindingRows(bindings, figmaId, prefix, output) {
  if (!bindings || typeof bindings !== 'object') return;
  Object.keys(bindings).forEach(function (field) {
    const val = bindings[field];
    const path = prefix ? prefix + '.' + field : field;
    if (val && typeof val === 'object' && val.type === 'VARIABLE_ALIAS' && val.id) {
      output.push({ node_id: figmaId, field: path, variable_id: val.id });
    } else if (Array.isArray(val)) {
      val.forEach(function (item, index) {
        packBindingRows({ value: item }, figmaId, path + '[' + index + ']', output);
      });
    } else if (val && typeof val === 'object') {
      packBindingRows(val, figmaId, path, output);
    }
  });
}

/* Design/layout/paint/effect detail compacted into the single properties_json column. */
const PACK_RICH_FIELDS = [
  'layoutMode', 'primaryAxisAlignItems', 'counterAxisAlignItems', 'primaryAxisSizingMode',
  'counterAxisSizingMode', 'layoutAlign', 'layoutGrow', 'layoutSizingHorizontal',
  'layoutSizingVertical', 'layoutWrap', 'itemSpacing', 'counterAxisSpacing',
  'paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft', 'minWidth', 'maxWidth',
  'minHeight', 'maxHeight', 'cornerRadius', 'topLeftRadius', 'topRightRadius',
  'bottomLeftRadius', 'bottomRightRadius', 'opacity', 'blendMode', 'clipsContent',
  'rotation', 'fills', 'strokes', 'strokeWeight', 'strokeAlign', 'effects',
  'fontName', 'fontSize', 'fontWeight', 'textAlignHorizontal', 'textAlignVertical',
  'lineHeight', 'letterSpacing', 'textAutoResize', 'textCase', 'textDecoration',
  'paragraphSpacing', 'paragraphIndent', 'componentProperties',
  'componentPropertyDefinitions', 'variantProperties',
  'explicitVariableModes', 'reactions', 'flowStartingPoints',
  'layoutGrids', 'gridRowCount', 'gridColumnCount', 'gridCell', 'exportSettings',
  'fillStyleId', 'strokeStyleId', 'effectStyleId', 'gridStyleId', 'textStyleId',
  'description', 'documentationLinks', 'isAsset', 'devStatus', 'locked',
  'relativeTransform', 'constraints', 'overflowDirection'
];

/* Variable aliases have a normalized home in `node_variable_bindings`, so the copies
   embedded in properties_json (top level and inside fills/strokes/effects/layoutGrids)
   would store the same data twice. Drop exactly those paths after collecting the rows.
   Aliases nested anywhere else (e.g. componentProperties) have no table home and stay. */
const PACK_EMBEDDED_BINDING_FIELDS = ['fills', 'strokes', 'effects', 'layoutGrids'];

/* Remove empty containers and empty strings from the serialized property bag: absence
   already means "empty", and ~53k nodes each carrying `[]`/`{}`/`""` is pure weight. */
function packPrune(value) {
  if (Array.isArray(value)) return value.map(packPrune);
  if (value && typeof value === 'object') {
    const result = {};
    Object.keys(value).forEach(function (key) {
      const item = packPrune(value[key]);
      if (item === '') return;
      if (item && typeof item === 'object' && Object.keys(item).length === 0) return;
      result[key] = item;
    });
    return result;
  }
  return value;
}

function packNode(node, parentId, pageId, order, depth) {
  const extra = {};
  PACK_RICH_FIELDS.forEach(function (field) {
    const value = packProperty(node, field);
    if (value !== undefined && value !== null) extra[field] = value;
  });
  const bindingRows = [];
  packBindingRows(packProperty(node, 'boundVariables'), node.id, '', bindingRows);
  PACK_EMBEDDED_BINDING_FIELDS.forEach(function (field) {
    if (!Array.isArray(extra[field])) return;
    extra[field].forEach(function (item, i) {
      if (!item || typeof item !== 'object') return;
      packBindingRows(item.boundVariables, node.id, field + '[' + i + ']', bindingRows);
      delete item.boundVariables;
    });
  });
  const text = node.type === 'TEXT' ? packSafe(node, 'characters', '') : '';
  const componentKey = packSafe(node, 'key', null);
  const record = {
    figma_id: node.id,
    parent_id: parentId,
    page_id: pageId,
    position: order,
    depth: depth,
    type: node.type,
    name: node.name || '',
    visible: packSafe(node, 'visible', true) ? 1 : 0,
    x: packSafe(node, 'x', null),
    y: packSafe(node, 'y', null),
    width: packSafe(node, 'width', null),
    height: packSafe(node, 'height', null),
    text: text,
    component_key: componentKey,
    properties_json: JSON.stringify(packPrune(extra))
  };
  const links = [];
  const reactions = extra.reactions;
  if (Array.isArray(reactions)) {
    reactions.forEach(function (reaction) {
      const action = reaction && reaction.action;
      if (action && action.destinationId) {
        links.push({ source_id: node.id, target_id: action.destinationId,
          kind: 'prototype', label: action.type || '' });
      }
      if (reaction && Array.isArray(reaction.actions)) {
        reaction.actions.forEach(function (nested) {
          if (nested && nested.destinationId) {
            links.push({ source_id: node.id, target_id: nested.destinationId,
              kind: 'prototype', label: nested.type || '' });
          }
        });
      }
    });
  }
  return { node: record, bindings: bindingRows, links: links };
}

/* Iterative subtree walk. Returns [{ node, bindings, links }] in the exporter's layer
   order; `parentId`/`position`/`depth` describe where `root` sits. Shared by the full
   export, a change report's `created` roots and a node snapshot, so all three emit the
   same bytes. */
async function packNodeRecords(root, pageId, parentId, position, depth) {
  const records = [];
  const stack = [{ node: root, parent: parentId, index: position, depth: depth }];
  while (stack.length) {
    const entry = stack.pop();
    const record = packNode(entry.node, entry.parent, pageId, entry.index, entry.depth);
    if (entry.node.type === 'INSTANCE' && typeof entry.node.getMainComponentAsync === 'function') {
      const main = await entry.node.getMainComponentAsync();
      if (main) {
        record.links.push({ source_id: entry.node.id, target_id: main.id,
          kind: 'instance', label: main.name || '' });
      }
    }
    records.push(record);
    if ('children' in entry.node) {
      const children = entry.node.children;
      for (let i = children.length - 1; i >= 0; i--) {
        stack.push({ node: children[i], parent: entry.node.id, index: i, depth: entry.depth + 1 });
      }
    }
  }
  return records;
}

function packCollectionRecords(collection) {
  const records = [{ kind: 'collection', data: {
    figma_id: collection.id, name: collection.name, key: collection.key || null,
    default_mode_id: collection.defaultModeId || null,
    remote: collection.remote ? 1 : 0,
    properties_json: packJSON({ hiddenFromPublishing: collection.hiddenFromPublishing,
      variableIds: collection.variableIds })
  }}];
  (collection.modes || []).forEach(function (mode, index) {
    records.push({ kind: 'mode', data: { collection_id: collection.id, mode_id: mode.modeId,
      name: mode.name, position: index } });
  });
  return records;
}

function packVariableRecords(variable) {
  const records = [{ kind: 'variable', data: {
    figma_id: variable.id, collection_id: variable.variableCollectionId,
    name: variable.name, key: variable.key || null,
    resolved_type: variable.resolvedType, description: variable.description || '',
    properties_json: packJSON({ scopes: variable.scopes,
      codeSyntax: variable.codeSyntax, hiddenFromPublishing: variable.hiddenFromPublishing,
      remote: variable.remote })
  }}];
  Object.keys(variable.valuesByMode || {}).forEach(function (modeId) {
    const value = variable.valuesByMode[modeId];
    records.push({ kind: 'value', data: {
      variable_id: variable.id, mode_id: modeId,
      value_json: packJSON(value),
      alias_variable_id: value && value.type === 'VARIABLE_ALIAS' ? value.id : null
    }});
  });
  return records;
}

function packStyleType(style) {
  return (style && (style.styleType || style.type)) || null;
}

function packStyleRecords(style, styleType) {
  const properties = {};
  ['paints', 'fontName', 'fontSize', 'lineHeight', 'letterSpacing',
    'paragraphSpacing', 'textCase', 'textDecoration', 'effects', 'layoutGrids']
    .forEach(function (field) {
      const value = packProperty(style, field);
      if (value !== undefined) properties[field] = value;
    });
  return [{ kind: 'style', data: {
    figma_id: style.id, key: style.key || null, name: style.name,
    style_type: styleType || packStyleType(style), description: style.description || '',
    properties_json: JSON.stringify(properties)
  }}];
}

async function packPostBatch(state, records) {
  if (!records.length || state.cancelled) return;
  const sequence = ++state.sequence;
  await new Promise(function (resolve, reject) {
    state.pending = { sequence: sequence, resolve: resolve, reject: reject };
    figma.ui.postMessage({ type: 'PACK_BATCH', sequence: sequence, records: records });
  });
  if (state.cancelled) throw new Error('Export cancelled');
}

function packSendError(error) {
  figma.ui.postMessage({ type: 'PACK_ERROR', message: error.message || String(error) });
}

async function packExport() {
  if (activeExport) return;
  const state = { sequence: 0, pending: null, cancelled: false, nodeCount: 0, pageCount: 0 };
  activeExport = state;
  let batch = [];
  const oldSkipInvisibleChildren = figma.skipInvisibleInstanceChildren;
  packBeginSuppression();
  try {
    figma.skipInvisibleInstanceChildren = false;
    const pages = figma.root.children.slice();
    figma.ui.postMessage({ type: 'PACK_META', metadata: {
      file_name: figma.root.name || 'Untitled',
      file_key: figma.fileKey || null,
      exported_at: new Date().toISOString(),
      schema_version: '1',
      page_count: String(pages.length),
      source: 'Figma Superpowers / FigmaPack',
      node_export: 'complete',
      images_included: 'false',
      external_library_variables: 'not-expanded'
    }});
    for (let pi = 0; pi < pages.length; pi++) {
      if (state.cancelled) throw new Error('Export cancelled');
      const page = pages[pi];
      await page.loadAsync();
      batch.push({ kind: 'page', data: {
        figma_id: page.id, name: page.name, position: pi,
        properties_json: packJSON({ explicitVariableModes: packSafe(page, 'explicitVariableModes', {}) })
      }});
      // Iterative traversal avoids call-stack overflows and preserves layer ordering.
      for (let ci = 0; ci < page.children.length; ci++) {
        const records = await packNodeRecords(page.children[ci], page.id, page.id, ci, 0);
        for (let ri = 0; ri < records.length; ri++) {
          if (state.cancelled) throw new Error('Export cancelled');
          const record = records[ri];
          batch.push({ kind: 'node', data: record.node });
          record.bindings.forEach(function (binding) { batch.push({ kind: 'binding', data: binding }); });
          record.links.forEach(function (link) { batch.push({ kind: 'link', data: link }); });
          state.nodeCount++;
          if (batch.length >= PACK_BATCH_SIZE) {
            await packPostBatch(state, batch);
            batch = [];
          }
        }
      }
      state.pageCount++;
      figma.ui.postMessage({ type: 'PACK_PROGRESS', pages: state.pageCount,
        totalPages: pages.length, nodes: state.nodeCount });
    }
    if (figma.variables) {
      const collections = await figma.variables.getLocalVariableCollectionsAsync();
      const tokenRecords = [];
      collections.forEach(function (collection) {
        packCollectionRecords(collection).forEach(function (record) {
          batch.push(record);
          tokenRecords.push(record);
        });
      });
      const vars = await figma.variables.getLocalVariablesAsync();
      for (let vi = 0; vi < vars.length; vi++) {
        packVariableRecords(vars[vi]).forEach(function (record) {
          batch.push(record);
          tokenRecords.push(record);
        });
        if (batch.length >= PACK_BATCH_SIZE) {
          await packPostBatch(state, batch);
          batch = [];
        }
      }
      // Prime the cached baseline from the records we already enumerated.
      packTokenBaseline = packTokenBaselineFromRecords(tokenRecords);
    }
    const styleGetters = [
      ['PAINT', 'getLocalPaintStylesAsync'], ['TEXT', 'getLocalTextStylesAsync'],
      ['EFFECT', 'getLocalEffectStylesAsync'], ['GRID', 'getLocalGridStylesAsync']
    ];
    for (let si = 0; si < styleGetters.length; si++) {
      const pair = styleGetters[si];
      if (typeof figma[pair[1]] !== 'function') continue;
      const styles = await figma[pair[1]]();
      styles.forEach(function (style) {
        packStyleRecords(style, pair[0]).forEach(function (record) { batch.push(record); });
      });
      if (batch.length >= PACK_BATCH_SIZE) { await packPostBatch(state, batch); batch = []; }
    }
    await packPostBatch(state, batch);
    figma.ui.postMessage({ type: 'PACK_DONE', pages: state.pageCount, nodes: state.nodeCount });
  } catch (error) {
    if (!state.cancelled) packSendError(error);
  } finally {
    figma.skipInvisibleInstanceChildren = oldSkipInvisibleChildren;
    activeExport = null;
    packEndSuppression();
  }
}

/* ------------------------------------------------------------------ *
 * Change collection
 *
 * Layers ride `documentchange`, styles ride `stylechange`. Variables
 * have no event, so they are diffed against a cached signature baseline
 * (primed once, re-cached after each write run).
 * ------------------------------------------------------------------ */

function packBeginSuppression() { packSuppressChanges++; }

function packEndSuppression() { if (packSuppressChanges > 0) packSuppressChanges--; }

function packBindChangeListeners() {
  if (packListenersBound) return;
  packListenersBound = true;
  if (typeof figma.on !== 'function') return;
  try { figma.on('documentchange', packOnDocumentChange); } catch (error) { /* unsupported */ }
  try { figma.on('stylechange', packOnStyleChange); } catch (error) { /* unsupported */ }
}

function packStartChangeCollection() {
  packBindChangeListeners();
  packChangeCollector = {
    createdIds: [], createdSet: new Set(),
    updatedIds: [], updatedSet: new Set(), updatedProps: {},
    deletedIds: [], deletedSet: new Set(),
    styleCreated: [], styleCreatedSet: new Set(),
    styleUpdated: [], styleUpdatedSet: new Set(),
    styleDeleted: [], styleDeletedSet: new Set()
  };
}

function packStopChangeCollection() {
  const collected = packChangeCollector;
  packChangeCollector = null;
  return collected;
}

function packOnDocumentChange(event) {
  if (packSuppressChanges > 0 || !packChangeCollector) return;
  const changes = (event && event.documentChanges) || [];
  for (let i = 0; i < changes.length; i++) {
    const change = changes[i];
    if (!change || !change.id) continue;
    if (change.type === 'CREATE') {
      if (!packChangeCollector.createdSet.has(change.id)) {
        packChangeCollector.createdSet.add(change.id);
        packChangeCollector.createdIds.push(change.id);
      }
    } else if (change.type === 'DELETE') {
      if (!packChangeCollector.deletedSet.has(change.id)) {
        packChangeCollector.deletedSet.add(change.id);
        packChangeCollector.deletedIds.push(change.id);
      }
    } else if (change.type === 'PROPERTY_CHANGE') {
      if (packChangeCollector.deletedSet.has(change.id)) continue;
      if (!packChangeCollector.updatedSet.has(change.id)) {
        packChangeCollector.updatedSet.add(change.id);
        packChangeCollector.updatedIds.push(change.id);
      }
      const state = packChangeCollector.updatedProps[change.id] ||
        { props: {}, whole: false };
      const properties = change.properties;
      if (!properties || !properties.length) {
        // No property list: we cannot map fields, so send the whole row.
        state.whole = true;
      } else {
        properties.forEach(function (property) { state.props[property] = true; });
      }
      packChangeCollector.updatedProps[change.id] = state;
    }
  }
}

function packStyleEventRecord(change) {
  const style = change && change.style;
  if (!style) return null;
  const records = packStyleRecords(style, packStyleType(style));
  return records.length ? records[0] : null;
}

function packOnStyleChange(event) {
  if (packSuppressChanges > 0 || !packChangeCollector) return;
  const changes = (event && event.styleChanges) || [];
  for (let i = 0; i < changes.length; i++) {
    const change = changes[i];
    if (!change || !change.id) continue;
    if (change.type === 'STYLE_DELETE') {
      if (!packChangeCollector.styleDeletedSet.has(change.id)) {
        packChangeCollector.styleDeletedSet.add(change.id);
        packChangeCollector.styleDeleted.push({ kind: 'style', figma_id: change.id });
      }
    } else if (change.type === 'STYLE_CREATE') {
      const record = packStyleEventRecord(change);
      if (record && !packChangeCollector.styleCreatedSet.has(change.id)) {
        packChangeCollector.styleCreatedSet.add(change.id);
        packChangeCollector.styleCreated.push(record);
      }
    } else if (change.type === 'STYLE_PROPERTY_CHANGE') {
      const record = packStyleEventRecord(change);
      if (record && !packChangeCollector.styleUpdatedSet.has(change.id)) {
        packChangeCollector.styleUpdatedSet.add(change.id);
        const set = {};
        Object.keys(record.data).forEach(function (field) {
          if (field !== 'figma_id') set[field] = record.data[field];
        });
        packChangeCollector.styleUpdated.push({ kind: 'style', key: { figma_id: change.id }, set: set });
      }
    }
  }
}

/* ---- token baseline / diff (variables, modes, collections, values) ---- */

async function packTokenSnapshot() {
  const records = [];
  if (figma.variables) {
    const collections = await figma.variables.getLocalVariableCollectionsAsync();
    for (let i = 0; i < collections.length; i++) {
      const collectionRecords = packCollectionRecords(collections[i]);
      for (let r = 0; r < collectionRecords.length; r++) records.push(collectionRecords[r]);
    }
    const variables = await figma.variables.getLocalVariablesAsync();
    for (let i = 0; i < variables.length; i++) {
      const variableRecords = packVariableRecords(variables[i]);
      for (let r = 0; r < variableRecords.length; r++) records.push(variableRecords[r]);
    }
  }
  return records;
}

function packTokenSignature(kind, data) {
  if (kind === 'collection' || kind === 'variable') return kind + ':' + data.figma_id;
  if (kind === 'mode') return 'mode:' + data.collection_id + '/' + data.mode_id;
  if (kind === 'value') return 'value:' + data.variable_id + '/' + data.mode_id;
  return kind + ':' + JSON.stringify(data);
}

function packTokenKey(kind, data) {
  if (kind === 'collection' || kind === 'variable') return { figma_id: data.figma_id };
  if (kind === 'mode') return { collection_id: data.collection_id, mode_id: data.mode_id };
  if (kind === 'value') return { variable_id: data.variable_id, mode_id: data.mode_id };
  return { figma_id: data.figma_id };
}

function packTokenDelete(kind, data) {
  if (kind === 'mode' || kind === 'value') return { kind: kind, key: packTokenKey(kind, data) };
  return { kind: kind, figma_id: data.figma_id };
}

function packTokenBaselineFromRecords(records) {
  const baseline = {};
  for (let i = 0; i < records.length; i++) {
    baseline[packTokenSignature(records[i].kind, records[i].data)] =
      { kind: records[i].kind, data: records[i].data };
  }
  return baseline;
}

async function packPrimeTokenBaseline() {
  const records = await packTokenSnapshot();
  packTokenBaseline = packTokenBaselineFromRecords(records);
  return packTokenBaseline;
}

function packDiffTokenRecords(before, afterRecords) {
  const created = [];
  const updated = [];
  const deleted = [];
  const seen = {};
  for (let i = 0; i < afterRecords.length; i++) {
    const record = afterRecords[i];
    const signature = packTokenSignature(record.kind, record.data);
    seen[signature] = true;
    const old = before[signature];
    if (!old) { created.push({ kind: record.kind, data: record.data }); continue; }
    const set = {};
    let changed = false;
    Object.keys(record.data).forEach(function (field) {
      if (JSON.stringify(old.data[field]) !== JSON.stringify(record.data[field])) {
        set[field] = record.data[field];
        changed = true;
      }
    });
    if (changed) {
      updated.push({ kind: record.kind, key: packTokenKey(record.kind, record.data), set: set });
    }
  }
  Object.keys(before).forEach(function (signature) {
    if (!seen[signature]) deleted.push(packTokenDelete(before[signature].kind, before[signature].data));
  });
  return { created: created, updated: updated, deleted: deleted };
}

/* ---- node lookups and property mapping ---- */

async function packResolveNode(id) {
  if (typeof figma.getNodeByIdAsync === 'function') {
    try { return await figma.getNodeByIdAsync(id); } catch (error) { return null; }
  }
  if (typeof figma.getNodeById === 'function') {
    try { return figma.getNodeById(id); } catch (error) { return null; }
  }
  return null;
}

function packNodePage(node) {
  let current = node;
  let guard = 0;
  while (current && current.type !== 'PAGE' && guard < 1000) { current = current.parent; guard++; }
  return current && current.type === 'PAGE' ? current : null;
}

function packNodePlacement(node) {
  const parent = node.parent || null;
  let position = 0;
  if (parent && parent.children) {
    const index = parent.children.indexOf(node);
    if (index !== -1) position = index;
  }
  let depth = 0;
  let current = parent;
  let guard = 0;
  while (current && current.type !== 'PAGE' && guard < 1000) { depth++; current = current.parent; guard++; }
  return { parent_id: parent ? parent.id : null, position: position, depth: depth };
}

const PACK_SCALAR_PROPERTY_FIELDS = {
  name: 'name', visible: 'visible', x: 'x', y: 'y', width: 'width', height: 'height',
  characters: 'text'
};

const PACK_STRUCTURE_PROPERTIES = {
  parent: true, position: true, index: true, reparent: true, reorder: true, move: true
};

const PACK_RICH_PROPERTY_SET = (function () {
  const set = {};
  PACK_RICH_FIELDS.forEach(function (field) { set[field] = true; });
  set.boundVariables = true;
  set.reactions = true;
  return set;
})();

const PACK_BINDING_PROPERTIES = { boundVariables: true, fills: true, strokes: true, effects: true, layoutGrids: true };
const PACK_LINK_PROPERTIES = { reactions: true };

async function packNodeUpdateEntry(node, state) {
  const placement = packNodePlacement(node);
  const page = packNodePage(node);
  const full = packNode(node, placement.parent_id, page ? page.id : placement.parent_id,
    placement.position, placement.depth);
  const set = {};
  let whole = state.whole === true;
  const props = state.props || {};
  const propNames = Object.keys(props);
  if (!whole) {
    for (let i = 0; i < propNames.length; i++) {
      const prop = propNames[i];
      if (!PACK_SCALAR_PROPERTY_FIELDS[prop] && !PACK_STRUCTURE_PROPERTIES[prop] &&
        !PACK_RICH_PROPERTY_SET[prop]) { whole = true; break; }
    }
  }
  let needProperties = false;
  let needBindings = false;
  let needLinks = false;
  let needStructure = false;
  if (whole) {
    Object.keys(full.node).forEach(function (field) {
      if (field !== 'figma_id') set[field] = full.node[field];
    });
    needProperties = true;
    needBindings = true;
    needLinks = true;
  } else {
    propNames.forEach(function (prop) {
      if (PACK_SCALAR_PROPERTY_FIELDS[prop]) {
        set[PACK_SCALAR_PROPERTY_FIELDS[prop]] = full.node[PACK_SCALAR_PROPERTY_FIELDS[prop]];
      } else if (PACK_STRUCTURE_PROPERTIES[prop]) {
        needStructure = true;
      } else if (PACK_RICH_PROPERTY_SET[prop]) {
        needProperties = true;
        if (PACK_BINDING_PROPERTIES[prop]) needBindings = true;
        if (PACK_LINK_PROPERTIES[prop]) needLinks = true;
      }
    });
    if (needProperties) set.properties_json = full.node.properties_json;
    if (needStructure) {
      set.parent_id = full.node.parent_id;
      set.position = full.node.position;
      set.depth = full.node.depth;
    }
  }
  const entry = { figma_id: node.id, set: set };
  if (needBindings) entry.bindings = full.bindings;
  if (needLinks) entry.links = full.links;
  return entry;
}

async function packBuildCreatedRecords(collected) {
  const emitted = {};
  const created = [];
  for (let i = 0; i < collected.createdIds.length; i++) {
    const id = collected.createdIds[i];
    if (emitted[id]) continue;
    const node = await packResolveNode(id);
    if (!node) { emitted[id] = true; continue; }
    const page = packNodePage(node);
    const placement = packNodePlacement(node);
    const records = await packNodeRecords(node, page ? page.id : placement.parent_id,
      placement.parent_id, placement.position, placement.depth);
    for (let r = 0; r < records.length; r++) {
      const recordId = records[r].node.figma_id;
      if (emitted[recordId]) continue;
      emitted[recordId] = true;
      created.push(records[r]);
    }
  }
  return created;
}

async function packBuildUpdatedRecords(collected) {
  const updated = [];
  for (let i = 0; i < collected.updatedIds.length; i++) {
    const id = collected.updatedIds[i];
    if (collected.deletedSet.has(id) || collected.createdSet.has(id)) continue;
    const node = await packResolveNode(id);
    if (!node) continue;
    const state = collected.updatedProps[id] || { props: {}, whole: true };
    updated.push(await packNodeUpdateEntry(node, state));
  }
  return updated;
}

function packBuildDeletedIds(collected) {
  const deleted = [];
  for (let i = 0; i < collected.deletedIds.length; i++) {
    const id = collected.deletedIds[i];
    if (collected.createdSet.has(id)) continue;
    deleted.push(id);
  }
  return deleted;
}

async function packBuildChangeReport(collected, options) {
  options = options || {};
  const created = await packBuildCreatedRecords(collected);
  const updated = await packBuildUpdatedRecords(collected);
  const deleted = packBuildDeletedIds(collected);
  let tokenCreated = collected.styleCreated.slice();
  let tokenUpdated = collected.styleUpdated.slice();
  let tokenDeleted = collected.styleDeleted.slice();
  if (options.tokens) {
    const afterRecords = await packTokenSnapshot();
    if (packTokenBaseline) {
      const diff = packDiffTokenRecords(packTokenBaseline, afterRecords);
      tokenCreated = tokenCreated.concat(diff.created);
      tokenUpdated = tokenUpdated.concat(diff.updated);
      tokenDeleted = tokenDeleted.concat(diff.deleted);
    }
    packTokenBaseline = packTokenBaselineFromRecords(afterRecords);
  }
  const allTokens = tokenCreated.concat(tokenUpdated).concat(tokenDeleted);
  const geometryStale = allTokens.some(function (entry) {
    return entry.kind === 'value' || entry.kind === 'style';
  });

  const counts = {
    created: created.length,
    updated: updated.length,
    deleted: deleted.length,
    tokens: allTokens.length
  };
  let truncated = false;
  if (counts.created + counts.updated + counts.deleted + counts.tokens > PACK_REPORT_LIMIT) {
    truncated = true;
    let remaining = PACK_REPORT_LIMIT;
    created.length = Math.min(created.length, remaining); remaining -= created.length;
    updated.length = Math.min(updated.length, remaining); remaining -= updated.length;
    deleted.length = Math.min(deleted.length, remaining); remaining -= deleted.length;
    tokenCreated.length = Math.min(tokenCreated.length, Math.max(remaining, 0)); remaining -= tokenCreated.length;
    tokenUpdated.length = Math.min(tokenUpdated.length, Math.max(remaining, 0)); remaining -= tokenUpdated.length;
    tokenDeleted.length = Math.min(tokenDeleted.length, Math.max(remaining, 0));
    counts.created = created.length;
    counts.updated = updated.length;
    counts.deleted = deleted.length;
    counts.tokens = tokenCreated.length + tokenUpdated.length + tokenDeleted.length;
  }
  const script = 'created ' + counts.created + ' nodes, changed ' + counts.updated +
    ', deleted ' + counts.deleted + ', updated ' + counts.tokens + ' tokens' +
    (truncated ? ' (truncated)' : '');
  return {
    kind: 'CHANGE_REPORT',
    script: script,
    counts: counts,
    created: created,
    updated: updated,
    deleted: deleted,
    tokens: { created: tokenCreated, updated: tokenUpdated, deleted: tokenDeleted },
    geometry_stale: geometryStale,
    truncated: truncated
  };
}

/* ---- node snapshots (user-initiated, whole rows) ---- */

async function packBuildSnapshot() {
  const page = figma.currentPage;
  const selection = (page && page.selection) || [];
  const nodes = [];
  for (let i = 0; i < selection.length; i++) {
    const root = selection[i];
    const placement = packNodePlacement(root);
    const records = await packNodeRecords(root, page.id, placement.parent_id,
      placement.position, placement.depth);
    for (let r = 0; r < records.length; r++) nodes.push(records[r]);
  }
  return { kind: 'NODE_SNAPSHOT', page_id: page ? page.id : null,
    node_count: nodes.length, nodes: nodes };
}

async function packSendSnapshot() {
  try {
    const snapshot = await packBuildSnapshot();
    figma.ui.postMessage({ type: 'PACK_SNAPSHOT', snapshot: snapshot });
  } catch (error) {
    figma.ui.postMessage({ type: 'PACK_SNAPSHOT', error: error.message || String(error) });
  }
}

function packHandleMessage(message) {
  if (message.type === 'PACK_BEGIN') {
    packExport();
    return true;
  }
  if (message.type === 'PACK_SNAPSHOT_REQUEST') {
    packSendSnapshot();
    return true;
  }
  if (message.type === 'PACK_ACK') {
    const state = activeExport;
    if (state && state.pending && state.pending.sequence === message.sequence) {
      state.pending.resolve();
      state.pending = null;
    }
    return true;
  }
  if (message.type === 'PACK_CANCEL') {
    const state = activeExport;
    if (state) {
      state.cancelled = true;
      if (state.pending) { state.pending.resolve(); state.pending = null; }
    }
    return true;
  }
  return false;
}

/* Figma Superpowers: existing clipboard workflow and dynamic priming. */
figma.showUI(__html__, { width: 270, height: 450, title: 'Superpowers Hub' });

const SAFETY_LIMITS = { MAX_PAGES: 8, MAX_COMPONENTS: 150, MAX_VARIABLES: 300 };

function rgbToHex(r, g, b) {
  const toHex = function (v) { return Math.round(v * 255).toString(16).padStart(2, '0'); };
  return '#' + toHex(r) + toHex(g) + toHex(b).toUpperCase();
}

function serializeNodeMarkdown(node, depth) {
  if (!node) return '';
  depth = depth || 0;
  const indent = '  '.repeat(depth);
  let md = indent + '- **' + node.type + '**: "' + node.name + '" [' +
    Math.round(node.width) + 'x' + Math.round(node.height) + ']';

  if ('fills' in node && node.fills !== figma.mixed && Array.isArray(node.fills) && node.fills.length > 0) {
    const colors = node.fills.filter(function (f) { return f.visible !== false && f.color; })
      .map(function (f) { return rgbToHex(f.color.r, f.color.g, f.color.b); });
    if (colors.length > 0) md += ' | Fills: ' + colors.join(', ');
  }
  if (node.type === 'TEXT' && node.characters) {
    const snippet = node.characters.length > 30 ? node.characters.substring(0, 30) + '...' : node.characters;
    md += ' | Text: "' + snippet.replace(/\n/g, ' ') + '"';
  }
  if (node.variantProperties) md += ' | Props: ' + JSON.stringify(node.variantProperties);
  if ('layoutMode' in node && node.layoutMode !== 'NONE') {
    md += ' | AutoLayout: ' + node.layoutMode + ' (gap: ' + node.itemSpacing + 'px)';
  }
  md += '\n';
  if ('children' in node && node.children.length > 0) {
    for (let i = 0; i < node.children.length; i++) {
      md += serializeNodeMarkdown(node.children[i], depth + 1);
    }
  }
  return md;
}

function pushCurrentSelection() {
  const selection = figma.currentPage.selection;
  if (selection.length > 0) {
    let mdContext = '';
    for (let i = 0; i < selection.length; i++) mdContext += serializeNodeMarkdown(selection[i], 0);
    figma.ui.postMessage({ type: 'SELECTION_UPDATED', nodeMarkdown: mdContext, hasSelection: true });
  } else {
    figma.ui.postMessage({ type: 'SELECTION_UPDATED', nodeMarkdown: null,
      hasSelection: false, pageName: figma.currentPage.name });
  }
}
figma.on('selectionchange', pushCurrentSelection);
pushCurrentSelection();

figma.ui.onmessage = async function (msg) {
  if (packHandleMessage(msg)) return;
  if (msg.type === 'GENERATE_DYNAMIC_PRIMING_PROMPT') {
    packBeginSuppression();
    try {
      const pageCount = figma.root.children.length;
      let isHugeFile = pageCount > SAFETY_LIMITS.MAX_PAGES;
      let localVariables = [];
      if (!isHugeFile && figma.variables) {
        localVariables = await figma.variables.getLocalVariablesAsync();
        if (localVariables.length > SAFETY_LIMITS.MAX_VARIABLES) isHugeFile = true;
      }
      if (isHugeFile) {
        const pageNames = figma.root.children.map(function (p) { return p.name; });
        let collectionsSummary = [];
        if (figma.variables) {
          const collections = await figma.variables.getLocalVariableCollectionsAsync();
          collectionsSummary = collections.map(function (c) { return c.name + ' (' + c.modes.length + ' modes)'; });
        }
        figma.ui.postMessage({ type: 'PRIMING_DATA_READY', mode: 'EXPLORATIVE',
          pageNames: pageNames, collectionsSummary: collectionsSummary });
        return;
      }
      await figma.currentPage.loadAsync();
      const pageNodes = figma.currentPage.findAllWithCriteria({ types: ['COMPONENT', 'COMPONENT_SET'] });
      const rootNodes = pageNodes.filter(function (node) { return node.parent.type !== 'COMPONENT_SET'; });
      let manifestMd = '';
      for (let i = 0; i < rootNodes.length; i++) {
        const node = rootNodes[i];
        const props = node.type === 'COMPONENT_SET'
          ? Object.keys(node.componentPropertyDefinitions).join(', ') : 'None';
        manifestMd += '- **' + node.name + '** (' + node.type + ') | Key: `' +
          node.key + '` | Props: [' + props + ']\n';
      }
      let variablesMd = '';
      if (figma.variables) {
        const collections = await figma.variables.getLocalVariableCollectionsAsync();
        for (let i = 0; i < collections.length; i++) {
          variablesMd += '- Collection: **' + collections[i].name + '** (' +
            collections[i].modes.length + ' modes)\n';
        }
      }
      figma.ui.postMessage({ type: 'PRIMING_DATA_READY', mode: 'STANDARD',
        manifestMd: manifestMd, variablesMd: variablesMd });
      // Prime the token baseline so the first write run can diff against it.
      try { await packPrimeTokenBaseline(); } catch (error) { /* baseline is optional */ }
    } finally {
      packEndSuppression();
    }
  }
  if (msg.type === 'RUNUserCode') {
    packStartChangeCollection();
    let result;
    let failure = null;
    try {
      const asyncExecutor = new Function('return (async () => { ' + msg.code + ' })()');
      result = await asyncExecutor();
    } catch (error) {
      failure = error;
    }
    const collected = packStopChangeCollection();
    const isWrite = failure !== null || result === undefined;
    const hasNodeChanges = !!(collected && (collected.createdIds.length ||
      collected.updatedIds.length || collected.deletedIds.length ||
      collected.styleCreated.length || collected.styleUpdated.length ||
      collected.styleDeleted.length));
    if (collected && (isWrite || hasNodeChanges)) {
      try {
        const report = await packBuildChangeReport(collected, { tokens: isWrite });
        figma.ui.postMessage({ type: 'EXECUTION_RESULT', kind: 'CHANGE_REPORT',
          data: JSON.stringify(report, null, 2) });
      } catch (reportError) {
        // A report failure must never mask the script's own result or error.
      }
    }
    if (failure) {
      figma.notify('❌ Script Execution Error: ' + failure.message, { timeout: 6000 });
    } else if (result !== undefined) {
      figma.ui.postMessage({ type: 'EXECUTION_RESULT',
        data: typeof result === 'object' ? JSON.stringify(result, null, 2) : String(result) });
      figma.notify('📋 [READ-ONLY] Output copied to clipboard.');
    } else {
      figma.notify('📋 Change report copied — paste it back so the snapshot stays current.');
    }
  }
};
