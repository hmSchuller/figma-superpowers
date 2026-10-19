const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
const source = fs.readFileSync(path.join(root, 'src', 'database.js'), 'utf8');
const context = vm.createContext({ console });
vm.runInContext(source, context, { filename: 'database.js' });
const packAgentPrompt = vm.runInContext('packAgentPrompt', context);

// Minimal stand-in for the sql.js handle: packScalar only needs exec(sql).
const answers = [
  ["key='file_name'", 'Demo File'],
  ['FROM pages', 3],
  ['FROM nodes', 42],
  ['FROM variable_modes', 2],
  ['FROM variables', 7],
  ['FROM styles', 5]
];
const fakeDb = {
  exec: function (sql) {
    for (let i = 0; i < answers.length; i++) {
      if (sql.indexOf(answers[i][0]) !== -1) return [{ values: [[answers[i][1]]] }];
    }
    return [];
  }
};

const RULES = '<<SYSTEM_RULES_MARKER>>';
const prompt = packAgentPrompt(fakeDb, 'fts5', RULES);

assert.match(prompt, /# FIGMAPACK AGENT CONTEXT/, 'missing header');
assert.match(prompt, /interactive Design System Consultant and Plugin API Execution Engine/,
  'missing consultant role line');
assert.match(prompt, /"Demo File" with 3 pages, 42 design nodes,\s+7 local variables, 2 variable modes and 5 local styles/,
  'missing database statistics');
assert.match(prompt, /## Discovery queries/, 'missing discovery queries');
assert.ok(prompt.indexOf(RULES) !== -1, 'execution rules header not embedded');
assert.ok(prompt.indexOf(RULES) > prompt.indexOf('## Workflow with the live plugin'),
  'execution rules header must close the prompt, like the init prompt');
assert.match(prompt, /FTS5/, 'missing search engine note');
assert.ok(prompt.indexOf('undefined') === -1, 'rules header fallback leaked "undefined"');

const bare = packAgentPrompt(fakeDb, 'fts4');
assert.ok(bare.indexOf(RULES) === -1, 'rules header should be optional');
assert.ok(bare.indexOf('undefined') === -1, 'optional rules header must not inject "undefined"');

console.log('PASS prompt: agent prompt carries DB context, consultant role and execution rules');
