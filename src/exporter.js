/* FigmaPack: runs inside Figma's plugin sandbox, not Node.js. */
const PACK_BATCH_SIZE = 200;
let activeExport = null;

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

function packNode(node, parentId, pageId, order, depth) {
  const extra = {};
  const richFields = [
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
    'componentPropertyDefinitions', 'variantProperties', 'boundVariables',
    'explicitVariableModes', 'reactions', 'flowStartingPoints',
    'layoutGrids', 'gridRowCount', 'gridColumnCount', 'gridCell', 'exportSettings',
    'fillStyleId', 'strokeStyleId', 'effectStyleId', 'gridStyleId', 'textStyleId',
    'description', 'documentationLinks', 'isAsset', 'devStatus', 'locked',
    'relativeTransform', 'constraints', 'overflowDirection'
  ];
  richFields.forEach(function (field) {
    const value = packProperty(node, field);
    if (value !== undefined && value !== null) extra[field] = value;
  });
  const bindingRows = [];
  packBindingRows(extra.boundVariables, node.id, '', bindingRows);
  ['fills', 'strokes', 'effects', 'layoutGrids'].forEach(function (field) {
    if (!Array.isArray(extra[field])) return;
    extra[field].forEach(function (item, i) {
      packBindingRows(item && item.boundVariables, node.id, field + '[' + i + ']', bindingRows);
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
    properties_json: JSON.stringify(extra)
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
      const stack = [];
      for (let i = page.children.length - 1; i >= 0; i--) {
        stack.push({ node: page.children[i], parent: page.id, index: i, depth: 0 });
      }
      while (stack.length) {
        if (state.cancelled) throw new Error('Export cancelled');
        const entry = stack.pop();
        const record = packNode(entry.node, entry.parent, page.id, entry.index, entry.depth);
        batch.push({ kind: 'node', data: record.node });
        record.bindings.forEach(function (binding) { batch.push({ kind: 'binding', data: binding }); });
        record.links.forEach(function (link) { batch.push({ kind: 'link', data: link }); });
        if (entry.node.type === 'INSTANCE' && typeof entry.node.getMainComponentAsync === 'function') {
          const main = await entry.node.getMainComponentAsync();
          if (main) batch.push({ kind: 'link', data: { source_id: entry.node.id,
            target_id: main.id, kind: 'instance', label: main.name || '' } });
        }
        state.nodeCount++;
        if ('children' in entry.node) {
          const children = entry.node.children;
          for (let i = children.length - 1; i >= 0; i--) {
            stack.push({ node: children[i], parent: entry.node.id, index: i, depth: entry.depth + 1 });
          }
        }
        if (batch.length >= PACK_BATCH_SIZE) {
          await packPostBatch(state, batch);
          batch = [];
        }
      }
      state.pageCount++;
      figma.ui.postMessage({ type: 'PACK_PROGRESS', pages: state.pageCount,
        totalPages: pages.length, nodes: state.nodeCount });
    }
    if (figma.variables) {
      const collections = await figma.variables.getLocalVariableCollectionsAsync();
      collections.forEach(function (collection) {
        batch.push({ kind: 'collection', data: {
          figma_id: collection.id, name: collection.name, key: collection.key || null,
          default_mode_id: collection.defaultModeId || null,
          remote: collection.remote ? 1 : 0,
          properties_json: packJSON({ hiddenFromPublishing: collection.hiddenFromPublishing,
            variableIds: collection.variableIds })
        }});
        (collection.modes || []).forEach(function (mode, index) {
          batch.push({ kind: 'mode', data: { collection_id: collection.id, mode_id: mode.modeId,
            name: mode.name, position: index } });
        });
      });
      const vars = await figma.variables.getLocalVariablesAsync();
      for (let vi = 0; vi < vars.length; vi++) {
        const variable = vars[vi];
        batch.push({ kind: 'variable', data: {
          figma_id: variable.id, collection_id: variable.variableCollectionId,
          name: variable.name, key: variable.key || null,
          resolved_type: variable.resolvedType, description: variable.description || '',
          properties_json: packJSON({ scopes: variable.scopes,
            codeSyntax: variable.codeSyntax, hiddenFromPublishing: variable.hiddenFromPublishing,
            remote: variable.remote })
        }});
        Object.keys(variable.valuesByMode || {}).forEach(function (modeId) {
          const value = variable.valuesByMode[modeId];
          batch.push({ kind: 'value', data: {
            variable_id: variable.id, mode_id: modeId,
            value_json: packJSON(value),
            alias_variable_id: value && value.type === 'VARIABLE_ALIAS' ? value.id : null
          }});
        });
        if (batch.length >= PACK_BATCH_SIZE) {
          await packPostBatch(state, batch);
          batch = [];
        }
      }
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
        const properties = {};
        ['paints', 'fontName', 'fontSize', 'lineHeight', 'letterSpacing',
          'paragraphSpacing', 'textCase', 'textDecoration', 'effects', 'layoutGrids']
          .forEach(function (field) {
            const value = packProperty(style, field);
            if (value !== undefined) properties[field] = value;
          });
        batch.push({ kind: 'style', data: {
          figma_id: style.id, key: style.key || null, name: style.name,
          style_type: pair[0], description: style.description || '',
          properties_json: JSON.stringify(properties)
        }});
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
  }
}

function packHandleMessage(message) {
  if (message.type === 'PACK_BEGIN') {
    packExport();
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
