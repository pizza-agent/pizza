import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { PxlKitSurfaceProvider } from '@pxlkit/ui-kit';
import Layout from './src/components/Layout';
import AgentView from './src/views/AgentView';
import { PetSettingsPage } from './src/components/PetSettingsPage';
import {PetFigure} from './src/components/PetFigure';
import type { RpcSessionState } from './src/lib/types';
import './src/index.css';
import i18n from './src/i18n';
void i18n.changeLanguage('zh-CN');
function QA() {
 const [workspace,setWorkspace]=useState('~/.pizza/main');
 const isMain=workspace==='~/.pizza/main';
 const state={isMainAgent:isMain,isStreaming:false,model:{id:'test',name:'Test model',provider:'test'},thinkingLevel:'off',cwd:workspace,capabilities:{mainProfile:isMain}} as unknown as RpcSessionState;
 const workspaces=[{id:'pizza',cwd:'/qa/pizza',last_accessed_at:Date.now(),display_name:'pizza'}];
 if(location.hash==='#states') return <div style={{padding:48,maxWidth:1040,margin:'auto'}}><h1 style={{fontSize:26,fontWeight:650}}>PIP · 表情与动作</h1><p style={{color:'#888',fontSize:14,margin:'10px 0 30px'}}>独立身体、眼睛与视线 · 112 / 48px</p><div style={{display:'grid',gridTemplateColumns:'repeat(4,1fr)',gap:20}}>{(['idle','working','happy','celebrating','sleepy','eating','sad'] as const).map(mood=><section key={mood} style={{background:'#fafafa',borderRadius:16,padding:'18px 12px',display:'flex',flexDirection:'column',alignItems:'center',gap:12}}><PetFigure species="pip" mood={mood} size={112}/><PetFigure species="pip" mood={mood} size={48}/><span style={{fontSize:12,color:'#777'}}>{mood}</span></section>)}</div></div>;
 if(location.hash==='#gallery') return <div style={{padding:48,maxWidth:1100,margin:'auto'}}><h1 style={{fontSize:26,fontWeight:650}}>Pet · 形象与动作</h1><p style={{fontSize:14,color:'#888',marginTop:10,marginBottom:32}}>Pizza 系列 · 分层矢量与独立表情 · 单一角色来源</p><div style={{display:'grid',gridTemplateColumns:'repeat(4,1fr)',gap:18}}>{['pip','mozz','pomo','basi'].map(species=><section key={species} style={{border:'1px solid #e6e6e6',borderRadius:20,padding:'32px 20px',background:'#fafafa',display:'flex',flexDirection:'column',alignItems:'center',gap:20}}><PetFigure species={species} size={150}/><b>{species}</b><div style={{display:'flex',gap:12}}>{(['happy','working','sleepy'] as const).map(mood=><div key={mood} style={{display:'flex',flexDirection:'column',alignItems:'center',gap:8}}><PetFigure species={species} mood={mood} size={50}/><small style={{fontSize:10,color:'#888'}}>{mood}</small></div>)}</div></section>)}</div></div>;
 return <PxlKitSurfaceProvider surface="linear"><MemoryRouter><Routes><Route element={<Layout state={state} workspace={workspace} sidecarReady sidecarExitCode={null} workspaces={workspaces} onSelectWorkspace={setWorkspace}/>}><Route path="/settings" element={<PetSettingsPage/>}/><Route path="*" element={<AgentView key={workspace} state={state} workspace={workspace} sidecarReady sidecarExitCode={null}/>}/></Route></Routes></MemoryRouter></PxlKitSurfaceProvider>;
}
createRoot(document.getElementById('root')!).render(<QA/>);
