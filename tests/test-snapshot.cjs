const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

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

const page = makeNode('0:1', 'PAGE', 'Screens');
const frame = attach(page, makeNode('12:1', 'FRAME', 'Card', { width: 320, height: 200 }));
attach(frame, makeNode('12:2', 'TEXT', 'Title', { characters: 'Hello', width: 80, height: 18 }));
attach(frame, makeNode('12:3', 'INSTANCE', 'Ghost button', { width: 120, height: 40,
  getMainComponentAsync: async () => ({ id: '20:1', name: 'Button' }) }));
page.selection = [frame];

const figma = {
  mixed: Symbol('mixed'),
  root: { name: 'Demo', children: [page] },
  currentPage: page,
  on() {},
  async getNodeByIdAsync(id) { return id === '12:1' ? frame : null; },
  ui: { postMessage() {} },
  variables: {
    async getLocalVariableCollectionsAsync() { return []; },
    async getLocalVariablesAsync() { return []; }
  }
};

const exporterContext = vm.createContext({ figma, console, Promise, Symbol, queueMicrotask });
vm.runInContext(fs.readFileSync(path.join(__dirname, '../src/exporter.js'), 'utf8'), exporterContext);
const packBuildSnapshot = vm.runInContext('packBuildSnapshot', exporterContext);

const dbContext = vm.createContext({ console });
vm.runInContext(fs.readFileSync(path.join(__dirname, '../src/database.js'), 'utf8'), dbContext);
const NODE_SNAPSHOT_HEADER = vm.runInContext('NODE_SNAPSHOT_HEADER', dbContext);
const NODE_SNAPSHOT_FOOTER = vm.runInContext('NODE_SNAPSHOT_FOOTER', dbContext);
const packWrapEnvelope = vm.runInContext('packWrapEnvelope', dbContext);

(async function () {
  const snapshot = await packBuildSnapshot();
  assert.equal(snapshot.kind, 'NODE_SNAPSHOT');
  assert.equal(snapshot.page_id, '0:1');
  assert.equal(snapshot.node_count, 3, 'frame plus both descendants');
  assert.equal(snapshot.nodes.length, 3, 'declared count matches the array');

  const frameRow = snapshot.nodes.find(r => r.node.figma_id === '12:1');
  assert.equal(frameRow.node.parent_id, '0:1');
  assert.equal(frameRow.node.depth, 0);
  assert.equal(frameRow.node.name, 'Card');

  const titleRow = snapshot.nodes.find(r => r.node.figma_id === '12:2');
  assert.equal(titleRow.node.parent_id, '12:1');
  assert.equal(titleRow.node.depth, 1);
  assert.equal(titleRow.node.text, 'Hello');

  const instanceRow = snapshot.nodes.find(r => r.node.figma_id === '12:3');
  assert.ok(instanceRow.links.some(l => l.kind === 'instance' && l.target_id === '20:1'),
    'instance main component link resolved on demand');

  const block = packWrapEnvelope(NODE_SNAPSHOT_HEADER, NODE_SNAPSHOT_FOOTER,
    JSON.stringify(snapshot));
  assert.ok(block.startsWith(NODE_SNAPSHOT_HEADER));
  assert.ok(block.endsWith(NODE_SNAPSHOT_FOOTER));

  console.log('PASS snapshot: whole rows via packNodeRecords, wrapped in its envelope');
})().catch(function (error) { console.error(error); process.exitCode = 1; });
