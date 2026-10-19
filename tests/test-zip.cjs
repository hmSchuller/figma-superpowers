const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
const source = fs.readFileSync(path.join(root, 'src', 'zip.js'), 'utf8');
const context = vm.createContext({
  TextEncoder, Blob, Response, CompressionStream, Uint8Array, Uint32Array, Date, Math, console
});
vm.runInContext(source, context, { filename: 'zip.js' });
const packZip = vm.runInContext('packZip', context);

const DB = Buffer.alloc(256 * 40);
for (let i = 0; i < DB.length; i++) DB[i] = i % 256;

const VERIFY = [
  'import sys, zipfile',
  'z = zipfile.ZipFile(sys.argv[1])',
  'assert z.testzip() is None, "CRC mismatch"',
  'assert sorted(z.namelist()) == ["FIGMAPACK_AGENT_PROMPT.md", "figma_superpowers.db"]',
  'assert z.read("FIGMAPACK_AGENT_PROMPT.md").decode() == "# FigmaPack\\n"',
  'assert z.read("figma_superpowers.db") == bytes(i % 256 for i in range(256 * 40))',
  'methods = {i.filename: i.compress_type for i in z.infolist()}',
  'assert methods["figma_superpowers.db"] in (0, 8), methods',
  'print("PASS zip: figma_superpowers.zip holds the DB and the prompt")'
].join('\n');

(async function () {
  const archive = await packZip([
    { name: 'figma_superpowers.db', data: new Uint8Array(DB) },
    { name: 'FIGMAPACK_AGENT_PROMPT.md', data: '# FigmaPack\n' }
  ]);
  assert.ok(archive instanceof Uint8Array, 'archive must be a Uint8Array');
  assert.equal(archive[0], 0x50, 'missing PK local-header signature');
  assert.equal(archive[1], 0x4B);
  const file = path.join(os.tmpdir(), 'figmapack-zip-test-' + process.pid + '.zip');
  fs.writeFileSync(file, archive);
  try {
    execFileSync('python3', ['-c', VERIFY, file], { stdio: 'inherit' });
  } finally {
    fs.rmSync(file, { force: true });
  }
})().catch(function (error) {
  console.error(error);
  process.exitCode = 1;
});
