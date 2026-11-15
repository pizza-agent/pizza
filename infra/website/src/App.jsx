import { useEffect, useRef, useState } from 'react';
import { ArrowDown, ArrowUpRight, Check, Copy, GithubLogo, Moon, Sun, Play, X, List, AppleLogo, WindowsLogo, LinuxLogo, ChatCircle, GitBranch, SlidersHorizontal } from '@phosphor-icons/react';
import { siNotion, siGithub, siGmail, siGoogledrive, siSlack, siLinear, siTelegram, siDiscord } from 'simple-icons';
import { copy } from './content';
import release from './release.json';
import demo from './demo.json';
const REPO = 'https://github.com/pizza-agent/pizza';
const appLogos = [siNotion, siGithub, siGmail, siGoogledrive, siSlack, siLinear, siTelegram, siDiscord];
const iconProps = { size: 20, weight: 'regular', 'aria-hidden': true };
export default function App({ lang = 'en' }) {
 const c = copy[lang];
 const [menu, setMenu] = useState(false);
 const [theme, setTheme] = useState(null);
 const [copied, setCopied] = useState(false);
 const [copyError, setCopyError] = useState(false);
 const dialog = useRef(null);
 const demoOpener = useRef(null);
 const copyTimer = useRef(null);
 useEffect(() => {
  let observer;
  if (!matchMedia('(prefers-reduced-motion: reduce)').matches) {
   document.documentElement.classList.add('has-motion');
   observer = new IntersectionObserver(entries => entries.forEach(e => { if (e.isIntersecting) { e.target.classList.add('is-visible'); observer.unobserve(e.target); } }), { threshold: .12 });
   document.querySelectorAll('.reveal').forEach(el => observer.observe(el));
  }
  const initial = document.documentElement.dataset.theme || (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
  setTheme(initial);
  return () => { observer?.disconnect(); document.documentElement.classList.remove('has-motion'); clearTimeout(copyTimer.current); };
 }, []);
 function toggleTheme() {
  const next = theme === 'dark' ? 'light' : 'dark';
  document.documentElement.dataset.theme = next; setTheme(next);
  try { localStorage.setItem('pizza-site-theme', next); } catch {}
 }
 async function copyCommand() {
  try { await navigator.clipboard.writeText('npm install -g @tomsun28/pizza'); setCopied(true); setCopyError(false); clearTimeout(copyTimer.current); copyTimer.current = setTimeout(() => setCopied(false), 2400); }
  catch { setCopyError(true); }
 }
 function openDemo(event) { demoOpener.current = event.currentTarget; dialog.current.showModal(); }
 function closeDemo() { dialog.current.querySelector('video')?.pause(); dialog.current.close(); demoOpener.current?.focus(); }
 return <>
  <a className="skip-link" href="#main">{c.skip}</a>
  <header className="site-header shell">
   <a className="wordmark" href={lang === 'zh' ? '/zh/' : '/'} aria-label="Pizza"><img src="/media/pizza-icon.webp" width="42" height="42" alt="" /><span>pizza</span></a>
   <nav className={menu ? 'main-nav is-open' : 'main-nav'} aria-label={lang === 'zh' ? '主导航' : 'Main navigation'}>
    {c.nav.map((label,i) => <a key={label} href={['#meet','#apps','#questions'][i]} onClick={() => setMenu(false)}>{label}</a>)}
   </nav>
   <div className="nav-actions">
    <a className="icon-button github-link" href={REPO} aria-label={c.source}><GithubLogo {...iconProps} /></a>
    <a className="language-link" href={lang === 'zh' ? '/' : '/zh/'} aria-label={c.language}>{lang === 'zh' ? 'EN' : '中文'}</a>
    <button className="icon-button" aria-label={c.theme} onClick={toggleTheme}>{theme === 'dark' ? <Sun {...iconProps} /> : <Moon {...iconProps} />}</button>
    <button className="icon-button mobile-menu" aria-label={c.menu} aria-expanded={menu} onClick={() => setMenu(!menu)}>{menu ? <X {...iconProps} /> : <List {...iconProps} />}</button>
   </div>
  </header>
  <main id="main">
   <section className="hero shell">
    <div className="hero-copy">
     <p className="eyebrow">{c.eyebrow}</p>
     <h1>{c.title[0]}<span>{c.title[1]}</span></h1>
     <p className="hero-intro">{c.intro}</p>
     <div className="hero-actions"><a className="button button-primary" href="#download">{c.download}<ArrowDown {...iconProps} /></a><button className="text-button" onClick={openDemo}><Play size={17} weight="fill" aria-hidden="true" />{c.watch}</button></div>
    </div>
    <div className="hero-art"><img src="/media/pizza-studio.webp" alt={lang === 'zh' ? '漂浮在积木上的 Pizza 披萨雕塑' : 'A playful Pizza sculpture floating above a stack of tiles'} width="1200" height="800" fetchpriority="high" /></div>
   </section>
   <section id="meet" className="product-section shell section-space">
    <div className="section-heading reveal"><h2>{c.productTitle}</h2><p>{c.productBody}</p></div>
    <figure className="product-figure reveal"><button className="demo-preview" onClick={openDemo} aria-label={c.play}><img src={demo.poster} width={demo.width} height={demo.height} alt={c.demo} loading="lazy" /><span className="play-control"><Play size={24} weight="fill" aria-hidden="true" /></span></button><figcaption>{c.demoCaption}</figcaption></figure>
    <div className="feature-notes">{c.features.map(([title, body],i) => {const Icon = [ChatCircle,GitBranch,SlidersHorizontal][i];return <article className={`feature-note feature-note-${i} reveal`} key={title}><Icon size={27} weight="regular" aria-hidden="true" /><h3>{title}</h3><p>{body}</p></article>;})}</div>
   </section>
   <section id="apps" className="apps-section section-space">
    <div className="shell apps-layout"><div className="apps-copy reveal"><h2>{c.appsTitle}</h2><p>{c.appsBody}</p><a className="inline-link" href={`${REPO}/blob/main/README${lang === 'zh' ? '.zh-CN' : ''}.md`}>{c.appsLink}<ArrowUpRight {...iconProps} /></a><p className="small-note">{c.appsNote}</p></div>
    <div className="app-grid reveal" aria-label={lang === 'zh' ? '可连接的应用和渠道' : 'Apps and channels you can connect'}>{appLogos.map(icon => <div className="app-logo" key={icon.slug} title={icon.title}><svg role="img" aria-label={icon.title} viewBox="0 0 24 24"><path d={icon.path} /></svg><span>{icon.title}</span></div>)}</div></div>
   </section>
   <section className="open-section shell section-space"><div className="open-mark reveal" aria-hidden="true"><span>pizza</span><GithubLogo size={52} weight="regular" /><span className="open-license">Apache 2.0</span></div><div className="open-copy reveal"><h2>{c.whyTitle}</h2><p>{c.whyBody}</p><ul>{c.whyPoints.map(text => <li key={text}><Check size={18} aria-hidden="true" />{text}</li>)}</ul><a className="inline-link" href={REPO}>{c.whyLink}<ArrowUpRight {...iconProps} /></a></div></section>
   <section id="questions" className="faq-section shell section-space"><h2 className="reveal">{c.faqTitle}</h2><div className="faq-list reveal">{c.faq.map(([q,a]) => <details key={q}><summary>{q}<span aria-hidden="true">+</span></summary><p>{a}</p></details>)}</div></section>
   <section id="download" className="download-section shell section-space"><div className="download-heading reveal"><img src="/media/pizza-icon.webp" width="64" height="64" alt="" loading="lazy" /><h2>{c.downloadTitle}</h2><p>{c.downloadBody}</p></div><div className="download-options reveal">{[['macOS','macos',AppleLogo],['Windows','windows',WindowsLogo],['Linux','linux',LinuxLogo]].map(([name,key,Icon],i) => <a className="platform-download" key={key} href={release[key]}><Icon size={28} weight="fill" aria-hidden="true" /><span><strong>{name}</strong><small>{c.platforms[i]}</small></span><ArrowDown {...iconProps} /></a>)}</div><a className="release-link" href="https://github.com/pizza-agent/pizza/releases/latest">{c.release}<ArrowUpRight size={15} aria-hidden="true" /></a><div className="cli-install"><span>{c.cli}</span><div className="command-line"><code>npm install -g @tomsun28/pizza</code><button className="icon-button" onClick={copyCommand} aria-label={copied ? c.copied : c.copy}>{copied ? <Check {...iconProps} /> : <Copy {...iconProps} />}</button></div><span className="copy-status" role="status">{copied ? c.copied : copyError ? c.copyError : ''}</span></div></section>
  </main>
  <footer className="site-footer shell"><div><a className="footer-brand" href={lang === 'zh' ? '/zh/' : '/'}>pizza</a><p>{c.footer}</p></div><div className="footer-right"><nav aria-label={lang === 'zh' ? '更多信息' : 'More information'}>{c.links.map((text,i) => <a key={text} href={[REPO,`${REPO}/issues`,`${REPO}/blob/main/LICENSE`][i]}>{text}</a>)}</nav><p>{c.footerNote}</p></div></footer>
  <dialog className="demo-dialog" ref={dialog} aria-label={c.demo} onCancel={event => { event.preventDefault(); closeDemo(); }} onClick={e => { if(e.target === dialog.current) closeDemo(); }}><button className="dialog-close icon-button" onClick={closeDemo} aria-label={c.close}><X size={24} aria-hidden="true" /></button><video width={demo.width} height={demo.height} controls playsInline preload="none" poster={demo.poster}><source src={demo.video} type="video/mp4" /></video></dialog>
 </>;
}
