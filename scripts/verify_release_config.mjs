import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const read = path => readFile(new URL(`../${path}`, import.meta.url), 'utf8');
const parse = async path => JSON.parse(await read(path));

const [base, mac, windows, workflow] = await Promise.all([
  parse('src-tauri/tauri.conf.json'),
  parse('src-tauri/tauri.macos.conf.json'),
  parse('src-tauri/tauri.windows.conf.json'),
  read('.github/workflows/build.yml'),
]);

assert.equal(base.$schema, 'https://schema.tauri.app/config/2');
assert.equal(base.identifier, 'com.sashaberg.pdfresizer');
assert.deepEqual(base.bundle.resources, []);
assert.deepEqual(mac.bundle.resources, ['bin/ghostscript']);
assert.deepEqual(windows.bundle.resources, ['bin/ghostscript-win']);
assert.deepEqual(windows.bundle.targets, ['nsis']);
assert.match(workflow, /node-version: 24/);
assert.match(workflow, /npm ci/);
assert.match(workflow, /--bundles nsis/);
assert.doesNotMatch(workflow, /makensis|--bundles none/);

console.log('Release configuration is internally consistent.');
