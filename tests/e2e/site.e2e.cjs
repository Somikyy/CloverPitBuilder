// Optional browser test of all pages (needs Playwright: npm i -D playwright && npx playwright install chromium).
// Start a server first: python3 -m http.server 8765 --bind 127.0.0.1   then: node tests/e2e/site.e2e.cjs
const { chromium } = require('playwright');
const BASE = process.env.E2E_BASE || 'http://127.0.0.1:8765/';
const OUT = process.env.E2E_OUT || require('os').tmpdir();
const results = [];
const ok = (name, cond, extra = '') => { results.push(`${cond ? 'PASS' : 'FAIL'} ${name}${extra ? ' — ' + extra : ''}`); };
(async () => {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1400, height: 1000 } });
  await ctx.addInitScript(() => { localStorage.setItem('cp.sound', 'false'); });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('dialog', async (d) => { if (d.type() === 'prompt') await d.accept('E2E build'); else await d.accept(); });
  const waitResults = async () => { await page.waitForTimeout(450); await page.waitForFunction(() => !document.querySelector('#status-left .busy-dot'), null, { timeout: 30000 }); await page.waitForTimeout(400); };

  await page.goto(BASE + 'index.html', { waitUntil: 'networkidle' });
  await waitResults();
  ok('helper loads picks', (await page.locator('#picks .pick').count()) >= 10);

  // add a charm via picker
  await page.click('.socket.empty');
  await page.fill('.sheet-body input[type=search]', 'golden lemon');
  await page.waitForTimeout(200);
  await page.locator('.sheet-body .tile').first().click();
  await page.keyboard.press('Escape');
  await waitResults();
  ok('charm added', (await page.locator('#sockets .socket:not(.empty)').count()) === 1);
  ok('space counter', (await page.textContent('#space-count')).startsWith('1/'));

  // add second charm and set trait + drawer
  await page.click('.socket.empty');
  await page.fill('.sheet-body input[type=search]', 'pentacle');
  await page.waitForTimeout(200);
  await page.locator('.sheet-body .tile').first().click();
  await page.keyboard.press('Escape');
  await waitResults();
  await page.locator('#sockets .socket:not(.empty)').nth(1).click();
  await page.selectOption('dialog[open] select', 'avid');
  await page.keyboard.press('Escape');
  await waitResults();
  const st1 = await page.evaluate(() => JSON.parse(localStorage.getItem('cp.build.v1')));
  ok('trait saved', st1.charms.some((c) => c.id === 'pentacle' && c.trait === 'avid'));
  await page.locator('#sockets .socket:not(.empty)').nth(1).click();
  await page.locator('dialog[open] button', { hasText: 'Move to a drawer' }).click();
  await waitResults();
  const st2 = await page.evaluate(() => JSON.parse(localStorage.getItem('cp.build.v1')));
  ok('drawer saved', st2.charms.some((c) => c.id === 'pentacle' && c.drawer));
  await page.locator('#sockets .socket.drawer').click();
  await page.locator('dialog[open] button', { hasText: 'Put back on the table' }).click();
  await waitResults();

  // phone call
  await page.click('#add-call');
  await page.fill('.sheet-body input[type=search]', 'lemons');
  await page.waitForTimeout(200);
  await page.locator('.sheet-body .tile').first().click();
  await page.keyboard.press('Escape');
  await waitResults();
  ok('call added', (await page.locator('#calls .call').count()) === 1);
  await page.locator('#calls .call .stepper button[aria-label^="One more"]').click();
  await waitResults();
  ok('call count 2', (await page.inputValue('#calls .call input')) === '2');
  // typing in the count box keeps focus; clearing it never deletes the call
  const countBox = page.locator('#calls .call input');
  await countBox.focus();
  await page.keyboard.press('Control+A'); await page.keyboard.type('12');
  await waitResults();
  const st12 = await page.evaluate(() => JSON.parse(localStorage.getItem('cp.build.v1')));
  ok('call count typed as 12', Object.values(st12.phone)[0] === 12, JSON.stringify(st12.phone));
  ok('count box keeps focus', await page.evaluate(() => document.activeElement && document.activeElement.matches('#calls .call input')));
  await page.keyboard.press('Control+A'); await page.keyboard.press('Backspace');
  await page.waitForTimeout(400);
  await page.keyboard.press('Tab');
  await waitResults();
  ok('cleared count box keeps the call', (await page.locator('#calls .call').count()) === 1 && (await page.inputValue('#calls .call input')) === '12');
  await page.locator('#calls .call input').fill('1'); await page.locator('#calls .call input').press('Enter');
  await waitResults();

  // in-game numbers
  await page.click('#boards summary');
  await page.fill('[data-sym-val="lemon"]', '30');
  await waitResults();
  const share = await page.evaluate(() => { const r = [...document.querySelectorAll('#sym-bars .bar-row .pct')].map((x) => x.textContent); return r[0]; });
  ok('lemon override dominates coins', parseInt(share) > 50, `top share ${share}`);
  // a single typed chance is used as typed
  await page.fill('[data-sym-chance="seven"]', '40');
  await waitResults();
  const sevenTitle = await page.evaluate(() => [...document.querySelectorAll('#sym-bars .bar-row')].map((x) => x.title).find((t) => t.startsWith('Seven')));
  ok('one typed chance applies', /chance 40\.0%/.test(sevenTitle || ''), sevenTitle);
  await page.fill('[data-sym-chance="seven"]', '');
  await waitResults();

  // deadline stepper + tickets
  await page.click('[data-step="1"]'); await page.click('[data-step="1"]');
  await page.fill('#tickets', '5');
  await waitResults();
  ok('deadline 3 shown', (await page.textContent('#led-deadline')) === '3');

  // offers
  await page.click('#tab-offers');
  await page.click('#add-offer-charm');
  await page.fill('.sheet-body input[type=search]', 'lemon picture');
  await page.waitForTimeout(200);
  await page.locator('.sheet-body .tile').first().click();
  await waitResults();
  await page.click('#add-offer-charm');
  await page.fill('.sheet-body input[type=search]', 'number 2');
  await page.waitForTimeout(200);
  await page.locator('.sheet-body .tile').first().click();
  await waitResults();
  ok('two offers ranked', (await page.locator('#picks .pick').count()) === 2);
  await page.screenshot({ path: OUT + '/offers.png' });
  const priceInput = page.locator('#picks .pick input.num').first();
  await priceInput.fill('9');
  await priceInput.press('Enter');
  await waitResults();
  const firstAfter = await page.locator('#picks .pick h4 button').first().textContent();
  ok('price change re-ranks / keeps list', (await page.locator('#picks .pick').count()) === 2, `top: ${firstAfter}`);
  const ticketsBefore = (await page.evaluate(() => JSON.parse(localStorage.getItem('cp.build.v1')))).tickets;
  await page.locator('#picks .pick .side button', { hasText: 'Bought it' }).first().dblclick();
  await waitResults();
  ok('bought offer moves to table', (await page.locator('#picks .pick').count()) === 1);
  const stB = await page.evaluate(() => JSON.parse(localStorage.getItem('cp.build.v1')));
  const paid = ticketsBefore - stB.tickets;
  ok('double click pays once', paid >= 0 && paid <= 9 && stB.charms.length === 3, `paid ${paid}, charms ${stB.charms.length}`);

  // phone tab + details dialog with insight
  await page.click('#tab-phone');
  await waitResults();
  await page.locator('#picks .pick .art').first().click();
  ok('detail shows insight', (await page.locator('dialog[open] h3', { hasText: 'In your build' }).count()) === 1);
  await page.keyboard.press('Escape');
  ok('reels show item icons, no "?" tiles', (await page.locator('#reels img[src^="data:image/svg"]').count()) === 0);
  // a related item opened from the details dialog gets its own add button
  await page.click('#tab-charms');
  await waitResults();
  const relCase = await page.evaluate(() => {
    const picks = [...document.querySelectorAll('#picks .pick h4 button')].map((b) => b.textContent);
    return picks;
  });
  await page.locator('#picks .pick h4 button').first().click();
  const relCount = await page.locator('dialog[open] .rel').count();
  if (relCount) {
    const firstName = await page.locator('dialog[open] h2').textContent();
    await page.locator('dialog[open] .rel').first().click();
    const relName = await page.locator('dialog[open] h2').textContent();
    const addBtn = page.locator('dialog[open] .btn.amber');
    if (await addBtn.count()) {
      await addBtn.click();
      await waitResults();
      const stR = await page.evaluate(() => JSON.parse(localStorage.getItem('cp.build.v1')));
      const names = await page.evaluate(() => [...document.querySelectorAll('#sockets .socket:not(.empty)')].map((x) => x.getAttribute('aria-label')));
      ok('related item adds itself, not the first item', names.some((n) => n.startsWith(relName)) || Object.keys(stR.phone).length > 1, `${firstName} -> ${relName}: ${names.join(', ')}`);
    } else {
      ok('related item adds itself, not the first item', true, `${relName}: no add button (owned or not ranked)`);
      await page.keyboard.press('Escape');
    }
  } else { ok('related item adds itself, not the first item', true, 'no related items on ' + relCase[0]); await page.keyboard.press('Escape'); }

  // save + share
  await page.click('#save-build');
  await page.waitForTimeout(300);
  ok('saved build listed', (await page.locator('#saved-list').textContent()).includes('E2E build'));
  const url = await page.evaluate(async () => (await import('./assets/js/app/state.js')).shareUrl(JSON.parse(localStorage.getItem('cp.build.v1'))));
  ok('share url generated', /#b=[zj][A-Za-z0-9_-]+$/.test(url), url.slice(0, 80));

  // load share link in a fresh context
  const ctx2 = await browser.newContext({ viewport: { width: 1200, height: 900 } });
  await ctx2.addInitScript(() => localStorage.setItem('cp.sound', 'false'));
  const p2 = await ctx2.newPage();
  p2.on('pageerror', (e) => errors.push('p2 ' + e.message));
  await p2.goto(url, { waitUntil: 'networkidle' });
  await p2.waitForTimeout(2500);
  ok('shared build loads charms', (await p2.locator('#sockets .socket:not(.empty)').count()) >= 2);
  ok('hash cleared after load', !(await p2.evaluate(() => location.hash)));
  // opening a link over your own build keeps yours in Saved builds; broken links say so
  await p2.evaluate(() => { const s = JSON.parse(localStorage.getItem('cp.build.v1')); s.charms = [{ id: 'lucky_cat', trait: null, drawer: false }]; localStorage.setItem('cp.build.v1', JSON.stringify(s)); });
  await p2.goto(BASE + 'index.html', { waitUntil: 'networkidle' });
  await p2.waitForTimeout(1500);
  await p2.evaluate((u) => { location.hash = new URL(u).hash; }, url);
  await p2.waitForTimeout(2500);
  ok('hashchange loads the link', (await p2.locator('#sockets .socket:not(.empty)').count()) >= 2);
  ok('own build kept in Saved builds', (await p2.locator('#saved-list').textContent()).includes('before a shared link'));
  await p2.evaluate(() => { location.hash = 'b=zAbCdEf'; });
  await p2.waitForTimeout(800);
  ok('broken link explained', ((await p2.locator('.toast').textContent()) || '').includes('broken'));
  // phone layout: your run comes right after the machine, before the long list
  await p2.setViewportSize({ width: 390, height: 844 });
  await p2.waitForTimeout(300);
  const order = await p2.evaluate(() => ({ build: document.querySelector('.zone-build').getBoundingClientRect().top, picks: document.querySelector('#results').getBoundingClientRect().top, machine: document.querySelector('.machine').getBoundingClientRect().top }));
  ok('phone: machine, then your run, then picks', order.machine < order.build && order.build < order.picks, JSON.stringify(order));
  ok('phone: no sideways scroll', await p2.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
  await p2.screenshot({ path: OUT + '/phone.png', fullPage: false });
  await ctx2.close();

  // new run
  await page.click('#new-run');
  await waitResults();
  ok('new run clears table', (await page.locator('#sockets .socket:not(.empty)').count()) === 0);

  // items page
  await page.goto(BASE + 'items.html', { waitUntil: 'networkidle' });
  await page.waitForTimeout(500);
  const allCharms = await page.locator('#grid .tile').count();
  ok('items lists all charms', allCharms === 201, String(allCharms));
  await page.fill('#q', 'poop');
  await page.waitForTimeout(200);
  ok('nickname search finds Number 2', (await page.locator('#grid .tile .t-name').allTextContents()).includes('Number 2'));
  await page.fill('#q', '');
  await page.click('[data-kind="memory"]');
  await page.waitForTimeout(200);
  ok('memory cards listed', (await page.locator('#grid .tile').count()) === 27);
  await page.click('[data-kind="phone"]');
  await page.selectOption('#rarity', 'Legendary');
  await page.waitForTimeout(200);
  const legPhone = await page.locator('#grid .tile').count();
  ok('phone legendary filter', legPhone > 0 && legPhone < 41, String(legPhone));
  await page.locator('#grid .tile').first().click();
  await page.locator('dialog[open] .btn.amber').click();
  const st3 = await page.evaluate(() => JSON.parse(localStorage.getItem('cp.build.v1')));
  ok('add from items page saves to build', Object.keys(st3.phone).length === 1);
  ok('items url keeps filters', page.url().includes('kind=phone') && page.url().includes('rarity=Legendary'));

  // tier list
  await page.goto(BASE + 'tiers.html', { waitUntil: 'networkidle' });
  await page.waitForTimeout(600);
  ok('tier rows', (await page.locator('.tier-row').count()) >= 5);
  await page.click('[data-mode="build"]');
  await page.waitForFunction(() => !document.querySelector('#tier-status .busy-dot'), null, { timeout: 30000 });
  await page.waitForTimeout(400);
  ok('build tiers computed', (await page.locator('.tier-item .sc').count()) > 50);
  await page.click('[data-kind="phone"]');
  await page.waitForTimeout(300);
  ok('build tiers for phone', (await page.locator('.tier-item').count()) > 10);

  // 404, also when served at a deep missing address (as GitHub Pages does)
  const errorsBefore404 = errors.length; // the 404 pages log their own (expected) 404 status
  const bad404 = [];
  page.on('response', (r) => { if (r.status() >= 400 && !/\/(404\.html|deep\/nested\/page)$/.test(r.url())) bad404.push(r.url()); });
  await page.goto(BASE + '404.html');
  ok('404 page renders', (await page.textContent('h1')) === '666');
  const html404 = await (await page.request.get(BASE + '404.html')).text();
  await page.route('**/deep/nested/page', (route) => route.fulfill({ status: 404, contentType: 'text/html', body: html404 }));
  await page.goto(BASE + 'deep/nested/page');
  await page.waitForTimeout(300);
  ok('404 styled at a deep address', await page.evaluate(() => getComputedStyle(document.body).backgroundColor !== 'rgba(0, 0, 0, 0)'));
  ok('404 link goes to the helper', (await page.getAttribute('h1 + p a, .page-head a', 'href')) === './' && new URL(await page.evaluate(() => document.querySelector('.page-head a').href)).pathname === '/');

  ok('404 loads no missing files', bad404.length === 0, bad404.join(' '));
  errors.length = errorsBefore404;
  ok('no page errors', errors.length === 0, errors.slice(0, 5).join(' | '));
  console.log(results.join('\n'));
  await browser.close();
})().catch((e) => { console.log(results.join('\n')); console.error('E2E crashed:', e.message); process.exit(1); });
