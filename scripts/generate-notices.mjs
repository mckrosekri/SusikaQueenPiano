import { readFile, readdir, writeFile, mkdir, copyFile } from 'node:fs/promises';
const lock = JSON.parse(await readFile('package-lock.json', 'utf8'));
const dependencies = [];
await mkdir('public/licenses/dependencies', { recursive: true });
for (const [path, locked] of Object.entries(lock.packages)) {
  if (!path || locked.dev || locked.devOptional) continue;
  const name = path.split('node_modules/').at(-1);
  let pkg;
  try { pkg = JSON.parse(await readFile(`${path}/package.json`, 'utf8')); }
  catch { continue; } // Platform-specific optional packages may not be installed.
  const files = (await readdir(path, { withFileTypes: true })).filter(file => file.isFile() && /^(licen[cs]e|copying|notice)(\.|$)/i.test(file.name));
  const copied = [];
  for (const file of files) {
    const filename = `${name.replaceAll('/', '__').replace('@', '')}-${pkg.version}-${file.name}`;
    await copyFile(`${path}/${file.name}`, `public/licenses/dependencies/${filename}`);
    copied.push(`dependencies/${filename}`);
  }
  dependencies.push({ name, version: pkg.version, license: pkg.license ?? locked.license ?? 'See package source', source: `https://www.npmjs.com/package/${name}/v/${pkg.version}`, repository: typeof pkg.repository === 'string' ? pkg.repository : pkg.repository?.url, notices: copied });
}
await writeFile('public/licenses/dependencies.json', JSON.stringify(dependencies, null, 2) + '\n');
await writeFile('THIRD_PARTY_NOTICES.md', '# Third-party notices\n\nFirst-party game code is MIT. Dependencies retain their own licenses. Copies of available production dependency licenses are bundled under `public/licenses/dependencies/`; the exact-version source links are in `public/licenses/dependencies.json`.\n\nManrope font artwork is OFL-1.1 (see `public/licenses/manrope-OFL.txt`). The unmodified SoundTouchJS packages are MPL-2.0; recipients can obtain their exact original distributable sources from the links below. No dependency license is replaced by the game MIT license.\n\n| Package | Version | License | Source |\n|---|---|---|---|\n' + dependencies.map(item => `| ${item.name} | ${item.version} | ${item.license} | [Exact package](${item.source}) |`).join('\n') + '\n');
console.log(`Recorded ${dependencies.length} production dependencies and copied their available notices.`);
