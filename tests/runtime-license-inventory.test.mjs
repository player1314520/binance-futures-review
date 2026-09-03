import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('browser runtime dependency inventory is exact and lockfile-bound', () => {
  const inventoryPath = fs.existsSync(path.join(ROOT, 'RUNTIME-DEPENDENCY-LICENSES.json'))
    ? path.join(ROOT, 'RUNTIME-DEPENDENCY-LICENSES.json')
    : path.join(ROOT, 'public-staging', 'runtime-dependency-licenses.json');
  const inventory = JSON.parse(fs.readFileSync(inventoryPath, 'utf8'));
  const lock = fs.readFileSync(path.join(ROOT, 'pnpm-lock.yaml'), 'utf8');
  const names = inventory.packages.map(({ name, version }) => `${name}@${version}`);

  assert.equal(inventory.format, 'rv-runtime-dependency-licenses/1');
  assert.deepEqual(names, [
    'cookie@1.1.1',
    'js-tokens@4.0.0',
    'loose-envify@1.4.0',
    'react@18.3.1',
    'react-dom@18.3.1',
    'react-router@7.18.2',
    'react-router-dom@7.18.2',
    'scheduler@0.23.2',
    'set-cookie-parser@2.7.2',
  ]);
  for (const entry of inventory.packages) {
    assert.equal(entry.license, 'MIT', `${entry.name} license must be independently resolved`);
    assert.match(entry.integrity, /^sha512-[A-Za-z0-9+/]+={0,2}$/);
    assert.ok(lock.includes(entry.integrity.slice('sha512-'.length)), `${entry.name} integrity must match the frozen lockfile`);
  }

  const app = JSON.parse(fs.readFileSync(path.join(ROOT, 'app', 'package.json'), 'utf8'));
  assert.deepEqual(Object.keys(app.dependencies).sort(), ['@rv/engine', 'react', 'react-dom', 'react-router-dom']);
  const licenseTextPath = fs.existsSync(path.join(ROOT, 'LICENSES', 'RUNTIME-DEPENDENCIES.md'))
    ? path.join(ROOT, 'LICENSES', 'RUNTIME-DEPENDENCIES.md')
    : path.join(ROOT, 'public-staging', 'RUNTIME-LICENSES.md');
  const licenseText = fs.readFileSync(licenseTextPath, 'utf8');
  for (const heading of ['React family', 'React Router family', 'cookie', 'loose-envify', 'js-tokens', 'set-cookie-parser']) {
    assert.match(licenseText, new RegExp(`^## ${heading}$`, 'm'));
  }
});
