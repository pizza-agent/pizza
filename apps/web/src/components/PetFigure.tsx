import { useEffect, useRef, useState } from 'react';
import { Bot } from 'lucide-react';
import { PetSprite, SPECIES, type Mood } from './pet-shared';
import type { PetSpecies } from '@/lib/pet';
import './pet-figure.css';

type Frames = PetSpecies['frames'];

/** ASCII art for user/plugin species, animated through the mood's frames. */
function AsciiPet({ frames, mood, size }: { frames: Frames; mood: Mood; size: number }) {
 const list = frames[mood]?.length ? frames[mood]! : frames.idle?.length ? frames.idle : ['( ? )'];
 const [i, setI] = useState(0);
 const animation = list.join('\u0000');
 const count = list.length;
 useEffect(() => {
  setI(0);
  if (count < 2) return;
  const timer = setInterval(() => setI((n) => n + 1), 800);
  return () => clearInterval(timer);
 }, [animation, count]);
 const art = list[i % list.length];
 const rows = art.split('\n');
 const cols = Math.max(...rows.map((r) => r.length), 1);
 const font = Math.max(6, Math.min(size / (cols * 0.62), size / (rows.length * 1.25)));
 return <pre className="pet-figure__ascii" style={{ fontSize: font }}>{art}</pre>;
}

/** The same compact character and soft local halo inside and outside the app. */
export function PetFigure({ species, mood = 'idle', look = { x: 0, y: 0 }, busy = false, scale = 1, size = 64, frames, halo = true, onReady }: {
 species?: string; mood?: Mood; look?: {x:number;y:number}; busy?: boolean; scale?: number; size?: number;
 /** Art for non-builtin species. */
 frames?: Frames | null;
 halo?: boolean;
 onReady?: () => void;
}) {
 const figure = useRef<HTMLSpanElement>(null);

 const amount = Math.min(1.5, Math.max(.7, scale));
 const dim = Math.round(size * amount);
 const readyCallback=useRef(onReady);readyCallback.current=onReady;
 const builtin=Boolean(species && SPECIES[species] && !frames);
 useEffect(()=>{if(!builtin)readyCallback.current?.();},[builtin,species]);
 const sprite = species && SPECIES[species] && !frames
  ? <PetSprite species={species} mood={mood} look={look} busy={busy} scale={dim / 112} onReady={onReady}/>
  : null;
 return <span ref={figure} className="pet-figure" data-pet-species={species ?? 'none'} style={{width:dim,height:dim,'--pet-accent':SPECIES[species ?? '']?.accent ?? '#abb9c8'} as React.CSSProperties}>
  {halo && <span className="pet-figure__aura" aria-hidden="true"/>}
  <span className="pet-figure__art">{sprite ?? (species && frames ? <AsciiPet frames={frames} mood={mood} size={dim}/> : <Bot size={size*.55} strokeWidth={1.3} style={{color:'#969ba3'}}/>)}</span>
 </span>;
}
