const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

function node(id, type, name, children = []) {
  return { id, type, name, width: 300, height: 200, x: 4, y: 8,
    visible: true, fills: [], children };
}

const tree = node('10:1', 'FRAME', 'Checkout', [
  { id: '10:2', type: 'TEXT', name: 'Heading', characters: 'Pay securely',
    x: 0, y: 0, width: 110, height: 20, visible: true,
    boundVariables: { fontSize: { type: 'VARIABLE_ALIAS', id: 'VariableID:1' } } },
  { id: '10:3', type: 'INSTANCE', name: 'Primary button', width: 140, height: 40,
    x: 20, y: 40, visible: true, componentProperties: { State: { value: 'Normal' } },
    getMainComponentAsync: async () => ({ id: '20:1', name: 'Button' }) }
]);
const pages = [
  { id: '0:1', name: 'Screens', children: [tree], async loadAsync() {} },
  { id: '0:2', name: 'Components', children: [node('20:1', 'COMPONENT', 'Button')],
    async loadAsync() {} }
];
const captured = [];
let messageHandler = null;
const figma = {
  mixed: Symbol('mixed'),
  root: { name: 'Demo', children: pages },
  ui: { postMessage(msg) {
    captured.push(msg);
    if (msg.type === 'PACK_BATCH') {
      queueMicrotask(() => messageHandler({ type: 'PACK_ACK', sequence: msg.sequence }));
    }
  } },
  variables: {
    async getLocalVariableCollectionsAsync() { return [{ id: 'Collection:1', name: 'Theme',
      key: 'c1', modes: [{ modeId: 'Mode:Light', name: 'Light' },
        { modeId: 'Mode:Dark', name: 'Dark' }], defaultModeId: 'Mode:Light' }]; },
    async getLocalVariablesAsync() { return [{ id: 'VariableID:1', name: 'size/title',
      variableCollectionId: 'Collection:1', resolvedType: 'FLOAT',
      valuesByMode: { 'Mode:Light': 18, 'Mode:Dark': 20 } }]; }
  },
  async getLocalPaintStylesAsync() { return [{ id: 'Style:1', name: 'Primary', paints: [] }]; },
  async getLocalTextStylesAsync() { return []; },
  async getLocalEffectStylesAsync() { return []; },
  async getLocalGridStylesAsync() { return []; }
};
const context = vm.createContext({ figma, console, Promise, Symbol, queueMicrotask });
vm.runInContext(fs.readFileSync(path.join(__dirname, '../src/exporter.js'), 'utf8'), context);
messageHandler = vm.runInContext('packHandleMessage', context);

(async () => {
  messageHandler({ type: 'PACK_BEGIN' });
  for (let i = 0; i < 100; i++) {
    if (captured.some(m => m.type === 'PACK_DONE' || m.type === 'PACK_ERROR')) break;
    await new Promise(resolve => setTimeout(resolve, 1));
  }
  const error = captured.find(m => m.type === 'PACK_ERROR');
  assert.equal(error, undefined, error && error.message);
  const done = captured.find(m => m.type === 'PACK_DONE');
  assert.ok(done, 'export completed');
  assert.equal(done.pages, 2);
  assert.equal(done.nodes, 4);
  const data = captured.filter(m => m.type === 'PACK_BATCH').flatMap(m => m.records);
  assert.equal(data.filter(r => r.kind === 'node').length, 4);
  assert.equal(data.filter(r => r.kind === 'value').length, 2);
  assert.equal(data.filter(r => r.kind === 'mode').length, 2);
  assert.equal(data.filter(r => r.kind === 'page').length, 2);
  assert.ok(data.some(r => r.kind === 'binding' && r.data.variable_id === 'VariableID:1'));
  assert.ok(data.some(r => r.kind === 'link' && r.data.target_id === '20:1'));
  assert.ok(data.some(r => r.kind === 'style'));
  const text = data.find(r => r.kind === 'node' && r.data.figma_id === '10:2');
  assert.equal(text.data.text, 'Pay securely');
  assert.ok(!text.data.properties_json.includes('boundVariables'),
    'aliases are not duplicated into properties_json (they live in node_variable_bindings)');
  assert.equal(text.data.properties_json, '{}',
    'empty containers and empty strings are pruned from properties_json');
  const frame = data.find(r => r.kind === 'node' && r.data.figma_id === '10:1');
  assert.equal(frame.data.properties_json, '{}', 'empty fills array is pruned');
  assert.ok(data.some(r => r.kind === 'binding' && r.data.field === 'fontSize'),
    'top-level alias still reaches node_variable_bindings');
  console.log('PASS exporter: all pages, nodes, variables, bindings, instance links and styles');
})().catch(error => { console.error(error); process.exitCode = 1; });
