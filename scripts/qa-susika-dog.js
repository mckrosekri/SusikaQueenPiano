async (page) => {
  await page.goto('http://127.0.0.1:5178');
  await page.setViewportSize({ width: 430, height: 932 });
  await page.getByRole('button', { name: /Carefree artwork Carefree/ }).click();
  await page.getByRole('radio', { name: 'expert', exact: true }).click();
  await page.getByRole('radio', { name: '0.75×', exact: true }).click();
  await page.getByRole('checkbox', { name: /Practice section/ }).check();
  await page.getByLabel('End', { exact: false }).fill('36');
  await page.getByRole('button', { name: 'Start performance' }).click();
  await page.waitForFunction(() => window.__afterbeat?.getStates().length, { timeout: 30000 });
  const tutorial = page.getByRole('button', { name: 'Take the stage' });
  if (await tutorial.isVisible()) await tutorial.click();
  await page.waitForFunction(() => {
    const canvas = document.querySelector('canvas');
    if (!canvas) return false;
    const height = canvas.getBoundingClientRect().height;
    return window.__afterbeat.getTileRects().some(tile => tile.kind === 'hold' && tile.top > height * .03 && tile.bottom < height * .87);
  }, { timeout: 50000 });
  await page.screenshot({ path: 'output/playwright/susika-dog-hold.png' });
  const proof = await page.evaluate(() => ({ title: document.title, hold: window.__afterbeat.getTileRects().find(tile => tile.kind === 'hold'), canvas: { width: document.querySelector('canvas').width, height: document.querySelector('canvas').height } }));
  await page.getByRole('button', { name: 'Pause song' }).click();
  return proof;
}
