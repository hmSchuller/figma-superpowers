import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

const root = process.cwd();
const source = (name) => readFileSync(resolve(root, 'src', name), 'utf8');
const candidates = [
  resolve(root, 'node_modules/sql.js-fts5/dist/sql-asm-memory-growth.js'),
  resolve(root, 'node_modules/sql.js-fts5/dist/sql-asm.js')
];
const sqliteFile = candidates.find(existsSync);
if (!sqliteFile) throw new Error('Missing embedded SQLite. Run npm install before npm run build.');
const sqliteLibrary = readFileSync(sqliteFile, 'utf8').replace(/<\/script/gi, '<\\/script');
const backend = source('exporter.js') + '\n' + source('code.js');
// Replacer functions, not strings: the embedded libraries contain `$&`/`$'`
// sequences that String#replace would otherwise expand back into the output.
const ui = source('ui.html').replace('/*__EMBED_SQLITE__*/', () => sqliteLibrary)
  .replace('/*__EMBED_PACK_DB__*/', () => source('database.js'));
if (ui.includes('/*__EMBED_SQLITE__*/') || ui.includes('/*__EMBED_PACK_DB__*/')) {
  throw new Error('Unreplaced build placeholders in HTML');
}
const licensePath = resolve(root, 'node_modules/sql.js-fts5/LICENSE');
if (!existsSync(licensePath)) throw new Error('Bundled SQLite LICENSE is missing');
writeFileSync(resolve(root, 'LICENSE-SQLJS.txt'), readFileSync(licensePath));
writeFileSync(resolve(root, 'code.js'), backend);
writeFileSync(resolve(root, 'ui.html'), ui);
console.log('Built Figma Superpowers with embedded offline SQLite.');
