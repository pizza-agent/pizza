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
 if(location.hash==='#states') return <div style={{padding:48,maxWidth:1040,margin:'auto'}}><h1 style={{fontSize:26,fontWeight:650}}>Pizza · 表情与动作</h1><p style={{color:'#888',fontSize:14,margin:'10px 0 30px'}}>独立身体、眼睛与视线 · 112 / 48px</p><div style={{display:'grid',gridTemplateColumns:'repeat(4,1fr)',gap:20}}>{(['idle','thinking','working','speaking','waiting','happy','celebrating','sleepy','eating','sad'] as const).map(mood=><section key={mood} style={{background:'#fafafa',borderRadius:16,padding:'18px 12px',display:'flex',flexDirection:'column',alignItems:'center',gap:12}}><PetFigure mood={mood} size={112}/><PetFigure mood={mood} size={48}/><span style={{fontSize:12,color:'#777'}}>{mood}</span></section>)}</div></div>;
 return <PxlKitSurfaceProvider surface="linear"><MemoryRouter><Routes><Route element={<Layout state={state} workspace={workspace} sidecarReady sidecarExitCode={null} workspaces={workspaces} onSelectWorkspace={setWorkspace}/>}><Route path="/settings" element={<PetSettingsPage/>}/><Route path="*" element={<AgentView key={workspace} state={state} workspace={workspace} sidecarReady sidecarExitCode={null}/>}/></Route></Routes></MemoryRouter></PxlKitSurfaceProvider>;
}
createRoot(document.getElementById('root')!).render(<QA/>);
