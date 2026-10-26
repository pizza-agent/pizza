import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { PxlKitSurfaceProvider } from '@pxlkit/ui-kit';
import Layout from './src/components/Layout';
import AgentView from './src/views/AgentView';
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
 if(location.hash==='#gallery') return <div style={{padding:48,maxWidth:1100,margin:'auto'}}><h1 style={{fontSize:26,fontWeight:650}}>Pet · 形象与动作</h1><p style={{fontSize:14,color:'#888',marginTop:10,marginBottom:32}}>柔和体积、眼睛高光、独立耳尾动作 · 共享同一个角色</p><div style={{display:'grid',gridTemplateColumns:'repeat(4,1fr)',gap:18}}>{['cat','dog','slime','pixel-mochi'].map(species=><section key={species} style={{border:'1px solid #e6e6e6',borderRadius:20,padding:'32px 20px',background:'#fafafa',display:'flex',flexDirection:'column',alignItems:'center',gap:20}}><PetFigure species={species} size={150}/><b>{species}</b><div style={{display:'flex',gap:12}}>{(['happy','working','sleepy'] as const).map(mood=><div key={mood} style={{display:'flex',flexDirection:'column',alignItems:'center',gap:8}}><PetFigure species={species} mood={mood} size={50}/><small style={{fontSize:10,color:'#888'}}>{mood}</small></div>)}</div></section>)}</div></div>;
 return <PxlKitSurfaceProvider surface="linear"><MemoryRouter><Routes><Route element={<Layout state={state} workspace={workspace} sidecarReady sidecarExitCode={null} workspaces={workspaces} onSelectWorkspace={setWorkspace}/>}><Route path="*" element={<AgentView key={workspace} state={state} workspace={workspace} sidecarReady sidecarExitCode={null}/>}/></Route></Routes></MemoryRouter></PxlKitSurfaceProvider>;
}
createRoot(document.getElementById('root')!).render(<QA/>);
