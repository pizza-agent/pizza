import { readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import { render } from '../.ssr/entry-server.js';
const dist = new URL('../dist/', import.meta.url);
const html = await readFile(new URL('index.html', dist), 'utf8');
await writeFile(new URL('index.html', dist), html.replace('<!--app-html-->', render('en')));
await mkdir(new URL('zh/', dist), { recursive: true });
const zh = html.replace('lang="en"','lang="zh-CN"')
 .replaceAll('Pizza | A little Pizza. A lot done.', 'Pizza | 来一份 Pizza，事情有着落。')
 .replace('Your open-source desktop AI companion for code, ideas, and everyday work. Connect your apps, choose your model, and keep the conversation going.', '开源的桌面 AI 工作伙伴。写代码、找资料、整理想法，连接常用应用，接着聊，也接着做。')
 .replace('An open-source AI companion that works alongside you.', '开源的 AI 工作伙伴，陪你做好在意的事。')
 .replace('rel="canonical" href="https://pizza.hertzbeat.com/"', 'rel="canonical" href="https://pizza.hertzbeat.com/zh/"')
 .replace('property="og:url" content="https://pizza.hertzbeat.com/"', 'property="og:url" content="https://pizza.hertzbeat.com/zh/"')
 .replace('<!--app-html-->', render('zh'));
await writeFile(new URL('zh/index.html', dist), zh);
await rm(new URL('../.ssr', import.meta.url), { recursive: true, force: true });
console.log('Pre-rendered English and Chinese pages.');
