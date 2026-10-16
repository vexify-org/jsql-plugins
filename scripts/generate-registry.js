const fs = require('fs');
const path = require('path');

const pluginsDir = path.join(__dirname, '../plugins');

// Bug fix: handle missing plugins directory gracefully
let dirs;
try {
  dirs = fs.readdirSync(pluginsDir).filter(d => d !== '_template');
} catch (e) {
  console.warn(`⚠️  Cannot read plugins directory: ${e.message}`);
  dirs = [];
}

const registry = {};

dirs.forEach(name => {
  const manifestPath = path.join(pluginsDir, name, 'manifest.json');
  if (fs.existsSync(manifestPath)) {
    try {
      const raw = fs.readFileSync(manifestPath, 'utf8');
      const manifest = JSON.parse(raw);
      registry[name] = {
        path: `plugins/${name}/`,
        ...manifest
      };
    } catch (e) {
      console.warn(`⚠️  Skipping "${name}": invalid manifest.json — ${e.message}`);
    }
  }
});

const registryJson = JSON.stringify(registry, null, 2);
fs.writeFileSync('registry.json', registryJson);
console.log(`Generated registry.json with ${Object.keys(registry).length} plugins`);

// Also update manifest.json (the format the PHP API reads)
const manifest = {
  schemaVersion: '1.0',
  updatedAt: new Date().toISOString(),
  plugins: Object.values(registry)
};
fs.writeFileSync('manifest.json', JSON.stringify(manifest, null, 2));
console.log(`Generated manifest.json with ${manifest.plugins.length} plugins`);
