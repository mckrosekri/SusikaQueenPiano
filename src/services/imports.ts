import type { BeatAnalysis, Song } from '../types';
import { analyzeAudioBuffer } from '../rhythm/analysis-client';
import { ANALYSIS_VERSION } from '../rhythm/analysis';
import { generateCharts } from '../rhythm/chart';
import { cacheAnalysis, getCachedAnalysis, listImportedSongs, loadSongBytes, putImportedSong, updateImportedSong } from './storage';
import { OperationError, reportDiagnostic } from './diagnostics';
export interface ScanOptions {signal?:AbortSignal;onProgress?:(progress:number)=>void}
const MAX_BYTES=40*1024*1024;const MAX_DURATION=360;
function checkCancelled(signal?:AbortSignal){if(signal?.aborted)throw new DOMException('Cancelled','AbortError');}
async function hashAudio(bytes:ArrayBuffer):Promise<string>{const hash=await crypto.subtle.digest('SHA-256',bytes);return Array.from(new Uint8Array(hash)).map(x=>x.toString(16).padStart(2,'0')).join('');}
async function decode(bytes:ArrayBuffer):Promise<AudioBuffer>{
  const context=new AudioContext();try{return await context.decodeAudioData(bytes.slice(0));}
  catch(error){reportDiagnostic(error,{operation:'audio.decode',reason:'audio_decode_failed'});throw new OperationError('audio_decode_failed','audio.decode',{cause:error});}
  finally{await context.close().catch(error=>reportDiagnostic(error,{operation:'audio.context_close',fallback:'context_disposed'}));}
}
export async function importSong(file:File,options:ScanOptions={}):Promise<Song>{
  const correlationId=crypto.randomUUID();const started=performance.now();
  try{
    if(file.size>MAX_BYTES)throw new OperationError('audio_file_too_large','import.validate');
    if(!file.size)throw new OperationError('audio_file_empty','import.validate');
    if(!/\.(mp3|m4a|aac|wav)$/i.test(file.name))throw new OperationError('audio_codec_unsupported','import.validate');
    checkCancelled(options.signal);options.onProgress?.(0.03);
    const bytes=await file.arrayBuffer();const hash=await hashAudio(bytes);checkCancelled(options.signal);
    const existing=(await listImportedSongs()).find(song=>song.id===`local-${hash}`);if(existing){const analysis=await getSongAnalysis(existing,options);return {...existing,bpm:analysis.bpm,analysis,charts:generateCharts(analysis)};}
    const buffer=await decode(bytes);if(buffer.duration>MAX_DURATION)throw new OperationError('audio_duration_too_long','import.validate');
    if(buffer.duration<3)throw new OperationError('audio_duration_too_short','import.validate');
    checkCancelled(options.signal);options.onProgress?.(0.1);
    const analysis=await analyzeAudioBuffer(buffer,hash,{signal:options.signal,onProgress:p=>options.onProgress?.(0.1+p*0.8)});
    checkCancelled(options.signal);
    const song:Song={id:`local-${hash}`,title:file.name.replace(/\.[^.]+$/,'').slice(0,100),artist:'Your music',genre:'Imported',durationMs:analysis.durationMs,bpm:analysis.bpm,color:'oklch(0.72 0.13 210)',source:'import',analysis,charts:generateCharts(analysis),addedAt:Date.now()};
    await putImportedSong(song,file);options.onProgress?.(1);return song;
  }catch(error){reportDiagnostic(error,{operation:'music.import',correlationId,durationMs:performance.now()-started});throw error;}
}
const memoryAnalysis=new Map<string,BeatAnalysis>();
export function isCurrentAnalysis(analysis:BeatAnalysis|undefined):analysis is BeatAnalysis {
  return Boolean(analysis && (analysis.version===ANALYSIS_VERSION || analysis.version.startsWith(`${ANALYSIS_VERSION}-`)) && Array.isArray(analysis.onsets) && Array.isArray(analysis.sustains) && Array.isArray(analysis.activity));
}
function preserveAlignment(analysis:BeatAnalysis,old:BeatAnalysis|undefined):BeatAnalysis {
  if(!old?.warnings.includes('manually_aligned'))return analysis;
  const bpm=old.bpm;const start=old.beatsMs[0];
  if(!Number.isFinite(bpm)||bpm<40||bpm>240||!Number.isFinite(start)||start<0||start>=analysis.durationMs)return analysis;
  const beatsMs:number[]=[];for(let time=start;time<analysis.durationMs;time+=60000/bpm)beatsMs.push(Math.round(time));
  return {...analysis,bpm,beatsMs,confidence:1,warnings:['manually_aligned'],version:`${ANALYSIS_VERSION}-manual-${bpm}-${Math.round(start)}`};
}
export async function getSongAnalysis(song:Song,options:ScanOptions={}):Promise<BeatAnalysis>{
  checkCancelled(options.signal);
  const remembered=memoryAnalysis.get(song.id);
  const matchesAudio=(analysis:BeatAnalysis|undefined)=>!song.audioHash||analysis?.audioHash===song.audioHash;
  if(isCurrentAnalysis(remembered)&&matchesAudio(remembered))return remembered;
  if(isCurrentAnalysis(song.analysis)&&matchesAudio(song.analysis)){memoryAnalysis.set(song.id,song.analysis);return song.analysis;}
  const cached=await getCachedAnalysis(song.id).catch(error=>{reportDiagnostic(error,{operation:'analysis.cache_read',fallback:'rescan'});return undefined;});
  if(isCurrentAnalysis(cached)&&matchesAudio(cached)){memoryAnalysis.set(song.id,cached);return cached;}
  try{
    if(song.source!=='import'){
      const response=await fetch(`/charts/${song.id}.json`,{signal:options.signal});
      if(response.ok){const bundled=await response.json() as BeatAnalysis;if(isCurrentAnalysis(bundled)&&matchesAudio(bundled)){memoryAnalysis.set(song.id,bundled);return bundled;}throw new OperationError('analysis_bundle_invalid','analysis.bundle_load');}
      reportDiagnostic(new OperationError('analysis_bundle_unavailable','analysis.bundle_load'),{operation:'analysis.bundle_load',httpStatus:response.status,fallback:'local_scan'});
    }
  }catch(error){if(options.signal?.aborted)throw error;reportDiagnostic(error,{operation:'analysis.bundle_load',reason:error instanceof OperationError?error.reason:'analysis_bundle_read_failed',fallback:'local_scan'});}
  const bytes=await loadSongBytes(song,options.signal);const hash=await hashAudio(bytes);checkCancelled(options.signal);
  const buffer=await decode(bytes);const measured=await analyzeAudioBuffer(buffer,hash,options);checkCancelled(options.signal);
  const analysis=preserveAlignment(measured,song.analysis??cached);
  memoryAnalysis.set(song.id,analysis);await cacheAnalysis(song.id,analysis);
  if(song.source==='import'){
    const upgraded:Song={...song,bpm:analysis.bpm,durationMs:analysis.durationMs,analysis,charts:generateCharts(analysis)};
    await updateImportedSong(upgraded).catch(error=>reportDiagnostic(error,{operation:'analysis.upgrade_persist',analyzerVersion:ANALYSIS_VERSION,fallback:'memory_only'}));
  }
  return analysis;
}
export async function repairSongAnalysis(song:Song,bpm:number,firstBeatMs:number):Promise<Song>{
  if(!Number.isFinite(bpm)||bpm<40||bpm>240||!Number.isFinite(firstBeatMs)||firstBeatMs<0||firstBeatMs>=song.durationMs)throw new OperationError('rhythm_adjustment_invalid','analysis.repair');
  const existing=await getSongAnalysis(song);const step=60000/bpm;const beats:number[]=[];
  for(let time=firstBeatMs;time<existing.durationMs;time+=step)beats.push(Math.round(time));
  const analysis:BeatAnalysis={...existing,bpm,beatsMs:beats,confidence:1,warnings:['manually_aligned'],audioHash:existing.audioHash,version:`${existing.version}-manual-${bpm}-${Math.round(firstBeatMs)}`};
  const repaired:Song={...song,bpm,analysis,charts:generateCharts(analysis)};
  memoryAnalysis.set(song.id,analysis);await cacheAnalysis(song.id,analysis);if(song.source==='import')await updateImportedSong(repaired);
  return repaired;
}
