/* Minimal ZIP writer for the FigmaPack download.
   Runs inside the UI iframe; also exercised directly by tests/test-zip.cjs. */
let PACK_ZIP_CRC_TABLE = null;

function packCrc32(bytes) {
  if (!PACK_ZIP_CRC_TABLE) {
    const table = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
      table[n] = c >>> 0;
    }
    PACK_ZIP_CRC_TABLE = table;
  }
  let crc = 0xFFFFFFFF;
  for (let i = 0; i < bytes.length; i++) {
    crc = (crc >>> 8) ^ PACK_ZIP_CRC_TABLE[(crc ^ bytes[i]) & 0xFF];
  }
  return (crc ^ 0xFFFFFFFF) >>> 0;
}

function packDosStamp(date) {
  const time = ((date.getHours() & 31) << 11) | ((date.getMinutes() & 63) << 5) |
    (Math.floor(date.getSeconds() / 2) & 31);
  const day = (((date.getFullYear() - 1980) & 127) << 9) |
    (((date.getMonth() + 1) & 15) << 5) | (date.getDate() & 31);
  return { time: time & 0xFFFF, date: day & 0xFFFF };
}

/* entries: [{ name: string, data: Uint8Array, payload: Uint8Array, method: 0 | 8 }] */
function packZipBuild(entries) {
  const chunks = [];
  let offset = 0;
  const put = function (bytes) { chunks.push(bytes); offset += bytes.length; };
  const u16 = function (value) { put(new Uint8Array([value & 0xFF, (value >>> 8) & 0xFF])); };
  const u32 = function (value) {
    put(new Uint8Array([value & 0xFF, (value >>> 8) & 0xFF,
      (value >>> 16) & 0xFF, (value >>> 24) & 0xFF]));
  };
  const stamp = packDosStamp(new Date());
  const directory = [];
  entries.forEach(function (entry) {
    const name = new TextEncoder().encode(entry.name);
    const crc = packCrc32(entry.data);
    const start = offset;
    u32(0x04034B50); u16(20); u16(0); u16(entry.method);
    u16(stamp.time); u16(stamp.date);
    u32(crc); u32(entry.payload.length); u32(entry.data.length);
    u16(name.length); u16(0);
    put(name); put(entry.payload);
    directory.push({ name: name, entry: entry, crc: crc, start: start });
  });
  const directoryStart = offset;
  directory.forEach(function (item) {
    u32(0x02014B50); u16(20); u16(20); u16(0); u16(item.entry.method);
    u16(stamp.time); u16(stamp.date);
    u32(item.crc); u32(item.entry.payload.length); u32(item.entry.data.length);
    u16(item.name.length); u16(0); u16(0);
    u16(0); u16(0); u32(0); u32(item.start);
    put(item.name);
  });
  const directorySize = offset - directoryStart;
  u32(0x06054B50); u16(0); u16(0);
  u16(entries.length); u16(entries.length);
  u32(directorySize); u32(directoryStart); u16(0);
  const output = new Uint8Array(offset);
  let cursor = 0;
  chunks.forEach(function (chunk) { output.set(chunk, cursor); cursor += chunk.length; });
  return output;
}

async function packDeflateRaw(bytes) {
  if (typeof CompressionStream !== 'function') return null;
  try {
    const compressed = new Blob([bytes]).stream()
      .pipeThrough(new CompressionStream('deflate-raw'));
    return new Uint8Array(await new Response(compressed).arrayBuffer());
  } catch (error) {
    return null;
  }
}

/* entries: [{ name: string, data: Uint8Array | string }] */
async function packZip(entries) {
  const prepared = [];
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    const data = typeof entry.data === 'string' ? new TextEncoder().encode(entry.data) : entry.data;
    const deflated = data.length ? await packDeflateRaw(data) : null;
    if (deflated && deflated.length < data.length) {
      prepared.push({ name: entry.name, data: data, payload: deflated, method: 8 });
    } else {
      prepared.push({ name: entry.name, data: data, payload: data, method: 0 });
    }
  }
  return packZipBuild(prepared);
}

/* Download naming: superpowers_export_<DESIGN_FILE_NAME>_<YYYYMMDD-HHMMSS>.zip.
   The design file name is reduced to letters, digits, '-' and '_' so the result is a
   safe filename on every OS; the local timestamp keeps repeated exports unique. */
const PACK_EXPORT_PREFIX = 'superpowers_export_';
const PACK_DB_FILE = 'figma_superpowers.db';
const PACK_DB_ARCHIVE_FILE = 'figma_superpowers_db.zip';
const PACK_PROMPT_FILE = 'FIGMAPACK_AGENT_PROMPT.md';

function packExportFileName(designFileName, date) {
  const pad = function (value) { return (value < 10 ? '0' : '') + value; };
  const slug = String(designFileName || '').replace(/[^\p{L}\p{N}_-]+/gu, '_')
    .replace(/_+/g, '_').replace(/^[_-]+|[_-]+$/g, '').slice(0, 80) || 'Untitled';
  const stamp = date.getFullYear() + pad(date.getMonth() + 1) + pad(date.getDate()) + '-' +
    pad(date.getHours()) + pad(date.getMinutes()) + pad(date.getSeconds());
  return PACK_EXPORT_PREFIX + slug + '_' + stamp + '.zip';
}

/* Nested layout: the outer archive holds the zipped DB plus the prompt Markdown.
   { binary: Uint8Array, prompt: string } → { name, archive: Uint8Array } */
async function packExportArchive(files, designFileName, date) {
  const dbArchive = await packZip([{ name: PACK_DB_FILE, data: files.binary }]);
  const archive = await packZip([
    { name: PACK_DB_ARCHIVE_FILE, data: dbArchive },
    { name: PACK_PROMPT_FILE, data: files.prompt }
  ]);
  return { name: packExportFileName(designFileName, date), archive: archive };
}
