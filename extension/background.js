// My Browser: service worker.
// Connects to the My Browser program on this PC (ws://127.0.0.1:<port>) and runs
// the tools it forwards from the Claude app. No site blocklist, no content filter.
// Both sides prove they know the pairing code before any tool runs.

import { runTool, detachAll, shareTab, unshareTab, isShared } from './tools.js';

const DEFAULT_PORT = 47615;
const VERSION = chrome.runtime.getManifest().version;
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

let ws = null;
let paired = false;
let pairProblem = '';
let keepAlive = null;
const running = new Map(); // call id -> { reject }

async function settings() {
  return chrome.storage.local.get({ enabled: true, port: DEFAULT_PORT });
}

async function pairingCode() {
  let { code } = await chrome.storage.local.get('code');
  if (!code) {
    const bytes = crypto.getRandomValues(new Uint8Array(16));
    const raw = [...bytes].map((b) => CODE_CHARS[b % CODE_CHARS.length]).join('');
    code = raw.match(/.{4}/g).join('-');
    await chrome.storage.local.set({ code });
  }
  return code;
}

const normalizeCode = (c) => String(c || '').toUpperCase().replace(/[^A-Z0-9]/g, '');

async function hmac(code, message) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(normalizeCode(code)), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(message));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function randomHex(n) {
  return [...crypto.getRandomValues(new Uint8Array(n))].map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function isStopped() {
  const { stopped } = await chrome.storage.session.get('stopped');
  return !!stopped;
}

async function updateBadge() {
  const { enabled } = await settings();
  const state = !enabled ? 'off' : (await isStopped()) ? 'stopped' : pairProblem ? 'problem' : paired ? 'on' : 'waiting';
  const look = {
    on: { text: 'ON', color: '#2e7d32' },
    waiting: { text: '…', color: '#ef6c00' },
    problem: { text: '!', color: '#c62828' },
    stopped: { text: 'STOP', color: '#c62828' },
    off: { text: 'OFF', color: '#757575' },
  }[state];
  chrome.action.setBadgeText({ text: look.text });
  chrome.action.setBadgeBackgroundColor({ color: look.color });
}

async function connect() {
  const { enabled, port } = await settings();
  if (!enabled) { updateBadge(); return; }
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;
  let sock;
  try {
    sock = new WebSocket(`ws://127.0.0.1:${port}`);
  } catch (e) {
    return;
  }
  ws = sock;
  let myNonce = null;
  sock.onopen = () => {
    clearInterval(keepAlive);
    // Regular traffic keeps the service worker alive while connected (Chrome 116+).
    keepAlive = setInterval(() => {
      if (sock.readyState === WebSocket.OPEN) sock.send(JSON.stringify({ type: 'ping' }));
    }, 20000);
  };
  // Handle link messages strictly in order, so a call never overtakes the pairing reply.
  let queue = Promise.resolve();
  sock.onmessage = (ev) => { queue = queue.then(() => handleLink(ev.data)).catch(() => {}); };
  const handleLink = async (data) => {
    let msg;
    try { msg = JSON.parse(data); } catch (e) { return; }
    if (msg.type === 'challenge' && typeof msg.nonce === 'string') {
      myNonce = randomHex(16);
      const code = await pairingCode();
      sock.send(JSON.stringify({ type: 'hello', version: VERSION, mac: await hmac(code, 'ext:' + msg.nonce), nonce: myNonce }));
    } else if (msg.type === 'welcome' && myNonce) {
      const expected = await hmac(await pairingCode(), 'host:' + myNonce);
      if (msg.mac === expected) {
        paired = true;
        pairProblem = '';
      } else {
        pairProblem = "The program on port " + (await settings()).port + " doesn't know this pairing code, so My Browser won't take orders from it.";
        sock.close();
      }
      updateBadge();
    } else if (msg.type === 'denied') {
      pairProblem = 'The pairing code in the Claude app does not match this one. Copy the code below into My Browser\'s settings in the Claude app.';
      updateBadge();
    } else if (msg.type === 'call' && paired) {
      onCall(sock, msg);
    }
  };
  sock.onclose = () => {
    if (ws === sock) { ws = null; paired = false; }
    clearInterval(keepAlive);
    updateBadge();
    settings().then(({ enabled }) => { if (enabled) setTimeout(connect, 3000); });
  };
  sock.onerror = () => {};
}

function disconnect() {
  if (ws) { try { ws.close(); } catch (e) {} }
  ws = null;
  paired = false;
}

const stoppedText = 'Stopped by the user (Stop button in Chrome). Do not continue the task; ask the user what to do next. The tools stay paused until the user presses Resume.';

async function onCall(sock, msg) {
  const reply = (body) => {
    if (sock.readyState === WebSocket.OPEN) sock.send(JSON.stringify({ type: 'result', id: msg.id, ...body }));
  };
  const { enabled } = await settings();
  if (!enabled) {
    reply({ isError: true, content: [{ type: 'text', text: 'My Browser is switched off in Chrome. Ask the user to switch it on (toolbar icon).' }] });
    return;
  }
  if (await isStopped()) {
    reply({ isError: true, content: [{ type: 'text', text: stoppedText }] });
    return;
  }
  const stopPromise = new Promise((_, reject) => running.set(msg.id, { reject }));
  let result;
  try {
    result = await Promise.race([runTool(msg.tool, msg.args || {}), stopPromise]);
  } catch (e) {
    result = { isError: true, content: [{ type: 'text', text: e && e.stopped ? stoppedText : `Error: ${e && e.message ? e.message : e}` }] };
  } finally {
    running.delete(msg.id);
  }
  await addLog(msg.tool, msg.args, result);
  reply(result);
}

// Stop stays in force until the user presses Resume (or switches My Browser off and on).
async function stopAll() {
  await chrome.storage.session.set({ stopped: true });
  for (const { reject } of running.values()) reject({ stopped: true });
  running.clear();
  detachAll();
  updateBadge();
}

async function resume() {
  await chrome.storage.session.set({ stopped: false });
  updateBadge();
}

async function addLog(tool, args, result) {
  const { log = [] } = await chrome.storage.session.get('log');
  const what = args && (args.url || args.action || args.query || args.ref || '');
  log.unshift({
    time: new Date().toLocaleTimeString(),
    tool,
    what: String(what).slice(0, 80),
    ok: !(result && result.isError),
  });
  await chrome.storage.session.set({ log: log.slice(0, 20) });
}

// Messages from the popup.
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    if (msg.type === 'status') {
      const s = await settings();
      const { log = [] } = await chrome.storage.session.get('log');
      sendResponse({ ...s, connected: paired, pairProblem, stopped: await isStopped(), code: await pairingCode(), log });
    } else if (msg.type === 'setEnabled') {
      await chrome.storage.local.set({ enabled: msg.enabled });
      if (msg.enabled) { await resume(); connect(); } else { await stopAll(); await resume(); disconnect(); }
      updateBadge();
      sendResponse({ ok: true });
    } else if (msg.type === 'setPort') {
      await chrome.storage.local.set({ port: msg.port });
      disconnect();
      connect();
      sendResponse({ ok: true });
    } else if (msg.type === 'stop') {
      await stopAll();
      sendResponse({ ok: true });
    } else if (msg.type === 'resume') {
      await resume();
      sendResponse({ ok: true });
    } else if (msg.type === 'share' || msg.type === 'unshare') {
      try {
        if (msg.type === 'share') await shareTab(msg.tabId); else await unshareTab(msg.tabId);
        sendResponse({ ok: true });
      } catch (e) {
        sendResponse({ ok: false, error: String(e.message || e) });
      }
    } else if (msg.type === 'isShared') {
      sendResponse({ shared: await isShared(msg.tabId) });
    }
  })();
  return true;
});

chrome.runtime.onStartup.addListener(connect);
chrome.runtime.onInstalled.addListener(() => { pairingCode(); connect(); });
chrome.alarms.create('reconnect', { periodInMinutes: 0.5 });
chrome.alarms.onAlarm.addListener((a) => { if (a.name === 'reconnect') connect(); });
connect();
