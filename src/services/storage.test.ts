import {afterEach,expect,it,vi} from 'vitest';
import {loadSongBytes,loadSongUrl,updateImportedSong,loadProgress,saveProgress} from './storage';
import {DEFAULT_SETTINGS, type Song, type RunResult} from '../types';
const song:Song={id:'private-id',title:'private title',artist:'private artist',genre:'Test',source:'demo',audioUrl:'/audio/private.mp3',durationMs:10000,bpm:120,color:''};
afterEach(()=>{vi.restoreAllMocks();vi.unstubAllGlobals();});
it('resolves packaged songs directly without requiring imported audio storage',async()=>{
  expect(await loadSongUrl({...song,source:'bundled'})).toBe('/audio/private.mp3');
});
it('retains the failed audio HTTP status without retaining its path or response',async()=>{
  const warn=vi.spyOn(console,'warn').mockImplementation(()=>{});vi.stubGlobal('fetch',vi.fn(async()=>new Response('secret body',{status:503})));
  await expect(loadSongBytes(song)).rejects.toMatchObject({reason:'audio_fetch_failed'});
  expect(warn.mock.calls[0][1]).toMatchObject({httpStatus:503,reason:'audio_fetch_failed',exceptionClass:'OperationError',retryable:true});expect(JSON.stringify(warn.mock.calls)).not.toMatch(/private|secret/);
});
it('keeps database failure details observable when saving a beat correction',async()=>{
  const warn=vi.spyOn(console,'warn').mockImplementation(()=>{});vi.stubGlobal('indexedDB',{open(){throw new DOMException('private filename','QuotaExceededError');}});
  await expect(updateImportedSong(song)).rejects.toMatchObject({name:'QuotaExceededError'});
  expect(warn.mock.calls[0][1]).toMatchObject({reason:'storage_quota_exceeded',exceptionClass:'QuotaExceededError',operation:'library.update'});expect(JSON.stringify(warn.mock.calls)).not.toMatch(/private/);
});
it('recovers malformed progress while preserving the safe parse cause',()=>{
  const warn=vi.spyOn(console,'warn').mockImplementation(()=>{});vi.stubGlobal('localStorage',{getItem:()=>'{secret malformed'});
  expect(loadProgress().results).toEqual([]);expect(warn.mock.calls[0][1]).toMatchObject({exceptionClass:'SyntaxError',reason:'stored_data_invalid',fallback:'default_progress'});expect(JSON.stringify(warn.mock.calls)).not.toMatch(/secret/);
});
it('persists star records beyond the recent 200 runs and reloads them',()=>{
  const values=new Map<string,string>();
  vi.stubGlobal('localStorage',{getItem:(key:string)=>values.get(key)??null,setItem:(key:string,value:string)=>values.set(key,value)});
  const clear:RunResult={id:'earned',songId:'first',chartId:'first-chart',difficulty:'easy',rate:1,score:500000,accuracy:50,maxCombo:1,counts:{perfect:1,great:0,good:0,miss:1},early:0,late:0,practice:false,completed:true,createdAt:1};
  const results=[clear,...Array.from({length:201},(_,index)=>({...clear,id:`recent-${index}`,songId:'other',createdAt:index+2,practice:true}))];
  saveProgress({version:1,results,favorites:[],lastPlayed:{},settings:DEFAULT_SETTINGS,tutorialComplete:true});
  const reloaded=loadProgress();
  expect(reloaded.results).toHaveLength(200);expect(reloaded.rankedRecords).toEqual([clear]);
});
it('reports a privacy-safe storage failure if saving the ranked archive runs out of space',()=>{
  const warn=vi.spyOn(console,'warn').mockImplementation(()=>{});const dispatchEvent=vi.fn();
  vi.stubGlobal('localStorage',{getItem:()=>null,setItem:()=>{throw new DOMException('private-song-title secret','QuotaExceededError');}});
  vi.stubGlobal('window',{dispatchEvent});vi.stubGlobal('CustomEvent',class{constructor(public type:string,public detail:unknown){}});
  expect(()=>saveProgress({version:1,results:[],favorites:[],lastPlayed:{},settings:DEFAULT_SETTINGS,tutorialComplete:false})).not.toThrow();
  expect(warn.mock.calls[0][1]).toMatchObject({reason:'storage_quota_exceeded',exceptionClass:'QuotaExceededError',operation:'progress.save'});expect(JSON.stringify(warn.mock.calls)).not.toMatch(/private-song-title|secret/);expect(dispatchEvent).toHaveBeenCalledOnce();
});
