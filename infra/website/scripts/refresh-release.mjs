import { writeFile } from 'node:fs/promises';
const response = await fetch('https://api.github.com/repos/pizza-agent/pizza/releases/latest', { headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'pizza-website-build' }, signal: AbortSignal.timeout(15000) });
if (!response.ok) throw new Error(`GitHub release lookup failed: ${response.status}`);
const release = await response.json();
const find = pattern => {
 const asset = release.assets.find(a => pattern.test(a.name));
 if (!asset || !asset.browser_download_url.startsWith('https://github.com/pizza-agent/pizza/releases/download/')) throw new Error('Missing verified release asset');
 return asset.browser_download_url;
};
const data = { version: release.tag_name, page: release.html_url, macos: find(/macos_arm64\.dmg$/), windows: find(/windows_x64-setup\.exe$/), linux: find(/linux_x64\.AppImage$/) };
await writeFile(new URL('../src/release.json', import.meta.url), JSON.stringify(data, null, 2) + '\n');
console.log(`Updated public download links for ${data.version}`);
