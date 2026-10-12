import processorUrl from '@soundtouchjs/audio-worklet/processor?url';
import type { SoundTouchNode } from '@soundtouchjs/audio-worklet';
import type { PlaybackRate, Song } from '../types';
import { loadSongBytes } from '../services/storage';
import { OperationError, reportDiagnostic } from '../services/diagnostics';

const delayCache=new Map<string,number>();
const stretch={sequenceMs:40,seekWindowMs:15,overlapMs:8,quickSeek:true};
const calibrationMarks=[1,4,7,10];
const calibrationBurstSeconds=0.12;
const processorWarmupSeconds=2.5;
export interface TransportMetrics { sourceTimeMs:number; rate:number; dspDelayMs:number; underruns:number; contextState:AudioContextState }
function addCalibrationBurst(data:Float32Array,start:number,length:number,seed:number){
  for(let i=0;i<length&&start+i<data.length;i++){
    const edge=Math.min(1,i/24,(length-1-i)/24);
    const noise=Math.sin((i+1)*12.9898+seed*78.233);
    data[start+i]+=0.72*noise*Math.max(0,edge);
  }
}
function findCalibrationOnset(data:Float32Array,expected:number,sampleRate:number):number|undefined{
  const from=Math.max(0,Math.floor((expected-0.025)*sampleRate));
  const to=Math.min(data.length,Math.ceil((expected+0.3)*sampleRate));
  for(let i=from;i<to;i++)if(Math.abs(data[i])>=0.075)return i/sampleRate;
  return undefined;
}
export async function measureDspDelay(rate:PlaybackRate,sampleRate:number):Promise<number> {
  if(rate===1)return 0;const key=`${rate}-${sampleRate}`;if(delayCache.has(key))return delayCache.get(key)!;
  const {SoundTouchNode}=await import('@soundtouchjs/audio-worklet');
  const sourceDuration=11.5;const context=new OfflineAudioContext(2,Math.ceil(sampleRate*(processorWarmupSeconds+sourceDuration/rate+0.35)),sampleRate);
  await SoundTouchNode.register(context,processorUrl);
  const buffer=context.createBuffer(2,Math.ceil(sampleRate*sourceDuration),sampleRate);
  for(const channel of [0,1]){const data=buffer.getChannelData(channel);for(let i=0;i<data.length;i++)data[i]=0.025*Math.sin(2*Math.PI*440*i/sampleRate);calibrationMarks.forEach((time,index)=>addCalibrationBurst(data,Math.round(time*sampleRate),Math.round(sampleRate*calibrationBurstSeconds),index+1));}
  const node=new SoundTouchNode({context});node.playbackRate.value=rate;node.pitch.value=1;node.setStretchParameters(stretch);node.connect(context.destination);
  const source=context.createBufferSource();source.buffer=buffer;source.playbackRate.value=rate;source.connect(node);source.start(processorWarmupSeconds);
  const rendered=await context.startRendering();const data=rendered.getChannelData(0);const deltas:number[]=[];
  for(const time of calibrationMarks){const expected=processorWarmupSeconds+time/rate;const onset=findCalibrationOnset(data,expected,sampleRate);if(onset===undefined)throw new OperationError('audio_processor_silent','audio.calibrate');deltas.push(onset-expected);}
  deltas.sort((a,b)=>a-b);const middle=deltas.length/2;const delay=(deltas[middle-1]+deltas[middle])/2;delayCache.set(key,delay);return delay;
}
export class AudioTransport {
  readonly context=new AudioContext({latencyHint:'interactive'});
  private buffer?:AudioBuffer;private source?:AudioBufferSourceNode;private processor?:SoundTouchNode;
  private musicGain=this.context.createGain();private nodeRegistered=false;
  private scheduledStart=0;private offsetMs=0;private stoppedAt=0;
  private rate:PlaybackRate=1;private delay=0;private playing=false;private baseUnderruns=0;
  private bytes?:ArrayBuffer;
  async prepare(song:Song,rate:PlaybackRate,volume:number,signal?:AbortSignal){
    try{this.rate=rate;this.musicGain.gain.value=volume;this.musicGain.connect(this.context.destination);
      await this.context.resume();this.bytes=await loadSongBytes(song,signal);
      this.buffer=await this.context.decodeAudioData(this.bytes);this.bytes=undefined;
      if(signal?.aborted)throw new DOMException('Cancelled','AbortError');
      if(rate!==1){const {SoundTouchNode}=await import('@soundtouchjs/audio-worklet');await SoundTouchNode.register(this.context,processorUrl);this.nodeRegistered=true;this.delay=await measureDspDelay(rate,this.context.sampleRate);}
    }catch(error){reportDiagnostic(error,{operation:'playback.prepare',reason:error instanceof OperationError?error.reason:undefined});throw error;}
  }
  async start(offsetMs=0,leadSeconds=2.5){
    if(!this.buffer)throw new OperationError('audio_not_prepared','playback.start');
    await this.context.resume();this.stopSource();this.offsetMs=Math.max(0,offsetMs);this.stoppedAt=this.offsetMs;
    const source=this.context.createBufferSource();source.buffer=this.buffer;source.playbackRate.value=this.rate;
    if(this.rate!==1 && this.nodeRegistered){const {SoundTouchNode}=await import('@soundtouchjs/audio-worklet');this.processor=new SoundTouchNode({context:this.context});this.processor.playbackRate.value=this.rate;this.processor.pitch.value=1;this.processor.setStretchParameters(stretch);source.connect(this.processor);this.processor.connect(this.musicGain);const processor=this.processor;processor.addEventListener('metrics',()=>{if(this.processor===processor&&this.sourceTimeAt()<=this.offsetMs)this.baseUnderruns=processor.metrics?.underrunCount??0;});}
    else source.connect(this.musicGain);
    this.scheduledStart=this.context.currentTime+leadSeconds;this.playing=true;this.source=source;this.baseUnderruns=0;
    source.start(this.scheduledStart,this.offsetMs/1000);
  }
  sourceTimeAt(performanceTime=performance.now()):number {
    if(!this.playing)return this.stoppedAt;
    let audioTime=this.context.currentTime;
    const stamp=this.context.getOutputTimestamp?.();
    const contextStamp=stamp?.contextTime??0;const performanceStamp=stamp?.performanceTime??0;
    if(contextStamp>0 && performanceStamp>0)audioTime=contextStamp+(performanceTime-performanceStamp)/1000;
    else audioTime+=((performanceTime-performance.now())/1000)-(this.context.outputLatency??this.context.baseLatency??0);
    return this.offsetMs+(audioTime-this.scheduledStart-this.delay)*this.rate*1000;
  }
  pause(){this.stoppedAt=Math.max(this.offsetMs,this.sourceTimeAt());this.playing=false;this.stopSource();}
  feedback(lane:number,volume:number){
    if(!volume||this.context.state!=='running')return;
    const oscillator=this.context.createOscillator();const gain=this.context.createGain();oscillator.type='sine';oscillator.frequency.value=460+lane*110;
    const t=this.context.currentTime;gain.gain.setValueAtTime(volume*0.035,t);gain.gain.exponentialRampToValueAtTime(0.001,t+0.025);oscillator.connect(gain);gain.connect(this.context.destination);oscillator.start(t);oscillator.stop(t+0.03);oscillator.onended=()=>{oscillator.disconnect();gain.disconnect();};
  }
  metrics():TransportMetrics {
    const count=this.processor?.metrics?.underrunCount??0;
    return {sourceTimeMs:this.sourceTimeAt(),rate:this.rate,dspDelayMs:this.delay*1000,underruns:Math.max(0,count-this.baseUnderruns),contextState:this.context.state};
  }
  private stopSource(){try{this.source?.stop();}catch{}this.source?.disconnect();this.source=undefined;this.processor?.disconnect();this.processor=undefined;}
  async dispose(){this.playing=false;this.stopSource();this.musicGain.disconnect();this.buffer=undefined;this.bytes=undefined;await this.context.close().catch(error=>reportDiagnostic(error,{operation:'audio.dispose',fallback:'context_disposed'}));}
}
