'use strict';

const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const pluginsDir = path.join(root, 'plugins');
const manifestPath = path.join(root, 'manifest.json');
const now = new Date().toISOString();

let prev = { plugins: [] };
try {
  prev = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
} catch {
  // first run
}

const prevByName = new Map((prev.plugins || []).map(p => [p.name, p]));

const dirs = fs
  .readdirSync(pluginsDir)
  .filter(d => {
    if (d === '_template' || d.startsWith('.')) return false;
    return fs.statSync(path.join(pluginsDir, d)).isDirectory();
  })
  .sort();

const core = p => ({
  name: p.name,
  version: p.version,
  description: p.description,
  author: p.author,
  license: p.license,
  category: p.category,
  tags: p.tags || [],
  jsql: p.jsql || { minVersion: '6.0.0', maxVersion: null },
  entry: p.entry,
  files: p.files || [],
  dependencies: p.dependencies || []
});

const registry = {};
const plugins = [];
const skipped = [];

for (const name of dirs) {
  const manifestFile = path.join(pluginsDir, name, 'manifest.json');
  const tarball = path.join(pluginsDir, `${name}.tgz`);
  if (!fs.existsSync(manifestFile)) continue;
  if (!fs.existsSync(tarball)) {
    skipped.push(name);
    continue;
  }

  const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
  registry[name] = { path: `plugins/${name}/`, ...manifest };

  const old = prevByName.get(name);
  const base = core(manifest);
  const entry = {
    ...base,
    downloads: old ? old.downloads || 0 : 0,
    createdAt: old ? old.createdAt : now,
    updatedAt: old ? old.updatedAt : now
  };
  if (old && JSON.stringify(core(old)) !== JSON.stringify(base)) {
    entry.updatedAt = now;
  }
  plugins.push(entry);
}

const order = (prev.plugins || []).map(p => p.name).filter(n => registry[n]);
for (const name of Object.keys(registry)) {
  if (!order.includes(name)) order.push(name);
}
plugins.sort((a, b) => order.indexOf(a.name) - order.indexOf(b.name));

const categories = [...new Set(plugins.map(p => p.category || 'other'))].sort();
const same =
  JSON.stringify({ categories: prev.categories || [], plugins: prev.plugins || [] }) ===
  JSON.stringify({ categories, plugins });

const manifest = {
  schemaVersion: '1.0',
  updatedAt: same ? prev.updatedAt || now : now,
  categories,
  plugins
};

fs.writeFileSync(path.join(root, 'registry.json'), JSON.stringify(registry, null, 2));
fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');

console.log(`registry.json: ${Object.keys(registry).length} plugins`);
console.log(`manifest.json: ${plugins.length} plugins${same ? ' (unchanged)' : ' (updated)'}`);
if (skipped.length) {
  console.warn(`skipped (missing .tgz): ${skipped.join(', ')}`);
}
