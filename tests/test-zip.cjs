const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
const source = fs.readFileSync(path.join(root, 'src', 'zip.js'), 'utf8');
const context = vm.createContext({
  TextEncoder, Blob, Response, CompressionStream, Uint8Array, Uint32Array, Date, Math, String, console
});
vm.runInContext(source, context, { filename: 'zip.js' });
const packExportArchive = vm.runInContext('packExportArchive', context);
const packExportFileName = vm.runInContext('packExportFileName', context);

const DB = Buffer.alloc(256 * 40);
for (let i = 0; i < DB.length; i++) DB[i] = i % 256;
const DATE = new Date(2026, 10, 13, 9, 5, 7);

assert.equal(packExportFileName('Design System / v2 (final)', DATE),
  'superpowers_export_Design_System_v2_final_20261113-090507.zip');
assert.equal(packExportFileName('Größen: Übersicht', DATE),
  'superpowers_export_Größen_Übersicht_20261113-090507.zip');
assert.equal(packExportFileName('', DATE), 'superpowers_export_Untitled_20261113-090507.zip');
assert.equal(packExportFileName('///', DATE), 'superpowers_export_Untitled_20261113-090507.zip');

const VERIFY = [
  'import io, sys, zipfile',
  'outer = zipfile.ZipFile(sys.argv[1])',
  'assert outer.testzip() is None, "outer CRC mismatch"',
  'assert sorted(outer.namelist()) == ["FIGMAPACK_AGENT_PROMPT.md", "figma_superpowers_db.zip"], outer.namelist()',
  'assert outer.read("FIGMAPACK_AGENT_PROMPT.md").decode() == "# FigmaPack\\n"',
  'inner = zipfile.ZipFile(io.BytesIO(outer.read("figma_superpowers_db.zip")))',
  'assert inner.testzip() is None, "inner CRC mismatch"',
  'assert inner.namelist() == ["figma_superpowers.db"], inner.namelist()',
  'assert inner.read("figma_superpowers.db") == bytes(i % 256 for i in range(256 * 40))',
  'print("PASS zip: export zip holds the zipped DB and the prompt, uniquely named")'
].join('\n');

(async function () {
  const bundle = await packExportArchive(
    { binary: new Uint8Array(DB), prompt: '# FigmaPack\n' }, 'Tokens', DATE);
  assert.equal(bundle.name, 'superpowers_export_Tokens_20261113-090507.zip');
  assert.ok(bundle.archive instanceof Uint8Array, 'archive must be a Uint8Array');
  assert.equal(bundle.archive[0], 0x50, 'missing PK local-header signature');
  assert.equal(bundle.archive[1], 0x4B);
  const file = path.join(os.tmpdir(), 'figmapack-zip-test-' + process.pid + '.zip');
  fs.writeFileSync(file, bundle.archive);
  try {
    execFileSync('python3', ['-c', VERIFY, file], { stdio: 'inherit' });
  } finally {
    fs.rmSync(file, { force: true });
  }
})().catch(function (error) {
  console.error(error);
  process.exitCode = 1;
});
