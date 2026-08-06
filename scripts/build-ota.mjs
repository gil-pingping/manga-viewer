import { createHash, createSign } from 'node:crypto';
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, relative, resolve, sep } from 'node:path';
import JSZip from 'jszip';
import { NATIVE_VERSION } from '../src/core/otaManifest.js';

const DIST = resolve('dist');
const OUTPUT = join(DIST, 'ota');
const PRIVATE_KEY = resolve(
  process.env.MV_OTA_PRIVATE_KEY || `${homedir()}/.config/manga-viewer/ota-private.pem`
);
const ORIGIN = (process.env.MV_OTA_ORIGIN || 'https://manga-viewer.giyun.workers.dev').replace(
  /\/$/,
  ''
);

async function filesUnder(dir) {
  const out = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await filesUnder(path)));
    else if (entry.isFile()) out.push(path);
  }
  return out;
}

let privateKey;
try {
  privateKey = await readFile(PRIVATE_KEY, 'utf8');
} catch (err) {
  if (err.code === 'ENOENT') {
    throw new Error(`OTA 서명키가 없습니다. 먼저 npm run ota:key 실행: ${PRIVATE_KEY}`);
  }
  throw err;
}

await rm(OUTPUT, { recursive: true, force: true });

const files = (await filesUnder(DIST))
  .filter((path) => !path.startsWith(OUTPUT + sep))
  .sort((a, b) => a.localeCompare(b));
if (!files.some((path) => relative(DIST, path) === 'index.html')) {
  throw new Error('dist/index.html 이 없습니다. vite build 뒤에 실행하세요.');
}

const contentHash = createHash('sha256');
const zip = new JSZip();
for (const path of files) {
  const name = relative(DIST, path).split(sep).join('/');
  const bytes = await readFile(path);
  contentHash.update(name).update('\0').update(bytes);
  // 같은 웹 결과면 같은 bundleId·ZIP이 나오게 시간값을 고정한다.
  zip.file(name, bytes, { date: new Date('2000-01-01T00:00:00Z') });
}

const bundleId = `web-${contentHash.digest('hex').slice(0, 20)}`;
const zipBytes = await zip.generateAsync({
  type: 'nodebuffer',
  compression: 'DEFLATE',
  compressionOptions: { level: 9 },
  platform: 'UNIX',
});
const checksum = createHash('sha256').update(zipBytes).digest('hex');
const signature = createSign('RSA-SHA256').update(zipBytes).end().sign(privateKey, 'base64');
const zipName = `${bundleId}.zip`;

await mkdir(OUTPUT, { recursive: true });
await writeFile(join(OUTPUT, zipName), zipBytes);
await writeFile(
  join(OUTPUT, 'latest.json'),
  JSON.stringify(
    {
      schemaVersion: 1,
      bundleId,
      url: `${ORIGIN}/ota/${zipName}`,
      checksum,
      signature,
      nativeVersion: NATIVE_VERSION,
      createdAt: new Date().toISOString(),
    },
    null,
    2
  ) + '\n'
);

console.log(`OTA ${bundleId}: ${zipBytes.length} bytes`);
