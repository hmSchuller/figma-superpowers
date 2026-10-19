const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

/* ---- Figma sandbox mock ------------------------------------------------ */

function makeNode(id, type, name, extra) {
  const node = Object.assign({ id, type, name, visible: true, x: 0, y: 0, width: 100, height: 50 },
    extra || {});
  node.children = [];
  return node;
}

function attach(parent, child, index) {
  child.parent = parent;
  if (index === undefined) parent.children.push(child);
  else parent.children.splice(index, 0, child);
  return child;
}

const registry = new Map();
function register(node) {
  registry.set(node.id, node);
  (node.children || []).forEach(register);
  return node;
}

const page = makeNode('0:1', 'PAGE', 'Screens', { children: [] });
const frame = register(attach(page, makeNode('10:1', 'FRAME', 'Checkout',
  { width: 320, height: 200, fills: [{ type: 'SOLID', color: { r: 1, g: 1, b: 1 } }] })));
const heading = register(attach(frame, makeNode('10:2', 'TEXT', 'Heading',
  { characters: 'Pay securely', width: 110, height: 20 })));
register(page);

const handlers = {};
let collections = [{
  id: 'Collection:1', name: 'Theme', key: 'c1', defaultModeId: 'Mode:Light',
  modes: [{ modeId: 'Mode:Light', name: 'Light' }, { modeId: 'Mode:Dark', name: 'Dark' }]
}];
let variables = [{
  id: 'VariableID:1', name: 'color/primary', variableCollectionId: 'Collection:1',
  resolvedType: 'COLOR', description: '',
  valuesByMode: { 'Mode:Light': { type: 'SOLID', color: { r: 1, g: 0, b: 0 } } }
}];

const figma = {
  mixed: Symbol('mixed'),
  root: { name: 'Demo', children: [page] },
  currentPage: page,
  on(event, fn) { handlers[event] = fn; },
  async getNodeByIdAsync(id) { return registry.get(id) || null; },
  ui: { postMessage() {} },
  variables: {
    async getLocalVariableCollectionsAsync() { return collections; },
    async getLocalVariablesAsync() { return variables; }
  }
};
page.selection = [];

const context = vm.createContext({ figma, console, Promise, Symbol, queueMicrotask });
vm.runInContext(fs.readFileSync(path.join(__dirname, '../src/exporter.js'), 'utf8'), context);
const call = function (fn, ...args) { return vm.runInContext(fn, context)(...args); };

(async function () {
  /* ---- nodes: CREATE / PROPERTY_CHANGE / DELETE ------------------------ */

  // CREATE a subtree, reported as whole rows with no duplicates.
  const card = attach(page, makeNode('12:7', 'FRAME', 'Card', { width: 320, height: 200 }));
  const cardLabel = attach(card, makeNode('12:8', 'TEXT', 'Label', { characters: 'Hi' }));
  register(page);
  call('packStartChangeCollection');
  handlers.documentchange({ documentChanges: [
    { type: 'CREATE', id: '12:7' }, { type: 'CREATE', id: '12:8' }
  ] });
  let report = await call('packBuildChangeReport', call('packStopChangeCollection'), { tokens: false });
  assert.equal(report.counts.created, 2, 'created subtree rows');
  assert.equal(report.created.length, 2, 'created array length');
  const cardRow = report.created.find(r => r.node.figma_id === '12:7');
  assert.equal(cardRow.node.name, 'Card');
  assert.equal(cardRow.node.parent_id, '0:1');
  assert.equal(cardRow.node.depth, 0);
  assert.equal(cardRow.node.position, 1, 'position among page children');

  // PROPERTY_CHANGE -> minimal patch keyed by exporter field names.
  call('packStartChangeCollection');
  heading.name = 'Card 2';
  heading.width = 340;
  handlers.documentchange({ documentChanges: [
    { type: 'PROPERTY_CHANGE', id: '10:2', properties: ['name', 'width'] }
  ] });
  report = await call('packBuildChangeReport', call('packStopChangeCollection'), { tokens: false });
  assert.equal(report.counts.updated, 1);
  assert.deepEqual(Object.keys(report.updated[0].set).sort(), ['name', 'width']);
  assert.equal(report.updated[0].set.name, 'Card 2');
  assert.equal(report.updated[0].set.width, 340);

  // Reparenting adds parent_id / position / depth.
  const shelf = attach(page, makeNode('12:20', 'FRAME', 'Shelf'));
  register(page);
  attach(shelf, heading);
  call('packStartChangeCollection');
  handlers.documentchange({ documentChanges: [
    { type: 'PROPERTY_CHANGE', id: '10:2', properties: ['parent'] }
  ] });
  report = await call('packBuildChangeReport', call('packStopChangeCollection'), { tokens: false });
  assert.equal(report.updated[0].set.parent_id, '12:20');
  assert.equal(report.updated[0].set.depth, 1);
  assert.ok('position' in report.updated[0].set, 'reparent exposes position');

  // An unmapped property falls back to the whole row.
  call('packStartChangeCollection');
  handlers.documentchange({ documentChanges: [
    { type: 'PROPERTY_CHANGE', id: '10:2', properties: ['mysteryProp'] }
  ] });
  report = await call('packBuildChangeReport', call('packStopChangeCollection'), { tokens: false });
  assert.ok('name' in report.updated[0].set && 'width' in report.updated[0].set &&
    'properties_json' in report.updated[0].set, 'unmapped property sends the whole row');

  // A property change with no property list also sends the whole row.
  call('packStartChangeCollection');
  handlers.documentchange({ documentChanges: [{ type: 'PROPERTY_CHANGE', id: '10:2' }] });
  report = await call('packBuildChangeReport', call('packStopChangeCollection'), { tokens: false });
  assert.ok('name' in report.updated[0].set, 'missing property list sends the whole row');

  // DELETE reports the id; a created-then-deleted node is invisible.
  call('packStartChangeCollection');
  handlers.documentchange({ documentChanges: [{ type: 'DELETE', id: '12:20' }] });
  report = await call('packBuildChangeReport', call('packStopChangeCollection'), { tokens: false });
  assert.deepEqual(Array.from(report.deleted), ['12:20']);

  call('packStartChangeCollection');
  handlers.documentchange({ documentChanges: [{ type: 'CREATE', id: '12:30' }] });
  handlers.documentchange({ documentChanges: [{ type: 'DELETE', id: '12:30' }] });
  report = await call('packBuildChangeReport', call('packStopChangeCollection'), { tokens: false });
  assert.equal(report.counts.created, 0);
  assert.equal(report.counts.deleted, 0);

  // ---- styles ----------------------------------------------------------

  const style = { id: 'S:1', key: 'stylekey', name: 'Primary', styleType: 'PAINT',
    description: '', paints: [{ type: 'SOLID', color: { r: 0, g: 0, b: 1 } }] };
  call('packStartChangeCollection');
  handlers.stylechange({ styleChanges: [{ type: 'STYLE_CREATE', id: 'S:1', style: style }] });
  report = await call('packBuildChangeReport', call('packStopChangeCollection'), { tokens: false });
  const styleCreate = report.tokens.created.find(t => t.kind === 'style');
  assert.equal(styleCreate.data.figma_id, 'S:1');
  assert.equal(styleCreate.data.style_type, 'PAINT');
  assert.equal(report.geometry_stale, true, 'style change marks geometry stale');

  style.name = 'Primary 2';
  call('packStartChangeCollection');
  handlers.stylechange({ styleChanges: [{ type: 'STYLE_PROPERTY_CHANGE', id: 'S:1', style: style }] });
  report = await call('packBuildChangeReport', call('packStopChangeCollection'), { tokens: false });
  const stylePatch = report.tokens.updated.find(t => t.kind === 'style');
  assert.equal(stylePatch.key.figma_id, 'S:1');
  assert.equal(stylePatch.set.name, 'Primary 2');

  call('packStartChangeCollection');
  handlers.stylechange({ styleChanges: [{ type: 'STYLE_DELETE', id: 'S:2' }] });
  report = await call('packBuildChangeReport', call('packStopChangeCollection'), { tokens: false });
  assert.ok(report.tokens.deleted.some(t => t.kind === 'style' && t.figma_id === 'S:2'));

  // ---- variables: cached baseline diff ---------------------------------

  await call('packPrimeTokenBaseline');

  // A changed per-mode value becomes a patch and marks geometry stale.
  variables[0].valuesByMode['Mode:Light'] = { type: 'SOLID', color: { r: 0, g: 1, b: 0 } };
  call('packStartChangeCollection');
  report = await call('packBuildChangeReport', call('packStopChangeCollection'), { tokens: true });
  const valuePatch = report.tokens.updated.find(t => t.kind === 'value');
  assert.ok(valuePatch, 'changed value emitted');
  assert.equal(valuePatch.key.variable_id, 'VariableID:1');
  assert.equal(valuePatch.key.mode_id, 'Mode:Light');
  assert.ok(valuePatch.set.value_json.indexOf('"g":1') !== -1, 'patch carries the new value');
  assert.equal(report.geometry_stale, true, 'value change marks geometry stale');

  // A new variable is a full record; a removed one is a delete.
  variables = variables.concat([{
    id: 'VariableID:9', name: 'space/m', variableCollectionId: 'Collection:1',
    resolvedType: 'FLOAT', description: '', valuesByMode: { 'Mode:Light': 8 }
  }]);
  call('packStartChangeCollection');
  report = await call('packBuildChangeReport', call('packStopChangeCollection'), { tokens: true });
  const varCreate = report.tokens.created.find(t => t.kind === 'variable');
  assert.equal(varCreate.data.figma_id, 'VariableID:9');
  assert.ok(report.tokens.created.some(t => t.kind === 'value' && t.data.variable_id === 'VariableID:9'));

  variables = variables.filter(v => v.id !== 'VariableID:9');
  call('packStartChangeCollection');
  report = await call('packBuildChangeReport', call('packStopChangeCollection'), { tokens: true });
  assert.ok(report.tokens.deleted.some(t => t.kind === 'variable' && t.figma_id === 'VariableID:9'));
  assert.ok(report.tokens.deleted.some(t => t.kind === 'value' && t.key.variable_id === 'VariableID:9'));

  console.log('PASS changes: node creates/patches/deletes, style events and cached variable diffs');
})().catch(function (error) { console.error(error); process.exitCode = 1; });
