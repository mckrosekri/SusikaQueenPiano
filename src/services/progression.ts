import {DIFFICULTIES} from '../types';
import type {Difficulty,NoteSkin,PlaybackRate,RunResult} from '../types';

export function starsForResult(result:RunResult):number{
  if(!result.completed||result.practice||!Number.isFinite(result.accuracy))return 0;
  if(result.accuracy>=90)return 3;
  if(result.accuracy>=75)return 2;
  if(result.accuracy>=50)return 1;
  return 0;
}

export function bestStars(results:RunResult[],songId:string,difficulty:Difficulty):number{
  return results.reduce((best,result)=>{
    if(result.songId!==songId||result.difficulty!==difficulty)return best;
    return Math.max(best,starsForResult(result));
  },0);
}

export function nextDifficulty(difficulty:Difficulty):Difficulty|null{
  const index=DIFFICULTIES.indexOf(difficulty);
  return index>=0&&index<DIFFICULTIES.length-1?DIFFICULTIES[index+1]:null;
}

export function isDifficultyUnlocked(results:RunResult[],songId:string,difficulty:Difficulty):boolean{
  const index=DIFFICULTIES.indexOf(difficulty);
  if(index<=0)return difficulty==='easy';

  if(bestStars(results,songId,DIFFICULTIES[index-1])>=1)return true;

  return DIFFICULTIES.slice(index).some(tier=>bestStars(results,songId,tier)>=1);
}

export function recommendedDifficulty(results:RunResult[],songId:string):Difficulty{
  return DIFFICULTIES.find(difficulty=>
    isDifficultyUnlocked(results,songId,difficulty)&&bestStars(results,songId,difficulty)<1
  )??'expert';
}

function rankedNumber(value:number):number{
  return Number.isFinite(value)?value:Number.NEGATIVE_INFINITY;
}

function dedupeResults(results:RunResult[]):RunResult[]{
  const unique=new Map<string,RunResult>();
  for(const result of results)unique.set(result.id,result);
  return [...unique.values()];
}

function compareRanked(left:RunResult,right:RunResult):number{
  return rankedNumber(right.score)-rankedNumber(left.score)||
    rankedNumber(right.accuracy)-rankedNumber(left.accuracy)||
    rankedNumber(right.maxCombo)-rankedNumber(left.maxCombo)||
    rankedNumber(left.createdAt)-rankedNumber(right.createdAt)||
    (left.id<right.id?-1:left.id>right.id?1:0);
}

export function leaderboardFor(
  results:RunResult[],
  songId:string,
  difficulty:Difficulty,
  rate:PlaybackRate,
  chartId?:string,
):RunResult[]{
  return dedupeResults(results)
    .filter(result=>
      result.completed&&
      !result.practice&&
      result.songId===songId&&
      result.difficulty===difficulty&&
      result.rate===rate&&
      (chartId===undefined||result.chartId===chartId)
    )
    .sort(compareRanked)
    .slice(0,5);
}

export function compactRankedResults(results:RunResult[]):RunResult[]{
  const ranked=dedupeResults(results).filter(result=>result.completed&&!result.practice);
  const buckets=new Map<string,RunResult[]>();
  for(const result of ranked){
    const key=JSON.stringify([result.songId,result.difficulty,result.rate]);
    const bucket=buckets.get(key);
    if(bucket)bucket.push(result);
    else buckets.set(key,[result]);
  }

  const retained=new Map<string,RunResult>();
  for(const bucket of buckets.values()){
    const latest=[...bucket].sort((left,right)=>
      rankedNumber(right.createdAt)-rankedNumber(left.createdAt)||
      (left.id<right.id?-1:left.id>right.id?1:0)
    )[0];
    for(const result of bucket.filter(candidate=>candidate.chartId===latest.chartId).sort(compareRanked).slice(0,5)){
      retained.set(result.id,result);
    }
  }

  const starBuckets=new Map<string,RunResult[]>();
  for(const result of ranked){
    if(starsForResult(result)<1)continue;
    const key=JSON.stringify([result.songId,result.difficulty]);
    const bucket=starBuckets.get(key);
    if(bucket)bucket.push(result);
    else starBuckets.set(key,[result]);
  }
  for(const bucket of starBuckets.values()){
    const exemplar=[...bucket].sort((left,right)=>
      starsForResult(right)-starsForResult(left)||
      rankedNumber(right.accuracy)-rankedNumber(left.accuracy)||
      compareRanked(left,right)
    )[0];
    retained.set(exemplar.id,exemplar);
  }

  return [...retained.values()];
}

export function unlockedSkins(results:RunResult[]):NoteSkin[]{
  const ranked=results.filter(r=>r.completed&&!r.practice);
  const skins:NoteSkin[]=['ivory'];
  if(ranked.some(r=>r.difficulty==='hard'&&r.accuracy>=88))skins.push('crimson');
  if(ranked.some(r=>r.difficulty==='expert'&&r.accuracy>=90))skins.push('silver');
  return skins;
}
