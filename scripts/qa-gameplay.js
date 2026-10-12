async (page) => {
  await page.goto('http://127.0.0.1:5178');
  await page.getByRole('button',{name:/Carefree artwork Carefree/}).click();
  await page.getByRole('radio',{name:'normal',exact:true}).click();
  const correction=page.getByRole('button',{name:'Apply correction & rebuild'});
  if(await correction.isVisible())await correction.click();
  await page.getByRole('checkbox',{name:/Practice section/}).check();
  await page.getByLabel('End', {exact:false}).fill('18');
  await page.getByRole('button',{name:'Start performance'}).click();
  await page.waitForFunction(()=>window.__afterbeat?.getStates().length);
  const notes=await page.evaluate(()=>window.__afterbeat.getStates().map(s=>s.note));
  const actions=[];
  const keys=['d','f','j','k'];
  for(const n of notes){actions.push({time:n.timeMs,kind:'down',key:keys[n.lane]});actions.push({time:n.endTimeMs??n.timeMs+30,kind:'up',key:keys[n.lane]});}
  actions.sort((a,b)=>a.time-b.time);
  let captured=false;
  for(const action of actions){
    const time=await page.evaluate(()=>window.__afterbeat.transport.sourceTimeAt());
    const delay=action.time-time;
    if(delay>0)await page.waitForTimeout(delay);
    if(action.kind==='down')await page.keyboard.down(action.key);else await page.keyboard.up(action.key);
    if(!captured&&action.time>6500){await page.screenshot({path:'output/playwright/gameplay-scoring.png'});captured=true;}
  }
  await page.getByRole('button',{name:'Choose song',exact:true}).waitFor({timeout:8000});
  await page.screenshot({path:'output/playwright/practice-results.png'});
  const result=await page.evaluate(()=>JSON.parse(localStorage.getItem('afterbeat.progress.v1')).results.at(-1));
  if(result.accuracy<90||!result.practice||result.counts.perfect<10)throw Error('Real input gameplay check failed');
  return {environment:'Headless Chrome at 412x915; real Playwright keyboard input',result};
}
