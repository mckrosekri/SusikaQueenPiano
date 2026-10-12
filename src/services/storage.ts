import { DEFAULT_SETTINGS, type BeatAnalysis, type Progress, type Song } from '../types';
import { OperationError, reportDiagnostic } from './diagnostics';
import { compactRankedResults } from './progression';

const KEY='afterbeat.progress.v1';
const defaultProgress=():Progress=>({version:1,results:[],favorites:[],lastPlayed:{},settings:{...DEFAULT_SETTINGS},tutorialComplete:false});
export function loadProgress():Progress {
  try {
    const raw=JSON.parse(localStorage.getItem(KEY) ?? 'null');
    if (!raw || raw.version!==1) return defaultProgress();
    return {...defaultProgress(),...raw,results:Array.isArray(raw.results)?raw.results:[],rankedRecords:Array.isArray(raw.rankedRecords)?raw.rankedRecords:[],favorites:Array.isArray(raw.favorites)?raw.favorites:[],settings:{...DEFAULT_SETTINGS,...raw.settings}};
  } catch(error) {reportDiagnostic(error,{operation:'progress.load',fallback:'default_progress'});return defaultProgress();}
}
export function saveProgress(progress:Progress):void {
  try {localStorage.setItem(KEY,JSON.stringify({...progress,rankedRecords:compactRankedResults([...(progress.rankedRecords ?? []),...progress.results]),results:progress.results.slice(-200)}));}
  catch(error) {reportDiagnostic(error,{operation:'progress.save'});window.dispatchEvent(new CustomEvent('afterbeat:storage-warning',{detail:'Your progress could not be saved. Free some device storage and try again.'}));}
}
let dbPromise:Promise<IDBDatabase>|undefined;
function openDatabase():Promise<IDBDatabase> {
  if (!dbPromise) dbPromise=new Promise((resolve,reject)=>{
    const request=indexedDB.open('afterbeat-library',1);
    request.onupgradeneeded=()=>{for(const store of ['songs','audio','analysis'])if(!request.result.objectStoreNames.contains(store))request.result.createObjectStore(store);};
    request.onsuccess=()=>{request.result.onversionchange=()=>{request.result.close();dbPromise=undefined;};resolve(request.result);};
    request.onerror=()=>{dbPromise=undefined;reject(request.error);};
    request.onblocked=()=>{dbPromise=undefined;reject(new OperationError('storage_database_blocked','library.open'));};
  });
  return dbPromise;
}
async function readValue<T>(store:string,key:IDBValidKey):Promise<T|undefined> {
  const db=await openDatabase();return new Promise((resolve,reject)=>{
    const tx=db.transaction(store,'readonly');const request=tx.objectStore(store).get(key);
    request.onsuccess=()=>resolve(request.result);request.onerror=()=>reject(request.error);
  });
}
export async function listImportedSongs():Promise<Song[]> {
  try {const db=await openDatabase();return await new Promise((resolve,reject)=>{const r=db.transaction('songs','readonly').objectStore('songs').getAll();r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error);});}
  catch(error){reportDiagnostic(error,{operation:'library.list'});throw error;}
}
export async function putImportedSong(song:Song,audio:Blob):Promise<void> {
  try {const db=await openDatabase();await new Promise<void>((resolve,reject)=>{
    const tx=db.transaction(['songs','audio'],'readwrite');tx.objectStore('songs').put(song,song.id);tx.objectStore('audio').put(audio,song.id);
    tx.oncomplete=()=>resolve();tx.onerror=()=>reject(tx.error);tx.onabort=()=>reject(tx.error??new OperationError('storage_transaction_aborted','import.persist'));
  });}catch(error){reportDiagnostic(error,{operation:'import.persist'});throw error;}
}
export async function updateImportedSong(song:Song):Promise<void> {
  try{const db=await openDatabase();await new Promise<void>((resolve,reject)=>{const tx=db.transaction('songs','readwrite');tx.objectStore('songs').put(song,song.id);tx.oncomplete=()=>resolve();tx.onerror=()=>reject(tx.error);tx.onabort=()=>reject(tx.error);});}
  catch(error){reportDiagnostic(error,{operation:'library.update'});throw error;}
}
const urls=new Map<string,string>();
export async function loadSongUrl(song:Song):Promise<string> {
  if(song.source!=='import' && song.audioUrl)return song.audioUrl;
  if(urls.has(song.id))return urls.get(song.id)!;
  try {const blob=await readValue<Blob>('audio',song.id);if(!blob)throw new OperationError('audio_asset_missing','audio.load');
    const url=URL.createObjectURL(blob);urls.set(song.id,url);
    if(urls.size>2){const oldest=urls.keys().next().value!;URL.revokeObjectURL(urls.get(oldest)!);urls.delete(oldest);}
    return url;
  }catch(error){reportDiagnostic(error,{operation:'audio.load'});throw error;}
}
export async function loadSongBytes(song:Song,signal?:AbortSignal):Promise<ArrayBuffer> {
  const url=await loadSongUrl(song);
  let httpStatus:number|undefined;
  try{const response=await fetch(url,{signal});httpStatus=response.status;if(!response.ok)throw new OperationError('audio_fetch_failed','audio.fetch');return await response.arrayBuffer();}
  catch(error){reportDiagnostic(error,{operation:'audio.fetch',retryable:true,httpStatus});throw error;}
}
export async function deleteImportedSong(id:string):Promise<void> {
  try{const db=await openDatabase();await new Promise<void>((resolve,reject)=>{const tx=db.transaction(['songs','audio','analysis'],'readwrite');for(const name of ['songs','audio','analysis'])tx.objectStore(name).delete(id);tx.oncomplete=()=>resolve();tx.onerror=()=>reject(tx.error);tx.onabort=()=>reject(tx.error);});
    if(urls.has(id)){URL.revokeObjectURL(urls.get(id)!);urls.delete(id);}
  }catch(error){reportDiagnostic(error,{operation:'library.delete'});throw error;}
}
export async function getCachedAnalysis(key:string):Promise<BeatAnalysis|undefined> {return readValue<BeatAnalysis>('analysis',key);}
export async function cacheAnalysis(key:string,value:BeatAnalysis):Promise<void> {
  try{const db=await openDatabase();await new Promise<void>((resolve,reject)=>{const tx=db.transaction('analysis','readwrite');tx.objectStore('analysis').put(value,key);tx.oncomplete=()=>resolve();tx.onerror=()=>reject(tx.error);tx.onabort=()=>reject(tx.error);});}
  catch(error){reportDiagnostic(error,{operation:'analysis.cache',fallback:'memory_only',analyzerVersion:value.version});}
}
