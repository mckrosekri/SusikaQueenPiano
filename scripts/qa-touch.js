async (page) => {
  await page.goto('http://127.0.0.1:5178');
  await page.getByRole('button',{name:/Carefree artwork Carefree/}).click();
  await page.getByRole('radio',{name:'expert',exact:true}).click();
  await page.getByRole('radio',{name:'1.5×',exact:true}).click();
  await page.getByRole('checkbox',{name:/Practice section/}).check();
  await page.getByLabel('End',{exact:false}).fill('36');
  await page.getByRole('button',{name:'Start performance'}).click();
  await page.waitForFunction(()=>window.__afterbeat?.getStates().length,{timeout:30000});
  const training=page.getByRole('button',{name:'Take the stage'});if(await training.isVisible())await training.click();
  const report=await page.evaluate(async()=>{
    // Synthetic PointerEvents exercise the unmodified pointer/input/scoring handlers.
    // Native pointer capture requires hardware-generated pointer IDs; bypass capture
    // only on this temporary test canvas. Physical touch feel remains a device gate.
    const api=window.__afterbeat,canvas=document.querySelector('canvas'),box=canvas.getBoundingClientRect();
    const capture=canvas.setPointerCapture;canvas.setPointerCapture=()=>{};
    const rate=api.config.rate,notes=api.getStates().map(s=>s.note),actions=[],free=[-1,-1];
    for(const n of notes){const finger=free.findIndex(end=>end<=n.timeMs);if(finger<0)throw Error('More than two fingers');
      const end=n.endTimeMs??n.timeMs+32*rate;free[finger]=end;
      actions.push({time:n.timeMs,type:'pointerdown',finger,lane:n.lane,id:n.id});
      if(n.kind==='flick')actions.push({time:n.timeMs+16*rate,type:'pointermove',finger,lane:n.lane+n.direction*.45});
      if(n.kind==='slide')for(let time=n.timeMs+20;time<end;time+=20){let lane=n.lane;for(let i=1;i<n.path.length;i++){if(time<=n.path[i].timeMs){const a=n.path[i-1],b=n.path[i];lane=a.lane+(b.lane-a.lane)*(time-a.timeMs)/(b.timeMs-a.timeMs);break;}}actions.push({time,type:'pointermove',finger,lane});}
      actions.push({time:end,type:'pointerup',finger,lane:n.targetLane??n.lane});}
    actions.sort((a,b)=>a.time-b.time || (a.type==='pointerup'?-1:b.type==='pointerup'?1:0));let index=0;
    try{await new Promise(resolve=>{const step=()=>{const time=api.transport.sourceTimeAt();while(index<actions.length&&actions[index].time<=time){const a=actions[index++];const target=a.type==='pointerdown'?api.getTileRects().find(tile=>tile.id===a.id):undefined;const y=target?Math.max(2,Math.min(box.height-2,(target.top+target.bottom)/2)):box.height-106;canvas.dispatchEvent(new PointerEvent(a.type,{bubbles:true,cancelable:true,pointerId:100+a.finger,pointerType:'touch',isPrimary:a.finger===0,clientX:box.x+(a.lane+.5)*box.width/4,clientY:box.y+y,buttons:a.type==='pointerup'?0:1,pressure:.5}));}if(index===actions.length)resolve();else requestAnimationFrame(step);};requestAnimationFrame(step);});
      return {environment:'Headless Chrome synthetic DOM touch input integration, capture bypassed only in test; physical latency not measured',
        kinds:Object.fromEntries(['tap','hold','flick','slide'].map(k=>[k,notes.filter(n=>n.kind===k).length])),
        metrics:{audio:api.getMetrics(),render:api.getPerformance()},counts:api.getEngine().counts};
    }finally{canvas.setPointerCapture=capture;}
  });
  await page.getByRole('button',{name:'Choose song',exact:true}).waitFor({timeout:10000});
  await page.screenshot({path:'output/playwright/expert-gesture-results.png'});
  const result=await page.evaluate(()=>JSON.parse(localStorage.getItem('afterbeat.progress.v1')).results.at(-1));
  if(result.accuracy<98||result.counts.miss)throw Error('Gesture input integration failed: '+JSON.stringify(result));
  return {...report,result,passed:true};
}
