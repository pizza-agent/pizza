import { ArrowRight, ArrowsLeftRight, ChatCircleDots, Check, Clock, FolderSimple, Robot, TerminalWindow } from '@phosphor-icons/react';
import { featureCopy } from './feature-content';

export function WorkspaceStory({ lang }) {
 const c = featureCopy[lang].workflow;
 return <div className="workspace-story">
  <div className="section-heading reveal"><h2>{c.title}</h2><p>{c.body}</p></div>
  <figure className="workspace-map reveal">
   <div className="workspace-flow">
    <div className="workflow-assistant"><Robot size={34} aria-hidden="true" /><h3>{c.assistant}</h3><p>{c.assistantNote}</p></div>
    <ArrowsLeftRight className="workflow-arrow" size={26} aria-hidden="true" />
    <div className="workflow-projects">{c.projects.map(project => <div key={project}><FolderSimple size={24} aria-hidden="true" /><strong>{project}</strong><span>{c.workspaceNote}</span></div>)}</div>
    <ArrowRight className="workflow-arrow" size={26} aria-hidden="true" />
    <div className="workflow-result"><Check size={28} aria-hidden="true" /><h3>{c.result}</h3><p>{c.resultNote}</p></div>
   </div>
   <figcaption>{c.caption}</figcaption>
  </figure>
  <div className="continuity-notes">{c.notes.map(([title, body]) => <article className="reveal" key={title}><h3>{title}</h3><p>{body}</p></article>)}</div>
 </div>;
}

export function Capabilities({ lang }) {
 const c = featureCopy[lang].capabilities;
 return <section id="possibilities" className="capabilities-section shell section-space">
  <div className="section-heading reveal"><h2>{c.title}</h2><p>{c.body}</p></div>
  <div className="capability-layout">
   <article className="remote-capability reveal"><TerminalWindow size={30} aria-hidden="true" /><h3>{c.remoteTitle}</h3><p>{c.remoteBody}</p><div className="remote-route" aria-hidden="true"><span>{c.local}</span><ArrowRight size={22} /><strong>SSH</strong><span>{c.remote}</span></div></article>
   <article className="channels-capability reveal"><ChatCircleDots size={28} aria-hidden="true" /><div><h3>{c.channelsTitle}</h3><p>{c.channelsBody}</p><div className="channel-names" aria-hidden="true"><span>Slack</span><span>Discord</span><span>Telegram</span><span>Lark</span></div></div></article>
   <article className="schedule-capability reveal"><Clock size={28} aria-hidden="true" /><div><h3>{c.scheduleTitle}</h3><p>{c.scheduleBody}</p><span className="schedule-examples">{c.scheduleExample}</span></div></article>
  </div>
  <p className="capability-note">{c.note}</p>
 </section>;
}

export function FreedomNotes({ lang }) {
 const c = featureCopy[lang].freedom;
 return <dl className="freedom-notes"><div><dt>{c.modelsTitle}</dt><dd>{c.modelsBody}</dd></div><div><dt>{c.extensionsTitle}</dt><dd>{c.extensionsBody}</dd></div></dl>;
}
