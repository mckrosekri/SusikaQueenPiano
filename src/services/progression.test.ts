import {describe,expect,it} from 'vitest';
import type {Difficulty,PlaybackRate,RunResult} from '../types';
import {bestStars,compactRankedResults,isDifficultyUnlocked,leaderboardFor,nextDifficulty,recommendedDifficulty,starsForResult,unlockedSkins} from './progression';

const baseRun={id:'a',chartId:'chart',songId:'song',difficulty:'expert',rate:1,score:750000,accuracy:75,maxCombo:20,counts:{perfect:30,great:0,good:0,miss:10},early:0,late:0,practice:false,createdAt:0,completed:true} satisfies RunResult;
function run(overrides:Partial<RunResult>={}):RunResult{
  return {...baseRun,...overrides};
}

it('requires the full percentage threshold and excludes practice and incomplete runs',()=>{
  expect(unlockedSkins([baseRun])).toEqual(['ivory']);
  expect(unlockedSkins([{...baseRun,accuracy:90,practice:true},{...baseRun,accuracy:100,completed:false}])).toEqual(['ivory']);
  expect(unlockedSkins([{...baseRun,accuracy:90},{...baseRun,difficulty:'hard',accuracy:88}])).toEqual(['ivory','crimson','silver']);
});

describe('stars and progression',()=>{
  it('grades only completed non-practice runs at the inclusive accuracy boundaries',()=>{
    expect([49.999,50,74.999,75,89.999,90,100].map(accuracy=>starsForResult(run({accuracy})))).toEqual([0,1,1,2,2,3,3]);
    expect(starsForResult(run({accuracy:100,practice:true}))).toBe(0);
    expect(starsForResult(run({accuracy:100,completed:false}))).toBe(0);
    expect(starsForResult(run({accuracy:Number.NaN}))).toBe(0);
    expect(starsForResult(run({accuracy:Number.POSITIVE_INFINITY}))).toBe(0);
  });

  it('finds the best qualifying stars for only the requested song and tier',()=>{
    const results=[
      run({id:'one',difficulty:'normal',accuracy:50}),
      run({id:'two',difficulty:'normal',accuracy:90}),
      run({id:'other-song',songId:'other',difficulty:'normal',accuracy:100}),
      run({id:'practice',difficulty:'normal',accuracy:100,practice:true}),
      run({id:'incomplete',difficulty:'normal',accuracy:100,completed:false}),
    ];
    expect(bestStars(results,'song','normal')).toBe(3);
    expect(bestStars(results,'song','hard')).toBe(0);
    expect(bestStars(results,'missing','normal')).toBe(0);
  });

  it('unlocks sequential tiers and keeps earned same-or-higher legacy tiers available',()=>{
    expect(isDifficultyUnlocked([],'song','easy')).toBe(true);
    expect(isDifficultyUnlocked([],'song','normal')).toBe(false);
    expect(isDifficultyUnlocked([run({difficulty:'easy',accuracy:50})],'song','normal')).toBe(true);
    expect(isDifficultyUnlocked([run({difficulty:'normal',accuracy:50})],'song','hard')).toBe(true);
    expect(isDifficultyUnlocked([run({difficulty:'hard',accuracy:50})],'song','normal')).toBe(true);
    expect(isDifficultyUnlocked([run({difficulty:'expert',accuracy:50})],'song','hard')).toBe(true);
    expect(isDifficultyUnlocked([run({difficulty:'expert',accuracy:100,practice:true})],'song','expert')).toBe(false);
    expect(isDifficultyUnlocked([run({difficulty:'expert',accuracy:100,completed:false})],'song','expert')).toBe(false);
    expect(isDifficultyUnlocked([run({songId:'other',difficulty:'expert',accuracy:100})],'song','normal')).toBe(false);
  });

  it('returns the next tier and recommends the first unlocked tier without a star',()=>{
    expect((['easy','normal','hard'] as Difficulty[]).map(nextDifficulty)).toEqual(['normal','hard','expert']);
    expect(nextDifficulty('expert')).toBeNull();
    expect(recommendedDifficulty([],'song')).toBe('easy');
    expect(recommendedDifficulty([run({difficulty:'easy',accuracy:50})],'song')).toBe('normal');
    expect(recommendedDifficulty([
      run({difficulty:'easy',accuracy:50}),
      run({difficulty:'normal',accuracy:50}),
    ],'song')).toBe('hard');
    expect(recommendedDifficulty([
      run({difficulty:'easy',accuracy:50}),
      run({difficulty:'normal',accuracy:50}),
      run({difficulty:'hard',accuracy:50}),
      run({difficulty:'expert',accuracy:50}),
    ],'song')).toBe('expert');
  });
});

describe('local leaderboard',()=>{
  it('keeps only matching completed non-practice runs at the exact rate and optional chart',()=>{
    const matching=run({id:'matching',difficulty:'hard',rate:1.25,chartId:'v2'});
    const results=[
      matching,
      run({id:'practice',difficulty:'hard',rate:1.25,chartId:'v2',practice:true}),
      run({id:'incomplete',difficulty:'hard',rate:1.25,chartId:'v2',completed:false}),
      run({id:'other-rate',difficulty:'hard',rate:1,chartId:'v2'}),
      run({id:'other-song',songId:'other',difficulty:'hard',rate:1.25,chartId:'v2'}),
      run({id:'other-tier',difficulty:'normal',rate:1.25,chartId:'v2'}),
      run({id:'other-chart',difficulty:'hard',rate:1.25,chartId:'v1'}),
    ];
    expect(leaderboardFor(results,'song','hard',1.25,'v2')).toEqual([matching]);
    expect(leaderboardFor(results,'song','hard',1.25).map(result=>result.id)).toEqual(['matching','other-chart']);
  });

  it('sorts deterministically by score, accuracy, combo, time, and id without mutating input',()=>{
    const results=[
      run({id:'lower-score',score:899999,accuracy:100,maxCombo:100,createdAt:1}),
      run({id:'lower-accuracy',score:900000,accuracy:89,maxCombo:100,createdAt:1}),
      run({id:'lower-combo',score:900000,accuracy:90,maxCombo:99,createdAt:1}),
      run({id:'later',score:900000,accuracy:90,maxCombo:100,createdAt:2}),
      run({id:'z-id',score:900000,accuracy:90,maxCombo:100,createdAt:1}),
      run({id:'a-id',score:900000,accuracy:90,maxCombo:100,createdAt:1}),
    ];
    const originalOrder=results.map(result=>result.id);
    expect(leaderboardFor(results,'song','expert',1).map(result=>result.id)).toEqual([
      'a-id','z-id','later','lower-combo','lower-accuracy',
    ]);
    expect(results.map(result=>result.id)).toEqual(originalOrder);
  });

  it('deduplicates IDs and returns at most the top five real local runs',()=>{
    const results=Array.from({length:12},(_,index)=>run({id:`run-${index}`,score:index,createdAt:index,rate:0.75 as PlaybackRate}));
    results.push(run({id:'run-11',score:-1,createdAt:20,rate:0.75}));
    expect(leaderboardFor(results,'song','expert',0.75).map(result=>result.id)).toEqual([
      'run-10','run-9','run-8','run-7','run-6',
    ]);
  });
});

describe('compact ranked archive',()=>{
  it('retains an old song board and unlock exemplar beyond two hundred newer runs',()=>{
    const oldBoard=Array.from({length:7},(_,index)=>run({
      id:`old-${index}`,
      chartId:'old-chart',
      difficulty:'easy',
      score:1000-index,
      accuracy:index===6?90:40,
      createdAt:index,
    }));
    const recent=Array.from({length:201},(_,index)=>run({
      id:`recent-${index}`,
      songId:'other-song',
      chartId:'other-chart',
      difficulty:'normal',
      score:index,
      accuracy:40,
      createdAt:100+index,
    }));

    const compact=compactRankedResults([...oldBoard,...recent]);
    expect(leaderboardFor(compact,'song','easy',1,'old-chart').map(result=>result.id)).toEqual([
      'old-0','old-1','old-2','old-3','old-4',
    ]);
    expect(bestStars(compact,'song','easy')).toBe(3);
    expect(isDifficultyUnlocked(compact,'song','normal')).toBe(true);
    expect(compact.some(result=>result.id==='old-6')).toBe(true);
  });

  it('keeps the newest chart board even when its scores are lower and preserves an older grade',()=>{
    const oldGrade=run({id:'old-grade',chartId:'v1',difficulty:'hard',score:900000,accuracy:90,createdAt:1});
    const newLower=run({id:'new-lower',chartId:'v2',difficulty:'hard',score:100,accuracy:40,createdAt:2});
    const compact=compactRankedResults([oldGrade,newLower]);

    expect(leaderboardFor(compact,'song','hard',1,'v2')).toEqual([newLower]);
    expect(bestStars(compact,'song','hard')).toBe(3);
    expect(compact.map(result=>result.id)).toEqual(['new-lower','old-grade']);
  });

  it('excludes practice and incomplete runs and stores each ID only once',()=>{
    const duplicate=run({id:'duplicate',difficulty:'normal',accuracy:90,createdAt:1});
    const latestCopy={...duplicate,score:999,createdAt:2};
    const compact=compactRankedResults([
      duplicate,
      latestCopy,
      run({id:'practice-archive',practice:true,accuracy:100}),
      run({id:'incomplete-archive',completed:false,accuracy:100}),
    ]);
    expect(compact).toEqual([latestCopy]);
  });
});
