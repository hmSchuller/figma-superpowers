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

const page = makeNode('0:1', 'PAGE', 'Screens');
const handlers = {};
const registry = new Map();
const figma = {
  mixed: Symbol('mixed'),
  root: { name: 'Demo', children: [page] },
  currentPage: page,
  on(event, fn) { handlers[event] = fn; },
  async getNodeByIdAsync(id) { return registry.get(id) || null; },
  ui: { postMessage() {} },
  variables: {
    async getLocalVariableCollectionsAsync() { return []; },
    async getLocalVariablesAsync() { return []; }
  }
};
page.selection = [];

const exporterContext = vm.createContext({ figma, console, Promise, Symbol, queueMicrotask });
vm.runInContext(fs.readFileSync(path.join(__dirname, '../src/exporter.js'), 'utf8'), exporterContext);
const call = function (fn, ...args) { return vm.runInContext(fn, exporterContext)(...args); };

const dbContext = vm.createContext({ console });
vm.runInContext(fs.readFileSync(path.join(__dirname, '../src/database.js'), 'utf8'), dbContext);
const CHANGE_REPORT_HEADER = vm.runInContext('CHANGE_REPORT_HEADER', dbContext);
const CHANGE_REPORT_FOOTER = vm.runInContext('CHANGE_REPORT_FOOTER', dbContext);
const NODE_SNAPSHOT_HEADER = vm.runInContext('NODE_SNAPSHOT_HEADER', dbContext);
const NODE_SNAPSHOT_FOOTER = vm.runInContext('NODE_SNAPSHOT_FOOTER', dbContext);
const packWrapEnvelope = vm.runInContext('packWrapEnvelope', dbContext);
const packEnvelopeVerifies = vm.runInContext('packEnvelopeVerifies', dbContext);

const reportCheck = function (p) {
  const t = p.tokens || { created: [], updated: [], deleted: [] };
  return p.counts.created === p.created.length &&
    p.counts.updated === p.updated.length &&
    p.counts.deleted === p.deleted.length &&
    p.counts.tokens === (t.created.length + t.updated.length + t.deleted.length);
};
const snapshotCheck = function (p) { return p.node_count === p.nodes.length; };

(async function () {
  const created = attachPage();
  call('packStartChangeCollection');
  handlers.documentchange({ documentChanges: [{ type: 'CREATE', id: '12:7' }] });
  const report = await call('packBuildChangeReport', call('packStopChangeCollection'), { tokens: false });
  const reportPayload = packWrapEnvelope(CHANGE_REPORT_HEADER, CHANGE_REPORT_FOOTER,
    JSON.stringify(report, null, 2));

  assert.ok(reportPayload.indexOf(CHANGE_REPORT_HEADER) === 0, 'report opens with its header');
  assert.ok(reportPayload.trimEnd().endsWith(CHANGE_REPORT_FOOTER), 'report closes with its footer');
  assert.equal(packEnvelopeVerifies(reportPayload, CHANGE_REPORT_FOOTER, reportCheck), true,
    'whole report verifies');

  const cut = reportPayload.slice(0, reportPayload.length - CHANGE_REPORT_FOOTER.length - 1);
  assert.equal(packEnvelopeVerifies(cut, CHANGE_REPORT_FOOTER, reportCheck), false,
    'a report missing its footer fails the completeness check');

  const tampered = reportPayload.replace('"created": 1', '"created": 99');
  assert.equal(packEnvelopeVerifies(tampered, CHANGE_REPORT_FOOTER, reportCheck), false,
    'declared totals that disagree with the arrays fail the check');

  const snapshot = { kind: 'NODE_SNAPSHOT', page_id: '0:1', node_count: 1,
    nodes: [{ node: { figma_id: '12:7' } }] };
  const snapshotPayload = packWrapEnvelope(NODE_SNAPSHOT_HEADER, NODE_SNAPSHOT_FOOTER,
    JSON.stringify(snapshot));
  assert.equal(packEnvelopeVerifies(snapshotPayload, NODE_SNAPSHOT_FOOTER, snapshotCheck), true,
    'whole snapshot verifies');
  const broken = JSON.stringify(Object.assign({}, snapshot, { node_count: 4 }));
  const brokenPayload = packWrapEnvelope(NODE_SNAPSHOT_HEADER, NODE_SNAPSHOT_FOOTER, broken);
  assert.equal(packEnvelopeVerifies(brokenPayload, NODE_SNAPSHOT_FOOTER, snapshotCheck), false,
    'a snapshot whose declared count disagrees fails the check');
  assert.equal(packEnvelopeVerifies(snapshotPayload, NODE_SNAPSHOT_FOOTER + 'X', snapshotCheck), false,
    'a payload without its exact footer fails the check');

  assert.ok(created, 'created node is live');
  console.log('PASS envelope: both payloads self-verify by footer and declared totals');
})().catch(function (error) { console.error(error); process.exitCode = 1; });

function attachPage() {
  const node = makeNode('12:7', 'FRAME', 'Card');
  node.parent = page;
  page.children.push(node);
  registry.set('12:7', node);
  return node;
}
