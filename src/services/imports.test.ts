import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {importSong,getSongAnalysis,isCurrentAnalysis} from './imports';
import {analyzeAudioBuffer} from '../rhythm/analysis-client';
import {getCachedAnalysis,loadSongBytes,updateImportedSong} from './storage';
import type {BeatAnalysis,Song} from '../types';
import {OperationError} from './diagnostics';
vi.mock('./storage',()=>({getCachedAnalysis:vi.fn(async()=>undefined),loadSongBytes:vi.fn(async()=>{throw new OperationError('audio_asset_missing','audio.load');}),listImportedSongs:vi.fn(async()=>[]),putImportedSong:vi.fn(),updateImportedSong:vi.fn(),cacheAnalysis:vi.fn()}));
vi.mock('../rhythm/analysis-client',()=>({analyzeAudioBuffer:vi.fn()}));
beforeEach(()=>{vi.clearAllMocks();vi.mocked(getCachedAnalysis).mockResolvedValue(undefined);vi.mocked(loadSongBytes).mockRejectedValue(new OperationError('audio_asset_missing','audio.load'));vi.mocked(updateImportedSong).mockResolvedValue(undefined);});
afterEach(()=>{vi.restoreAllMocks();vi.unstubAllGlobals();});
it.each([
  {file:new File([],'secret.wav'),reason:'audio_file_empty'},
  {file:new File(['private bytes'],'secret.exe'),reason:'audio_codec_unsupported'},
])('rejects invalid local media with a specific safe diagnostic',async({file,reason})=>{
  const warn=vi.spyOn(console,'warn').mockImplementation(()=>{});
  await expect(importSong(file)).rejects.toMatchObject({reason});
  const diagnostic=warn.mock.calls.at(-1)![1];expect(diagnostic).toMatchObject({reason,exceptionClass:'OperationError',operation:'music.import'});
  expect(diagnostic.correlationId).toBeTruthy();expect(JSON.stringify(diagnostic)).not.toMatch(/secret|private bytes/);
});
const fresh:BeatAnalysis={version:'afterbeat-analysis-v2',audioHash:'synthetic',durationMs:5000,bpm:120,beatsMs:[0,500,1000],onsets:[{timeMs:560,strength:0.9}],energy:[0.8],confidence:0.8,warnings:[],intensity:0.5,sustains:[{startMs:560,endMs:1060,confidence:0.9}],activity:[{startMs:500,endMs:1300}]};
function legacySong(id:string):Song{return {id,title:'private title',artist:'private artist',genre:'Imported',durationMs:5000,bpm:100,color:'',source:'import',analysis:{...fresh,version:'afterbeat-analysis-v1-manual-100-200',sustains:undefined,activity:undefined,bpm:100,beatsMs:[200,800],warnings:['manually_aligned']}};}
function allowScan(){vi.mocked(loadSongBytes).mockResolvedValue(new Uint8Array([1,2,3]).buffer);vi.mocked(analyzeAudioBuffer).mockResolvedValue(fresh);vi.stubGlobal('AudioContext',class {decodeAudioData(){return Promise.resolve({duration:5});}close(){return Promise.resolve();}});}
it('rescans legacy audio and preserves manual tempo while replacing invented holds',async()=>{
  allowScan();const song=legacySong('upgrade-test');const result=await getSongAnalysis(song);
  expect(analyzeAudioBuffer).toHaveBeenCalledOnce();expect(result.version).toBe('afterbeat-analysis-v2-manual-100-200');
  expect(result.beatsMs.slice(0,3)).toEqual([200,800,1400]);expect(result.sustains).toEqual(fresh.sustains);expect(result.activity).toEqual(fresh.activity);
  expect(updateImportedSong).toHaveBeenCalledWith(expect.objectContaining({id:song.id,analysis:result,charts:expect.objectContaining({normal:expect.objectContaining({version:'afterbeat-chart-v6'})})}));
  expect(await getSongAnalysis(song)).toBe(result);expect(analyzeAudioBuffer).toHaveBeenCalledOnce();
});
it('ignores a legacy cached analysis instead of returning old pattern data',async()=>{
  allowScan();const song=legacySong('cache-upgrade-test');song.analysis=undefined;vi.mocked(getCachedAnalysis).mockResolvedValue(legacySong('old').analysis);
  const result=await getSongAnalysis(song);expect(isCurrentAnalysis(result)).toBe(true);expect(analyzeAudioBuffer).toHaveBeenCalledOnce();
  expect(isCurrentAnalysis({...fresh,version:'afterbeat-analysis-v20'})).toBe(false);
});
it('keeps a successful upgraded scan playable if persistence fails and reports a safe cause',async()=>{
  allowScan();const warn=vi.spyOn(console,'warn').mockImplementation(()=>{});vi.mocked(updateImportedSong).mockRejectedValue(new DOMException('private db detail','QuotaExceededError'));
  const result=await getSongAnalysis(legacySong('persist-upgrade-test'));expect(isCurrentAnalysis(result)).toBe(true);
  const diagnostic=warn.mock.calls.find(call=>call[1]?.operation==='analysis.upgrade_persist')![1];
  expect(diagnostic).toMatchObject({exceptionClass:'QuotaExceededError',fallback:'memory_only',analyzerVersion:'afterbeat-analysis-v2'});expect(diagnostic.reason).toBeTruthy();
  expect(JSON.stringify(diagnostic)).not.toMatch(/private|persist-upgrade-test/);
});
it('preserves the HTTP status and specific cause when a bundle falls back to a local scan',async()=>{
  const warn=vi.spyOn(console,'warn').mockImplementation(()=>{});
  vi.stubGlobal('fetch',vi.fn(async()=>new Response('private source body',{status:404})));
  await expect(getSongAnalysis({id:'missing-demo-test',title:'private title',artist:'private artist',genre:'Test',durationMs:5000,bpm:120,color:'',source:'demo'})).rejects.toMatchObject({reason:'audio_asset_missing'});
  const diagnostic=warn.mock.calls.find(call=>call[1]?.operation==='analysis.bundle_load')![1];
  expect(diagnostic).toMatchObject({reason:'analysis_bundle_unavailable',exceptionClass:'OperationError',httpStatus:404,fallback:'local_scan'});
  expect(JSON.stringify(diagnostic)).not.toMatch(/private|missing-demo-test/);
});
it('loads a fingerprint-matched bundled chart without decoding the full song',async()=>{
  vi.stubGlobal('fetch',vi.fn(async()=>new Response(JSON.stringify(fresh),{status:200})));
  const result=await getSongAnalysis({id:'bundled-fingerprint-match',title:'private title',artist:'private artist',genre:'Test',durationMs:5000,bpm:120,color:'',source:'bundled',audioHash:'synthetic',audioUrl:'/audio/private.mp3'});
  expect(result).toEqual(fresh);expect(loadSongBytes).not.toHaveBeenCalled();expect(analyzeAudioBuffer).not.toHaveBeenCalled();
});
it('rejects a stale bundled fingerprint and safely falls back to scanning the current audio',async()=>{
  allowScan();const warn=vi.spyOn(console,'warn').mockImplementation(()=>{});
  vi.stubGlobal('fetch',vi.fn(async()=>new Response(JSON.stringify({...fresh,audioHash:'stale-private-hash'}),{status:200})));
  const result=await getSongAnalysis({id:'bundled-stale-fingerprint',title:'private title',artist:'private artist',genre:'Test',durationMs:5000,bpm:120,color:'',source:'bundled',audioHash:'synthetic',audioUrl:'/audio/private.mp3'});
  expect(isCurrentAnalysis(result)).toBe(true);expect(analyzeAudioBuffer).toHaveBeenCalledOnce();
  const diagnostic=warn.mock.calls.find(call=>call[1]?.operation==='analysis.bundle_load')![1];
  expect(diagnostic).toMatchObject({reason:'analysis_bundle_invalid',exceptionClass:'OperationError',fallback:'local_scan'});
  expect(JSON.stringify(diagnostic)).not.toMatch(/private|stale|fingerprint/);
});
