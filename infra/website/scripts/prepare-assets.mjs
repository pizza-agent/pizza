import sharp from 'sharp';
import { mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../', import.meta.url));
await mkdir(`${root}public/media`, { recursive: true });
await Promise.all([
 sharp(`${root}assets-source/pizza-studio.png`).resize({ width: 1200, withoutEnlargement: true }).webp({ quality: 83 }).toFile(`${root}public/media/pizza-studio.webp`),
 sharp(`${root}../../apps/web/public/pizza-icon.png`).resize(128).webp({ quality: 90 }).toFile(`${root}public/media/pizza-icon.webp`),
 sharp(`${root}../../apps/web/public/pizza-icon.png`).resize(64).png().toFile(`${root}public/favicon.png`),
]);
