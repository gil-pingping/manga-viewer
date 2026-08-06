import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { createPublicKey, generateKeyPairSync } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { homedir } from 'node:os';

const privateKeyPath = resolve(
  process.env.MV_OTA_PRIVATE_KEY || `${homedir()}/.config/manga-viewer/ota-private.pem`
);
const publicKeyPath = resolve('keys/ota-public.pem');

await mkdir(dirname(privateKeyPath), { recursive: true });
await mkdir(dirname(publicKeyPath), { recursive: true });

let privateKey;
try {
  privateKey = await readFile(privateKeyPath, 'utf8');
} catch (err) {
  if (err.code !== 'ENOENT') throw err;

  const pair = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    publicKeyEncoding: { type: 'spki', format: 'pem' },
  });
  privateKey = pair.privateKey;
  await writeFile(privateKeyPath, privateKey, { mode: 0o600 });
}

await chmod(privateKeyPath, 0o600);
const publicKey = createPublicKey(privateKey).export({ type: 'spki', format: 'pem' });
await writeFile(publicKeyPath, publicKey);

console.log(`OTA private key: ${privateKeyPath}`);
console.log(`OTA public key:  ${publicKeyPath}`);
