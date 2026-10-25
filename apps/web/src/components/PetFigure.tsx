import { useEffect, useState } from 'react';
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
export function PetFigure({ species, mood = 'idle', look = { x: 0, y: 0 }, busy = false, scale = 1, size = 64, frames, halo = true }: {
 species?: string; mood?: Mood; look?: {x:number;y:number}; busy?: boolean; scale?: number; size?: number;
 /** Art for non-builtin species. */
 frames?: Frames | null;
 halo?: boolean;
}) {
 const amount = Math.min(1.5, Math.max(.7, scale));
 return <span className="pet-figure" data-pet-species={species ?? 'none'} style={{width:size,height:size,'--pet-accent':SPECIES[species ?? '']?.accent ?? '#abb9c8'} as React.CSSProperties}>
  {halo && <span className="pet-figure__aura" aria-hidden="true"/>}
  <span className="pet-figure__art">{species && SPECIES[species]
   ? <PetSprite species={species} mood={mood} look={look} busy={busy} scale={size / 112 * amount}/>
   : species && frames ? <AsciiPet frames={frames} mood={mood} size={size * amount}/> : <Bot size={size*.55} strokeWidth={1.3} style={{color:'#969ba3'}}/>}</span>
 </span>;
}
