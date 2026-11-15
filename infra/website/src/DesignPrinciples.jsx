'use client';

import { useState } from 'react';
import { ArrowCounterClockwise, ArrowDown, ArrowRight, Database, GitBranch } from '@phosphor-icons/react';
import { featureCopy } from './feature-content';

const principles = ['events', 'memory', 'tool', 'runtime'];

function EventDiagram({ c }) {
 const [count, setCount] = useState(3);
 return <div className="event-diagram">
  <div className="event-log"><h4><Database size={20} aria-hidden="true" />{c.log}</h4><ol>{c.entries.slice(0, count).map(([code, label]) => <li key={code}><code>{code}</code><span>{label}</span></li>)}</ol><button className="diagram-action" onClick={() => setCount(count === c.entries.length ? 1 : count + 1)}>{count === c.entries.length ? <ArrowCounterClockwise size={17} aria-hidden="true" /> : <ArrowRight size={17} aria-hidden="true" />}{count === c.entries.length ? c.restart : c.next}</button><span className="event-count" aria-live="polite">{count} / {c.entries.length}</span></div>
  <ArrowRight className="projection-arrow" size={28} aria-hidden="true" />
  <div className="event-views"><h4>{c.projections}</h4>{c.views.map(view => <div key={view}>{view}</div>)}</div>
 </div>;
}

function MemoryDiagram({ c }) {
 const [branch, setBranch] = useState(0);
 return <div className="memory-diagram">
  <div className="memory-root"><GitBranch size={23} aria-hidden="true" />{c.root}</div>
  <div className="memory-trunk" aria-hidden="true" />
  <div className="memory-branches" role="group" aria-label={c.choose}>{[c.branchA, c.branchB].map((label, index) => <button key={label} aria-pressed={branch === index} onClick={() => setBranch(index)}><GitBranch size={21} aria-hidden="true" />{label}</button>)}</div>
  <p className="branch-status" aria-live="polite">{c.active}: {branch === 0 ? c.branchA : c.branchB}<span>{c.retained}</span></p>
 </div>;
}

function ToolDiagram({ c }) {
 return <div className="tool-diagram"><div className="single-tool"><span>{c.label}</span><strong>CLI</strong></div><ArrowRight className="tool-arrow" size={28} aria-hidden="true" /><div className="tool-commands">{['_read', '_write', '_edit', '_tell'].map((command, i) => <div key={command}><code>{command}</code><span>{c.actions[i]}</span></div>)}</div></div>;
}

function RuntimeDiagram({ c }) {
 return <div className="runtime-diagram"><div className="runtime-entrances">{c.interfaces.map(name => <span key={name}>{name}</span>)}</div><ArrowDown size={24} aria-hidden="true" /><div className="runtime-engine"><strong>SessionFacade</strong><span>{c.engine}</span></div><p>{c.stream}</p></div>;
}

export default function DesignPrinciples({ lang }) {
 const c = featureCopy[lang].design;
 const [active, setActive] = useState(0);
 function onTabKey(event, index) {
  let next;
  if (event.key === 'ArrowRight') next = (index + 1) % principles.length;
  else if (event.key === 'ArrowLeft') next = (index + principles.length - 1) % principles.length;
  else if (event.key === 'Home') next = 0;
  else if (event.key === 'End') next = principles.length - 1;
  else return;
  event.preventDefault();
  setActive(next);
  event.currentTarget.parentElement.querySelectorAll('[role="tab"]')[next].focus();
 }
 return <section id="design" className="design-section shell section-space">
  <div className="section-heading reveal"><h2>{c.title[0]} <span className="design-title-tail">{c.title[1]}</span></h2><p>{c.body}</p></div>
  <div className="principles-explorer reveal">
   <div className="principle-tabs" role="tablist" aria-label={featureCopy[lang].designNav}>{principles.map((id, i) => <button key={id} id={`design-tab-${lang}-${id}`} role="tab" aria-selected={active === i} aria-controls={`design-panel-${lang}-${id}`} tabIndex={active === i ? 0 : -1} onClick={() => setActive(i)} onKeyDown={event => onTabKey(event, i)}>{c.tabs[i]}</button>)}</div>
   {principles.map((id, index) => <div className="principle-panel" key={id} id={`design-panel-${lang}-${id}`} role="tabpanel" aria-labelledby={`design-tab-${lang}-${id}`} hidden={active !== index} tabIndex={0}>
    <div className="principle-copy"><h3>{c[id].title}</h3><p>{c[id].body}</p></div>
    <figure className="principle-schematic"><figcaption>{c.diagram}</figcaption>{id === 'events' ? <EventDiagram c={c.events} /> : id === 'memory' ? <MemoryDiagram c={c.memory} /> : id === 'tool' ? <ToolDiagram c={c.tool} /> : <RuntimeDiagram c={c.runtime} />}</figure>
    <p className="principle-note">{c[id].note}</p>
   </div>)}
  </div>
  <a className="inline-link design-source" href={`https://github.com/pizza-agent/pizza/blob/main/README${lang === 'zh' ? '.zh-CN' : ''}.md`}>{c.source}<ArrowRight size={18} aria-hidden="true" /></a>
 </section>;
}
