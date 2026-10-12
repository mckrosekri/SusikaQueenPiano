import { ArrowLeft, Minus, Plus, RotateCcw } from 'lucide-react';
import { useEffect, useRef, useState, type PointerEvent } from 'react';
import { reportDiagnostic } from '../services/diagnostics';
interface CalibrationProps { value: number; onSave: (value: number) => void; onBack: () => void }
export function Calibration({ value, onSave, onBack }: CalibrationProps) {
  const [offset,setOffset]=useState(value),[running,setRunning]=useState(false),[tapCount,setTapCount]=useState(0),[error,setError]=useState('');
  const context=useRef<AudioContext|null>(null),ring=useRef<HTMLDivElement>(null),dot=useRef<HTMLSpanElement>(null);
  const startAt=useRef(0),nextAt=useRef(0),frame=useRef(0),timer=useRef<ReturnType<typeof setInterval>|undefined>(undefined);
  const offsets=useRef<number[]>([]),offsetRef=useRef(offset),active=useRef(false);offsetRef.current=offset;
  function audibleTime(at=performance.now()){
    const c=context.current!,stamp=c.getOutputTimestamp?.();
    if(stamp?.contextTime&&stamp?.performanceTime)return stamp.contextTime+(at-stamp.performanceTime)/1000;
    return c.currentTime-(c.outputLatency??c.baseLatency??0)+(at-performance.now())/1000;
  }
  function stop(){active.current=false;clearInterval(timer.current);cancelAnimationFrame(frame.current);setRunning(false);void context.current?.suspend();}
  useEffect(()=>()=>{active.current=false;clearInterval(timer.current);cancelAnimationFrame(frame.current);void context.current?.close().catch(error=>reportDiagnostic(error,{operation:'calibration.audio_close',fallback:'context_disposed'}));},[]);
  async function toggle(){if(active.current){stop();return;}try{
    context.current??=new AudioContext({latencyHint:'interactive'});await context.current.resume();const c=context.current;
    startAt.current=c.currentTime+.2;nextAt.current=startAt.current;offsets.current=[];setTapCount(0);setError('');active.current=true;setRunning(true);
    const schedule=()=>{while(nextAt.current<c.currentTime+.15){const t=nextAt.current;nextAt.current+=.6;const oscillator=c.createOscillator(),gain=c.createGain();oscillator.frequency.value=760;gain.gain.setValueAtTime(.12,t);gain.gain.exponentialRampToValueAtTime(.001,t+.045);oscillator.connect(gain).connect(c.destination);oscillator.start(t);oscillator.stop(t+.05);oscillator.onended=()=>{oscillator.disconnect();gain.disconnect();};}};
    schedule();timer.current=setInterval(schedule,25);
    const draw=()=>{if(!active.current)return;const elapsed=audibleTime()-startAt.current-offsetRef.current/1000,phase=((elapsed%.6)+.6)%.6/.6;
      if(ring.current)ring.current.style.transform=`scale(${1.8-1.2*phase})`;
      if(dot.current)dot.current.style.opacity=phase<.13?'1':'.3';frame.current=requestAnimationFrame(draw);};frame.current=requestAnimationFrame(draw);
  }catch(error){reportDiagnostic(error,{operation:'calibration.audio_start',reason:'calibration_audio_unavailable'});setError('Audio could not start. Try again after checking the output.');stop();}}
  function tap(event:PointerEvent<HTMLButtonElement>){if(!active.current)return;const stamp=event.timeStamp>1e12?event.timeStamp-performance.timeOrigin:event.timeStamp,elapsed=audibleTime(stamp)-startAt.current;if(elapsed<.6)return;
    const errorMs=(elapsed-Math.round(elapsed/.6)*.6)*1000;if(Math.abs(errorMs)>250)return;offsets.current.push(errorMs);offsets.current=offsets.current.slice(-12);setTapCount(offsets.current.length);
    if(offsets.current.length>=4){const sorted=[...offsets.current].sort((a,b)=>a-b);setOffset(Math.round(sorted[Math.floor(sorted.length/2)]/5)*5);}}
  return <section className="calibration-screen" aria-labelledby="calibration-title">
    <header className="detail-bar"><button className="icon-button" onClick={onBack} aria-label="Back"><ArrowLeft/></button><span>Calibration</span><span/></header>
    <div className="page-heading"><p className="eyebrow">Audio timing</p><h1 id="calibration-title">Put the beat under your thumbs.</h1><p>Start the pulse, then tap to the sound. Four steady taps suggest a timing offset; keep tapping to refine it.</p></div>
    <div className="calibration-stage"><div className="calibration-pulse"><div className="calibration-ring" ref={ring}/><span ref={dot}/></div><button className="secondary-button" onClick={()=>void toggle()}>{running?'Stop pulse':'Start pulse'}</button>{running&&<button className="primary-button" onPointerDown={tap}>Tap to the sound · {tapCount}/12</button>}</div>
    {error&&<p role="alert">{error}</p>}
    <div className="offset-control"><button onClick={()=>setOffset(v=>Math.max(-250,v-5))} aria-label="Decrease offset by 5 milliseconds"><Minus/></button><div><strong>{offset>0?'+':''}{offset}</strong><span>milliseconds</span></div><button onClick={()=>setOffset(v=>Math.min(250,v+5))} aria-label="Increase offset by 5 milliseconds"><Plus/></button></div>
    <p className="calibration-hint">{offset===0?'No audio alignment correction applied.':offset>0?'Tiles will follow the audio slightly later.':'Tiles will follow the audio slightly earlier.'} You can still tap anywhere on a visible tile.</p>
    <div className="calibration-actions"><button className="text-button" onClick={()=>setOffset(0)}><RotateCcw/> Reset</button><button className="primary-button" onClick={()=>onSave(offset)}>Save calibration</button></div>
  </section>;
}
