// My Browser end-to-end tests: real Chromium + the extension + the PC program, driven
// through a standard MCP client (the same way the Claude app calls it).
// Usage: node run.mjs [stage1|stage2|stage3|all]

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const EXT = path.join(root, 'extension');
const EXT_ID = 'knfgdpidabhgpedilggpjdeppcjpehpm';
const PORT = 47615;
const WEB = 'http://127.0.0.1:8123';
const which = process.argv[2] || 'all';

let passed = 0;
let failed = 0;
function check(name, cond, detail = '') {
  if (cond) { passed++; console.log(`  PASS ${name}`); }
  else { failed++; console.log(`  FAIL ${name}${detail ? `\n       ${String(detail).slice(0, 400)}` : ''}`); }
}
const textOf = (r) => (r.content || []).filter((c) => c.type === 'text').map((c) => c.text).join('\n');

// ---- test web server ----
const web = http.createServer((req, res) => {
  const url = new URL(req.url, WEB);
  if (url.pathname === '/redirect') { res.writeHead(302, { Location: '/text.html' }); return res.end(); }
  const file = path.join(here, 'pages', path.normalize(url.pathname).replace(/^\/+/, ''));
  if (!file.startsWith(path.join(here, 'pages')) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); return res.end('not found'); }
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  fs.createReadStream(file).pipe(res);
});
await new Promise((r) => web.listen(8123, '127.0.0.1', r));

// ---- browser with the extension ----
const userDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mb-profile-'));
const context = await chromium.launchPersistentContext(userDir, {
  channel: 'chromium',
  headless: true,
  viewport: process.env.VIEW ? { width: Number(process.env.VIEW.split('x')[0]), height: Number(process.env.VIEW.split('x')[1]) } : { width: 1200, height: 800 },
  deviceScaleFactor: Number(process.env.DPR) || 1,
  args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`],
});

async function popup() {
  const p = await context.newPage();
  await p.goto(`chrome-extension://${EXT_ID}/popup.html`);
  return p;
}

// The pairing code the extension made at install (the user copies it from the popup).
const firstPopup = await popup();
const CODE = (await firstPopup.evaluate(() => chrome.runtime.sendMessage({ type: 'status' }))).code;
await firstPopup.close();

// ---- the PC program, through a real MCP client ----
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [path.join(process.env.HOST_DIR || path.join(root, 'host'), 'server.js')],
  env: { ...process.env, MY_BROWSER_PORT: String(PORT), MY_BROWSER_CODE: CODE.toLowerCase() },
  stderr: 'pipe',
});
const hostLog = [];
transport.stderr && transport.stderr.on('data', (d) => hostLog.push(String(d)));
const client = new Client({ name: 'my-browser-test', version: '1.0.0' });
await client.connect(transport);
const call = (name, args = {}) => client.callTool({ name, arguments: args });

try {
  // ---------------- Stage 1: link, tools list, tabs ----------------
  if (['stage1', 'stage2', 'stage3', 'all'].includes(which)) {
    console.log('Stage 1: extension, link to the PC program, tabs');
    const sw = context.serviceWorkers()[0] || (await context.waitForEvent('serviceworker', { timeout: 15000 }));
    check('extension loaded with the fixed ID', sw.url().startsWith(`chrome-extension://${EXT_ID}/`), sw.url());

    const tools = (await client.listTools()).tools.map((t) => t.name).sort();
    const want = ['computer', 'find', 'form_input', 'get_page_text', 'javascript_tool', 'navigate', 'read_page', 'tabs_close_mcp', 'tabs_context_mcp', 'tabs_create_mcp'];
    check('all 10 tools listed', JSON.stringify(tools) === JSON.stringify(want), tools.join(','));

    let ctx;
    for (let i = 0; i < 20; i++) {
      ctx = await call('tabs_context_mcp', { createIfEmpty: true });
      if (!ctx.isError) break;
      await new Promise((r) => setTimeout(r, 1000));
    }
    check('extension connects and answers', !ctx.isError, textOf(ctx));
    const ctxJson = JSON.parse(textOf(ctx));
    check('createIfEmpty made a tab in the group', ctxJson.availableTabs.length === 1, textOf(ctx));

    const created = await call('tabs_create_mcp', { url: `${WEB}/text.html` });
    const tab = JSON.parse(textOf(created));
    check('tabs_create_mcp opens a URL', tab.title === 'Test article', textOf(created));
    globalThis.TAB = tab.tabId;

    const ctx2 = JSON.parse(textOf(await call('tabs_context_mcp')));
    check('tabs_context_mcp lists both tabs', ctx2.availableTabs.length === 2, JSON.stringify(ctx2));

    const blank = ctxJson.availableTabs[0].tabId;
    const closed = await call('tabs_close_mcp', { tabId: blank });
    check('tabs_close_mcp closes a tab', !closed.isError, textOf(closed));

    // A tab outside the group is refused.
    const p = await context.newPage();
    await p.goto(`${WEB}/text.html`);
    const pop = await popup();
    const otherId = await pop.evaluate(async () => (await chrome.tabs.query({})).find((t) => t.url.endsWith('/text.html') && t.groupId === -1).id);
    const refused = await call('get_page_text', { tabId: otherId });
    check('tab outside the My Browser group is refused', refused.isError && /not in the "My Browser" tab group/.test(textOf(refused)), textOf(refused));

    // Sharing it through the popup's code path makes it usable.
    await pop.evaluate((id) => chrome.runtime.sendMessage({ type: 'share', tabId: id }), otherId);
    const shared = await call('get_page_text', { tabId: otherId });
    check('a shared tab can be used', !shared.isError, textOf(shared));
    await p.close();

    // On/off switch.
    await pop.evaluate(() => chrome.runtime.sendMessage({ type: 'setEnabled', enabled: false }));
    const off = await call('tabs_context_mcp');
    check('switched off: tools refuse', off.isError, textOf(off));
    await pop.evaluate(() => chrome.runtime.sendMessage({ type: 'setEnabled', enabled: true }));
    let on;
    for (let i = 0; i < 15; i++) {
      on = await call('tabs_context_mcp');
      if (!on.isError) break;
      await new Promise((r) => setTimeout(r, 1000));
    }
    check('switched back on: tools work again', !on.isError, textOf(on));

    // Stop button cancels a running action.
    const waiting = call('computer', { tabId: TAB, action: 'wait', duration: 10 });
    await new Promise((r) => setTimeout(r, 1000));
    await pop.evaluate(() => chrome.runtime.sendMessage({ type: 'stop' }));
    const stopped = await waiting;
    check('Stop cancels the running action', stopped.isError && /Stopped by the user/.test(textOf(stopped)), textOf(stopped));
    await new Promise((r) => setTimeout(r, 6000));
    const still = await call('tabs_context_mcp');
    check('Stop stays in force (6 s later, still refused)', still.isError && /Stopped by the user/.test(textOf(still)), textOf(still));
    await pop.evaluate(() => chrome.runtime.sendMessage({ type: 'resume' }));
    const resumed = await call('tabs_context_mcp');
    check('Resume makes the tools work again', !resumed.isError, textOf(resumed));

    const status = await pop.evaluate(() => chrome.runtime.sendMessage({ type: 'status' }));
    // Only our extension may connect to the PC program: a web page or other program is refused.
    const WS = require(path.join(root, 'host', 'node_modules', 'ws'));
    const tryOrigin = (origin) => new Promise((resolve) => {
      const s = new WS(`ws://127.0.0.1:${PORT}`, { origin });
      s.on('open', () => { s.close(); resolve('open'); });
      s.on('error', () => resolve('refused'));
    });
    check('a web page cannot connect to the PC program', (await tryOrigin('https://evil.example')) === 'refused');
    // A program faking the extension's origin but without the pairing code is refused.
    const fake = await new Promise((resolve) => {
      const s = new WS(`ws://127.0.0.1:${PORT}`, { origin: `chrome-extension://${EXT_ID}` });
      s.on('message', (raw) => {
        const m = JSON.parse(raw);
        if (m.type === 'challenge') s.send(JSON.stringify({ type: 'hello', mac: 'f'.repeat(64), nonce: 'abc' }));
        if (m.type === 'denied') resolve('denied');
        if (m.type === 'welcome') resolve('accepted');
      });
      s.on('error', () => resolve('error'));
      setTimeout(() => resolve('timeout'), 5000);
    });
    check('a program without the pairing code is refused by the PC program', fake === 'denied', fake);
    const stillWorks = await call('tabs_context_mcp');
    check('the real extension keeps its link after that', !stillWorks.isError, textOf(stillWorks));

    // A program on the port that doesn't know the code gets no obedience from the extension.
    const rogue = new WS.WebSocketServer({ host: '127.0.0.1', port: PORT + 1 });
    const rogueResult = new Promise((resolve) => {
      rogue.on('connection', (s) => {
        s.send(JSON.stringify({ type: 'challenge', nonce: '00' }));
        s.on('message', (raw) => {
          const m = JSON.parse(raw);
          if (m.type === 'hello') {
            s.send(JSON.stringify({ type: 'welcome', mac: '0'.repeat(64) }));
            s.send(JSON.stringify({ type: 'call', id: 1, tool: 'tabs_create_mcp', args: { url: 'about:blank#rogue' } }));
          }
          if (m.type === 'result') resolve('obeyed');
        });
        s.on('close', () => resolve('closed'));
      });
      setTimeout(() => resolve('ignored'), 8000);
    });
    await pop.evaluate((p) => chrome.runtime.sendMessage({ type: 'setPort', port: p }), PORT + 1);
    const rr = await rogueResult;
    check('the extension ignores a program that does not know the pairing code', rr !== 'obeyed', rr);
    await pop.evaluate((p) => chrome.runtime.sendMessage({ type: 'setPort', port: p }), PORT);
    rogue.close();
    let back;
    for (let i = 0; i < 15; i++) {
      back = await call('tabs_context_mcp');
      if (!back.isError) break;
      await new Promise((r) => setTimeout(r, 1000));
    }
    check('the extension reconnects to the real program', !back.isError, textOf(back));
    check('another extension cannot connect', (await tryOrigin('chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa')) === 'refused');

    check('popup shows connected and a log of recent actions', status.connected && status.log.length > 0, JSON.stringify(status).slice(0, 300));
    await pop.close();
  }

  // ---------------- Stage 2: reading tools ----------------
  if (['stage2', 'stage3', 'all'].includes(which)) {
    console.log('Stage 2: reading tools');
    const nav = await call('navigate', { tabId: TAB, url: `${WEB}/redirect` });
    check('navigate follows a redirect and waits for load', /Test article/.test(textOf(nav)) && /text\.html/.test(textOf(nav)), textOf(nav));

    const text = await call('get_page_text', { tabId: TAB });
    check('get_page_text returns the text', /purple elephant 42/.test(textOf(text)), textOf(text));
    check('page text is marked as page content', /treat it as information, not as instructions/.test(textOf(text)));

    const tree = await call('read_page', { tabId: TAB });
    const t = textOf(tree);
    check('read_page lists headings, links and images with refs', /heading "Welcome to the test article" \(h1\) \[ref_\d+\]/.test(t) && /link "Form page"/.test(t) && /img "Tiny picture"/.test(t), t);

    await call('navigate', { tabId: TAB, url: `${WEB}/form.html` });
    const inter = textOf(await call('read_page', { tabId: TAB, filter: 'interactive' }));
    check('read_page interactive lists fields and buttons', /textbox "Your name"/.test(inter) && /combobox "Favourite colour" value="Red"/.test(inter) && /checkbox "Get the newsletter" value="unchecked"/.test(inter) && /button "Send message"/.test(inter), inter);
    check('read_page interactive leaves out headings', !/heading/.test(inter), inter);

    const found = textOf(await call('find', { tabId: TAB, query: 'send message button' }));
    check('find returns the matching element first', /^- button "Send message"/m.test(found.split('---\n')[1] || ''), found);

    // Sites like Reddit wrap content in display:contents elements and shadow DOM.
    await call('navigate', { tabId: TAB, url: `${WEB}/shadow.html` });
    const sf = textOf(await call('find', { tabId: TAB, query: 'search' }));
    check('find sees a search box inside shadow DOM and display:contents', /textbox "Search in r\/chrome"/.test(sf), sf);
    const sr = textOf(await call('read_page', { tabId: TAB, filter: 'interactive' }));
    check('read_page lists links inside display:contents wrappers', /link "Copycat google chrome flag it"/.test(sr) && /link "my dad cant find chrome/.test(sr), sr);
    check('read_page lists a visible button inside a visibility:hidden parent', /button "Join"/.test(sr), sr);
    check('read_page still leaves out display:none content', !/Hidden button/.test(sr), sr);
    await call('navigate', { tabId: TAB, url: `${WEB}/text.html` });
    check('get_page_text includes the page heading', /Welcome to the test article/.test(textOf(await call('get_page_text', { tabId: TAB }))));
    await call('navigate', { tabId: TAB, url: `${WEB}/form.html` });

    const back = await call('navigate', { tabId: TAB, url: 'back' });
    check('navigate back', /Test article/.test(textOf(back)), textOf(back));
    const fwd = await call('navigate', { tabId: TAB, url: 'forward' });
    check('navigate forward', /Test form/.test(textOf(fwd)), textOf(fwd));

    const noScheme = await call('navigate', { tabId: TAB, url: '127.0.0.1:1/' });
    check('navigate adds https:// and reports the result without crashing', !noScheme.isError || /error/i.test(textOf(noScheme)), textOf(noScheme));

    const chromePage = await call('navigate', { tabId: TAB, url: 'chrome://version' });
    const cpText = await call('get_page_text', { tabId: TAB });
    check('chrome:// pages explained as a Chrome rule', cpText.isError && /Chrome rule/.test(textOf(cpText)), textOf(chromePage) + ' / ' + textOf(cpText));
    await call('navigate', { tabId: TAB, url: `${WEB}/form.html` });
  }

  // ---------------- Stage 3: click, type and the ask-first list ----------------
  if (['stage3', 'all'].includes(which)) {
    console.log('Stage 3: click, type, ask-first');
    const js = (code) => call('javascript_tool', { tabId: TAB, action: 'javascript_exec', text: code }).then(textOf);
    const findRef = async (q) => (textOf(await call('find', { tabId: TAB, query: q })).match(/\[(ref_\d+)\]/) || [])[1];

    check('javascript_tool returns the last expression', (await js('2 + 2')) === '4');
    check('javascript_tool allows return and await', (await js('await new Promise(r => setTimeout(r, 50)); return document.title')) === 'Test form');

    const shot = await call('computer', { tabId: TAB, action: 'screenshot' });
    const img = (shot.content || []).find((c) => c.type === 'image');
    check('screenshot returns an image', img && img.data.length > 1000 && img.mimeType === 'image/jpeg', textOf(shot));
    const jpegSize = (b64) => {
      const b = Buffer.from(b64, 'base64');
      for (let i = 2; i < b.length - 9;) {
        if (b[i] !== 0xff) { i++; continue; }
        const m = b[i + 1];
        if (m >= 0xc0 && m <= 0xc3) return [b.readUInt16BE(i + 7), b.readUInt16BE(i + 5)];
        i += 2 + b.readUInt16BE(i + 2);
      }
      return null;
    };
    const vw = JSON.parse(await js('JSON.stringify([innerWidth, innerHeight])'));
    const told = (textOf(shot).match(/(\d+)x(\d+)/) || []).slice(1).map(Number);
    const size = img && jpegSize(img.data);
    const fitW = Math.round(vw[0] * Math.min(1, 1568 / Math.max(...vw), Math.sqrt(1150000 / (vw[0] * vw[1]))));
    const small = vw[0] <= 1568 && vw[0] * 1100 <= 1150000;
    check(`screenshot matches what the tool reports, full size when small (scale ${process.env.DPR || 1})`, size && Math.abs(size[0] - told[0]) <= 2 && Math.abs(size[1] - told[1]) <= 2 && size[0] <= 1568 && (!small || Math.abs(size[0] - fitW) <= 2), JSON.stringify({ size, told, vw, fitW }));
    globalThis.SHOT_F = size[0] / vw[0];

    // Plain click by ref: no confirmation.
    const details = await findRef('show details');
    const c1 = await call('computer', { tabId: TAB, action: 'left_click', ref: details });
    check('plain click goes through', !/NEEDS CONFIRMATION/.test(textOf(c1)) && (await js("document.getElementById('out').textContent")) === 'clicked:plain', textOf(c1));

    // Click by coordinate.
    const box = await js("JSON.stringify((r => [r.left + r.width/2, r.top + r.height/2])(document.querySelector('#name').getBoundingClientRect()))");
    const [nx, ny] = JSON.parse(box);
    await call('computer', { tabId: TAB, action: 'left_click', coordinate: [Math.round(nx * SHOT_F), Math.round(ny * SHOT_F)] });
    await call('computer', { tabId: TAB, action: 'type', text: 'Dhanush' });
    check('click by coordinate then type', (await js("document.getElementById('name').value")) === 'Dhanush');
    await call('computer', { tabId: TAB, action: 'key', text: 'ctrl+a Backspace' });
    check('key combo (ctrl+a, Backspace) clears the field', (await js("document.getElementById('name').value")) === '');

    // Ask-first: send, order, delete.
    for (const [q, label, result] of [['send message', 'Send message', 'sent'], ['place order', 'Place order', 'ordered'], ['delete account', 'Delete account', 'deleted']]) {
      await js("document.getElementById('out').textContent = ''");
      const ref = await findRef(q);
      const r1 = await call('computer', { tabId: TAB, action: 'left_click', ref });
      check(`"${label}" stops and asks first`, /NEEDS CONFIRMATION/.test(textOf(r1)) && (await js("document.getElementById('out').textContent")) === '', textOf(r1));
      const r2 = await call('computer', { tabId: TAB, action: 'left_click', ref, confirmed: true });
      check(`"${label}" goes through after confirmed: true`, (await js("document.getElementById('out').textContent")) === result, textOf(r2));
    }

    // File upload asks first.
    const fileRef = await findRef('file upload');
    const fu = await call('computer', { tabId: TAB, action: 'left_click', ref: fileRef });
    check('file upload stops and asks first', /NEEDS CONFIRMATION/.test(textOf(fu)) && /upload/.test(textOf(fu)), textOf(fu));

    // Enter in a search box: no confirmation.
    const q = await findRef('search the site');
    await call('form_input', { tabId: TAB, ref: q, value: 'cats' });
    await call('computer', { tabId: TAB, action: 'left_click', ref: q });
    const e1 = await call('computer', { tabId: TAB, action: 'key', text: 'Enter' });
    check('Enter in a search box goes through', !/NEEDS CONFIRMATION/.test(textOf(e1)) && (await js("document.getElementById('out').textContent")) === 'searched:cats', textOf(e1));

    // Enter in a message box: asks first.
    const chat = await findRef('write a message');
    await call('computer', { tabId: TAB, action: 'left_click', ref: chat });
    await call('computer', { tabId: TAB, action: 'type', text: 'hello there' });
    const e2 = await call('computer', { tabId: TAB, action: 'key', text: 'Enter' });
    check('Enter in a message box stops and asks first', /NEEDS CONFIRMATION/.test(textOf(e2)) && (await js("document.getElementById('chatout').textContent")) === '', textOf(e2));
    await call('computer', { tabId: TAB, action: 'key', text: 'Enter', confirmed: true });
    check('message sends after confirmed: true', (await js("document.getElementById('chatout').textContent")) === 'posted:hello there');

    // form_input on normal fields: no confirmation.
    const nameRef = await findRef('your name');
    await call('form_input', { tabId: TAB, ref: nameRef, value: 'Asha' });
    const colorRef = await findRef('favourite colour');
    await call('form_input', { tabId: TAB, ref: colorRef, value: 'Blue' });
    const newsRef = await findRef('newsletter');
    const ni = await call('form_input', { tabId: TAB, ref: newsRef, value: true });
    const vals = await js("[document.getElementById('name').value, document.getElementById('color').value, document.getElementById('news').checked].join('|')");
    check('form_input sets text, list and checkbox', vals === 'Asha|b|true', vals + ' / ' + textOf(ni));

    // Account settings page: toggles and "Save changes" ask first.
    await call('navigate', { tabId: TAB, url: `${WEB}/account/settings.html` });
    const privRef = await findRef('private profile');
    const s1 = await call('form_input', { tabId: TAB, ref: privRef, value: true });
    check('settings toggle stops and asks first', /NEEDS CONFIRMATION/.test(textOf(s1)) && (await js("document.getElementById('private').checked")) === 'false', textOf(s1));
    const s2 = await call('form_input', { tabId: TAB, ref: privRef, value: true, confirmed: true });
    check('settings toggle goes through after confirmed: true', (await js("document.getElementById('private').checked")) === 'true', textOf(s2));
    const saveRef = await findRef('save changes');
    const s3 = await call('computer', { tabId: TAB, action: 'left_click', ref: saveRef });
    check('"Save changes" stops and asks first', /NEEDS CONFIRMATION/.test(textOf(s3)), textOf(s3));

    // Audit fixes: more button words, Space key, iframes, icon-only send, headlines.
    await call('navigate', { tabId: TAB, url: `${WEB}/risky.html` });
    await new Promise((r) => setTimeout(r, 800));
    for (const [q, label] of [['repost', 'Repost'], ['share now', 'Share now'], ['complete booking', 'Complete booking'], ['place bid', 'Place bid']]) {
      const ref = await findRef(q);
      const r = await call('computer', { tabId: TAB, action: 'left_click', ref });
      check(`"${label}" stops and asks first`, /NEEDS CONFIRMATION/.test(textOf(r)) && (await js("document.getElementById('out').textContent")) === '', textOf(r));
    }
    await js("document.getElementById('paynow').focus()");
    const sp = await call('computer', { tabId: TAB, action: 'key', text: 'space' });
    check('Space on a focused "Pay now" stops and asks first', /NEEDS CONFIRMATION/.test(textOf(sp)) && (await js("document.getElementById('out').textContent")) === '', textOf(sp));
    const frameBox = JSON.parse(await js("JSON.stringify((r => [r.left + 100, r.top + 30])(document.getElementById('payframe').getBoundingClientRect()))"));
    await call('computer', { tabId: TAB, action: 'screenshot' });
    const ifr = await call('computer', { tabId: TAB, action: 'left_click', coordinate: frameBox });
    check('click on a payment box inside an iframe stops and asks first', /NEEDS CONFIRMATION/.test(textOf(ifr)) && (await js("document.getElementById('out').textContent")) === '', textOf(ifr));
    const cref = await findRef('write a comment');
    await call('computer', { tabId: TAB, action: 'left_click', ref: cref });
    await call('computer', { tabId: TAB, action: 'type', text: 'nice' });
    const ce = await call('computer', { tabId: TAB, action: 'key', text: 'Enter' });
    check('Enter in a comment box with an icon-only button stops and asks first', /NEEDS CONFIRMATION/.test(textOf(ce)) && (await js("document.getElementById('out').textContent")) === '', textOf(ce));
    check('the confirmation message quotes page text without quote marks', !/"/.test((textOf(ce).match(/\((button or field text[^)]*)\)/) || ['', ''])[1]), textOf(ce));
    const hl = await call('computer', { tabId: TAB, action: 'left_click', ref: await findRef('should you buy a house') });
    check('a long headline link with "buy" in it goes through', !/NEEDS CONFIRMATION/.test(textOf(hl)), textOf(hl));
    await call('navigate', { tabId: TAB, url: `${WEB}/account/plain.html` });
    const bare = await call('computer', { tabId: TAB, action: 'left_click', ref: await findRef('save') });
    check('a bare "Save" on an account page stops and asks first', /NEEDS CONFIRMATION/.test(textOf(bare)), textOf(bare));

    // javascript_tool: a runtime error that mentions "return" must not run the code twice.
    await js("window.__runs = 0");
    await js("window.__runs++; throw new Error('please return later')");
    check('javascript_tool does not run code twice after an error', (await js('window.__runs')) === '1');

    // Click by screenshot coordinates (big screens get a shrunk screenshot).
    await call('navigate', { tabId: TAB, url: `${WEB}/form.html` });
    const shot2 = await call('computer', { tabId: TAB, action: 'screenshot' });
    const im2 = (shot2.content || []).find((c) => c.type === 'image');
    const sz2 = jpegSize(im2.data);
    const iw = JSON.parse(await js('JSON.stringify([innerWidth, innerHeight])'));
    check(`screenshot fits Claude's image limit (${process.env.VIEW || '1200x800'})`, sz2[0] <= 1568 && sz2[0] * sz2[1] <= 1150000 * 1.01, JSON.stringify(sz2));
    const f = sz2[0] / iw[0];
    const det = JSON.parse(await js("JSON.stringify((r => [r.left + r.width/2, r.top + r.height/2])([...document.querySelectorAll('button')].find(b => b.textContent === 'Show details').getBoundingClientRect()))"));
    await js("document.getElementById('out').textContent = ''");
    await call('computer', { tabId: TAB, action: 'left_click', coordinate: [Math.round(det[0] * f), Math.round(det[1] * f)] });
    check('a click at screenshot coordinates hits the right button', (await js("document.getElementById('out').textContent")) === 'clicked:plain');

    // Audit 2: web components, closed shadow roots, deep nesting, display:contents links, iframes.
    await call('navigate', { tabId: TAB, url: `${WEB}/wc.html` });
    await new Promise((r) => setTimeout(r, 500));
    const wcTree = textOf(await call('read_page', { tabId: TAB, filter: 'interactive' }));
    check('a web-component button gets its slotted label', /button "Buy now"/.test(wcTree), wcTree);
    check('read_page sees inside closed shadow roots', /textbox "Search closed box"/.test(wcTree) && /button "Pay now"/.test(wcTree), wcTree);
    check('read_page lists a link 40 levels deep', /link "Deep link"/.test(wcTree), wcTree);
    check('read_page lists a display:contents link', /link "Contents link"/.test(wcTree), wcTree);
    check('read_page lists the iframe and says its contents are not read', /iframe "Embedded article".*not read/.test(wcTree), wcTree);
    const fc = textOf(await call('find', { tabId: TAB, query: 'search closed' }));
    check('find sees a search box in a closed shadow root', /textbox "Search closed box"/.test(fc), fc);
    const shot3 = await call('computer', { tabId: TAB, action: 'screenshot' });
    const im3 = (shot3.content || []).find((c) => c.type === 'image');
    const f3 = jpegSize(im3.data)[0] / Number(await js('innerWidth'));
    const buyBox = JSON.parse(await js("JSON.stringify((r => [r.left + 6, r.top + 6])(document.getElementById('buy').getBoundingClientRect()))"));
    const wb = await call('computer', { tabId: TAB, action: 'left_click', coordinate: [Math.round(buyBox[0] * f3), Math.round(buyBox[1] * f3)] });
    check('click on the padding of a web-component "Buy now" asks first', /NEEDS CONFIRMATION/.test(textOf(wb)) && (await js("document.getElementById('out').textContent")) === '', textOf(wb));
    const payBox = JSON.parse(await js("JSON.stringify((r => [r.left + r.width / 2, r.top + r.height / 2])(document.getElementById('pay').getBoundingClientRect()))"));
    const wp = await call('computer', { tabId: TAB, action: 'left_click', coordinate: [Math.round(payBox[0] * f3), Math.round(payBox[1] * f3)] });
    check('click on "Pay now" inside a closed shadow root asks first', /NEEDS CONFIRMATION/.test(textOf(wp)) && (await js("document.getElementById('out').textContent")) === '', textOf(wp));
    const cl = await call('computer', { tabId: TAB, action: 'left_click', ref: (wcTree.match(/link "Contents link".*\[(ref_\d+)\]/) || [])[1] });
    await new Promise((r) => setTimeout(r, 800));
    check('a display:contents link can be clicked by ref', /Test article/.test(textOf(await call('tabs_context_mcp'))), textOf(cl));

    // Local addresses open over http.
    const ip = await call('navigate', { tabId: TAB, url: '127.0.0.1:8123/text.html' });
    check('an IP address without http:// opens over http', /Test article/.test(textOf(ip)) && /http:\/\/127\.0\.0\.1:8123/.test(textOf(ip)), textOf(ip));

    // A new tab that can't join the group is closed again, not left behind.
    const swk = context.serviceWorkers()[0];
    const before = await swk.evaluate(async () => (await chrome.tabs.query({})).length);
    await swk.evaluate(() => { self.__origGroup = chrome.tabs.group; chrome.tabs.group = () => Promise.reject(new Error('Tabs cannot be edited right now (user may be dragging a tab).')); });
    const stuck = await call('tabs_create_mcp', { url: `${WEB}/text.html` });
    await swk.evaluate(() => { chrome.tabs.group = self.__origGroup; });
    const after = await swk.evaluate(async () => (await chrome.tabs.query({})).length);
    check('a tab that cannot join the group is closed, not left behind', stuck.isError && after === before, `${textOf(stuck)} | tabs before ${before}, after ${after}`);
    const okAgain = await call('tabs_create_mcp', { url: `${WEB}/text.html` });
    check('creating a tab works again afterwards', !okAgain.isError, textOf(okAgain));
    await call('tabs_close_mcp', { tabId: JSON.parse(textOf(okAgain)).tabId });

    // Scroll, hover, wait.
    await call('navigate', { tabId: TAB, url: `${WEB}/long.html` });
    await call('computer', { tabId: TAB, action: 'scroll', scroll_direction: 'down', scroll_amount: 5 });
    await new Promise((r) => setTimeout(r, 500));
    const y = Number(await js('scrollY'));
    check('scroll moves the page', y > 100, String(y));
    const w = await call('computer', { tabId: TAB, action: 'wait', duration: 1 });
    check('wait works', /Waited 1 seconds/.test(textOf(w)), textOf(w));
    const h = await call('computer', { tabId: TAB, action: 'hover', coordinate: [100, 100] });
    check('hover works', !h.isError, textOf(h));
  }
} catch (e) {
  failed++;
  console.log('  CRASH', e && e.stack ? e.stack : e);
} finally {
  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed) console.log('host log:\n' + hostLog.join('').slice(-2000));
  await client.close().catch(() => {});
  await context.close().catch(() => {});
  web.close();
  process.exit(failed ? 1 : 0);
}
