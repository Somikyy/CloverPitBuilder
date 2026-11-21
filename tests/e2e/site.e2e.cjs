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
  let promptAnswer = 'E2E build', lastPrompt = '', lastConfirm = ''; // promptAnswer null = accept the suggested name
  page.on('dialog', async (d) => {
    if (d.type() === 'prompt') { lastPrompt = d.defaultValue(); await d.accept(promptAnswer ?? d.defaultValue()); }
    else { if (d.type() === 'confirm') lastConfirm = d.message(); await d.accept(); }
  });
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
  await page.keyboard.press('Enter'); // Enter in the search box takes the top match
  await page.waitForTimeout(150);
  await page.click('dialog[open] .close-btn'); // (Escape in a search box first clears the text)
  await waitResults();
  ok('call added (Enter in the search box)', (await page.locator('#calls .call').count()) === 1);
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
  await page.fill('#tickets', '5');
  await page.click('#add-offer-charm');
  await page.fill('.sheet-body input[type=search]', 'golden clover');
  await page.waitForTimeout(200);
  await page.locator('.sheet-body .tile').first().click();
  await waitResults();
  const clover = page.locator('#picks .pick', { hasText: 'Golden Clover' });
  await clover.locator('input.num').fill('1'); // no Enter, no waiting: click "Bought it" at once
  await clover.locator('.side button', { hasText: 'Bought it' }).click();
  await waitResults();
  const stT = await page.evaluate(() => JSON.parse(localStorage.getItem('cp.build.v1')));
  ok('typed store price is what you pay', stT.tickets === 4 && stT.charms.some((c) => c.id === 'golden_clover'), `tickets ${stT.tickets}`);

  // phone tab + details dialog with insight
  await page.click('#tab-phone');
  await waitResults();
  await page.locator('#picks .pick .art').first().click();
  ok('detail shows insight', (await page.locator('dialog[open] h3', { hasText: 'In your build' }).count()) === 1);
  await page.keyboard.press('Escape');
  ok('reels show item icons, no "?" tiles', (await page.locator('#reels img[src^="data:image/svg"]').count()) === 0);
  // a related item opened from the details dialog gets its own add button (Fruit Basket -> Golden Cherry)
  await page.click('#tab-charms');
  await waitResults();
  if (await page.locator('#show-more').isVisible()) await page.click('#show-more');
  await page.locator('#picks .pick h4 button', { hasText: 'Fruit Basket' }).first().click();
  await page.locator('dialog[open] .rel', { hasText: 'Golden Cherry' }).click();
  const relName = await page.locator('dialog[open] h2').textContent();
  await page.locator('dialog[open] .btn.amber').click();
  await waitResults();
  const stR = await page.evaluate(() => JSON.parse(localStorage.getItem('cp.build.v1')));
  ok('related item adds itself, not the first item', relName === 'Golden Cherry' && stR.charms.some((c) => c.id === 'golden_cherry') && !stR.charms.some((c) => c.id === 'fruit_basket'), stR.charms.map((c) => c.id).join(', '));
  const ownedVals = await page.evaluate(() => [...document.querySelectorAll('#owned li .val')].map((x) => x.textContent));
  const pcts = ownedVals.filter((v) => /%$/.test(v)).map((v) => parseInt(v, 10));
  ok('your charms are listed best to weakest', pcts.length >= 3 && pcts.every((v, i) => i === 0 || v <= pcts[i - 1]), ownedVals.join(' '));
  const rows = await page.evaluate(() => [...document.querySelectorAll('#picks .pick')].map((li) => li.querySelectorAll('ul.why li').length));
  ok('every pick explains its score', rows.length > 100 && rows.every((n) => n > 0), `${rows.filter((n) => !n).length} without reasons`);

  // save + share
  await page.click('#save-build');
  await page.waitForTimeout(300);
  ok('saved build listed', (await page.locator('#saved-list').textContent()).includes('E2E build'));
  promptAnswer = null; // accept the suggested name, twice: the second suggestion must not replace the first save
  await page.click('#save-build'); await page.waitForTimeout(300);
  const sugg1 = lastPrompt;
  await page.click('#save-build'); await page.waitForTimeout(300);
  const sugg2 = lastPrompt;
  let savedNames = await page.evaluate(() => JSON.parse(localStorage.getItem('cp.saved.v1')).map((x) => x.name));
  ok('suggested save names never replace a save', sugg1 !== sugg2 && savedNames.includes(sugg1) && savedNames.includes(sugg2), `${sugg1} / ${sugg2}`);
  promptAnswer = 'E2E build';
  await page.click('#save-build'); await page.waitForTimeout(300);
  savedNames = await page.evaluate(() => JSON.parse(localStorage.getItem('cp.saved.v1')).map((x) => x.name));
  ok('saving under a taken name asks first', lastConfirm.includes('already exists') && ((await page.locator('.toast').textContent()) || '').includes('Replaced') && savedNames.filter((n) => n === 'E2E build').length === 1, lastConfirm);
  await page.fill('#tickets', '77');
  await waitResults();
  await page.locator('#saved-list button', { hasText: sugg1 }).first().click();
  await waitResults();
  ok('loading a saved build keeps the one in progress', (await page.locator('#saved-list').textContent()).includes('before loading a saved one'));
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
  await p2.evaluate(async () => (await import('./assets/js/app/common.js')).toast('Bought Steam Locomotive for 3 tickets'));
  await p2.waitForTimeout(300);
  const toastW = await p2.evaluate(() => document.querySelector('.toast').getBoundingClientRect().width);
  ok('phone: short toast fits on one line', toastW > 215, `${Math.round(toastW)} px`);
  ok('phone: timing stays on one line', await p2.evaluate(() => { const el = document.getElementById('status-right'); return !el.textContent || el.getBoundingClientRect().height < 32; }));
  await p2.click('#tab-phone');
  await p2.waitForTimeout(300);
  const phoneStatus = await p2.evaluate(() => document.getElementById('status-left').innerText);
  ok('phone: status names the Offers tab as labelled', phoneStatus.includes('under Offers'), phoneStatus);
  await p2.setViewportSize({ width: 320, height: 640 });
  await p2.evaluate(() => { document.getElementById('boards').open = true; });
  await p2.waitForTimeout(300);
  const overhang = await p2.evaluate(() => {
    const panel = document.querySelector('.zone-build'), cs = getComputedStyle(panel);
    const edge = panel.getBoundingClientRect().right - parseFloat(cs.paddingRight) - parseFloat(cs.borderRightWidth);
    return Math.max(...[...document.querySelectorAll('#symbols-board .board-row')].map((r) => r.getBoundingClientRect().right)) - edge;
  });
  ok('phone 320: in-game numbers fit their panel', overhang <= 1, `${overhang.toFixed(1)} px over`);
  ok('phone 320: no sideways scroll', await p2.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
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
  await page.goto(BASE + 'items.html?item=pentacle', { waitUntil: 'networkidle' });
  await page.waitForTimeout(400);
  ok('items: ?item= opens the item and stays in the address', (await page.locator('dialog[open] h2').textContent()) === 'Pentacle' && page.url().includes('item=pentacle'));
  await page.keyboard.press('Escape');
  await page.waitForTimeout(200);
  ok('items: closing the item clears ?item=', !page.url().includes('item='), page.url());
  await page.goto(BASE + 'items.html?kind=phone&rarity=legendary&sort=__proto__&arch=nope', { waitUntil: 'networkidle' });
  await page.waitForTimeout(400);
  ok('items: link values in any case, unknown ones ignored', (await page.inputValue('#rarity')) === 'Legendary' && (await page.inputValue('#sort')) === 'name' && (await page.inputValue('#arch')) === '' && (await page.locator('#grid .tile').count()) > 0);
  await page.click('[data-kind="charm"]');
  await page.selectOption('#rarity', '');
  await page.fill('#q', 'poop');
  await page.waitForTimeout(200);
  ok('items: one result reads "1 charm"', (await page.textContent('#count')) === '1 charm', await page.textContent('#count'));

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
  await page.evaluate(() => localStorage.setItem('cp.build.v1', JSON.stringify({ v: 1, mode: { memory: 'erased_memory_card', hard: false, sacred: false, dlc: true }, deadline: 3, tickets: 0, coins: null, deposited: null, charms: [], phone: { life_gave_me_lemons: 1 }, stats: {}, offers: [], prefs: { horizon: 0.7 } })));
  await page.goto(BASE + 'tiers.html?mode=build', { waitUntil: 'networkidle' });
  await page.waitForFunction(() => !document.querySelector('#tier-status .busy-dot') && document.querySelector('.tier-item .sc'), null, { timeout: 30000 });
  const tierStatus = await page.textContent('#tier-status');
  ok('tiers: a build with only calls is not called empty', tierStatus.startsWith('Ranked for your build: 1 phone call, deadline 3'), tierStatus);
  ok('tiers: disabled Memory cards button looks disabled', await page.evaluate(() => { const b = document.querySelector('#kind-seg [data-kind="memory"]'); return b.disabled && parseFloat(getComputedStyle(b).opacity) < 1 && !!b.title; }));

  // 404, also when served at a deep missing address (as GitHub Pages does)
  const errorsBefore404 = errors.length; // the 404 pages log their own (expected) 404 status
  const bad404 = [];
  page.on('response', (r) => { if (r.status() >= 400 && !/\/(404\.html|deep\/nested\/page)$/.test(r.url())) bad404.push(r.url()); });
  await page.goto(BASE + '404.html');
  ok('404 page renders', (await page.textContent('h1')) === '666');
  const html404 = await page.evaluate(async (u) => (await fetch(u)).text(), BASE + '404.html');
  await page.route('**/deep/nested/page', (route) => route.fulfill({ status: 404, contentType: 'text/html', body: html404 }));
  await page.goto(BASE + 'deep/nested/page');
  await page.waitForTimeout(300);
  ok('404 styled at a deep address', await page.evaluate(() => getComputedStyle(document.body).backgroundColor !== 'rgba(0, 0, 0, 0)'));
  const sitePath = new URL(BASE).pathname; // "/" here, "/CloverPitBuilder/" on GitHub Pages
  ok('404 link goes to the helper', (await page.getAttribute('h1 + p a, .page-head a', 'href')) === './' && new URL(await page.evaluate(() => document.querySelector('.page-head a').href)).pathname === sitePath);
  const ctx3 = await browser.newContext({ javaScriptEnabled: false });
  // without JavaScript the page relies on GitHub Pages' folder: serve this checkout there too
  if (sitePath === '/') await ctx3.route('**/CloverPitBuilder/**', (route) => route.continue({ url: route.request().url().replace('/CloverPitBuilder/', '/') }));
  const p3 = await ctx3.newPage();
  await p3.route('**/a/b/c/d', (route) => route.fulfill({ status: 404, contentType: 'text/html', body: html404 }));
  await p3.goto(BASE + 'a/b/c/d');
  await p3.waitForTimeout(300);
  const noJs = await p3.evaluate(() => ({ bg: getComputedStyle(document.body).backgroundColor, link: new URL(document.querySelector('.page-head a').href).pathname }));
  ok('404 without JavaScript: styled, link to the helper', noJs.bg !== 'rgba(0, 0, 0, 0)' && noJs.link === '/CloverPitBuilder/', JSON.stringify(noJs));
  await ctx3.close();

  ok('404 loads no missing files', bad404.length === 0, bad404.join(' '));
  errors.length = errorsBefore404;
  ok('no page errors', errors.length === 0, errors.slice(0, 5).join(' | '));
  console.log(results.join('\n'));
  await browser.close();
})().catch((e) => { console.log(results.join('\n')); console.error('E2E crashed:', e.message); process.exit(1); });
