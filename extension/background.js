// My Browser: service worker.
// Connects to the My Browser program on this PC (ws://127.0.0.1:<port>) and runs
// the tools it forwards from the Claude app. No site blocklist, no content filter.

import { runTool, detachAll, shareTab, unshareTab, isShared } from './tools.js';

const DEFAULT_PORT = 47615;
const VERSION = chrome.runtime.getManifest().version;

let ws = null;
let connected = false;
let keepAlive = null;
let stopUntil = 0;
const running = new Map(); // call id -> { reject }

async function settings() {
  const s = await chrome.storage.local.get({ enabled: true, port: DEFAULT_PORT });
  return s;
}

function setBadge(state) {
  const look = {
    on: { text: 'ON', color: '#2e7d32' },
    waiting: { text: '…', color: '#ef6c00' },
    off: { text: 'OFF', color: '#757575' },
  }[state];
  chrome.action.setBadgeText({ text: look.text });
  chrome.action.setBadgeBackgroundColor({ color: look.color });
}

async function connect() {
  const { enabled, port } = await settings();
  if (!enabled) { setBadge('off'); return; }
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;
  setBadge('waiting');
  let sock;
  try {
    sock = new WebSocket(`ws://127.0.0.1:${port}`);
  } catch (e) {
    return;
  }
  ws = sock;
  sock.onopen = () => {
    connected = true;
    setBadge('on');
    sock.send(JSON.stringify({ type: 'hello', version: VERSION }));
    clearInterval(keepAlive);
    // Regular traffic keeps the service worker alive while connected (Chrome 116+).
    keepAlive = setInterval(() => {
      if (sock.readyState === WebSocket.OPEN) sock.send(JSON.stringify({ type: 'ping' }));
    }, 20000);
  };
  sock.onmessage = (ev) => onMessage(sock, ev.data);
  sock.onclose = () => {
    if (ws === sock) { ws = null; connected = false; }
    clearInterval(keepAlive);
    settings().then(({ enabled }) => {
      setBadge(enabled ? 'waiting' : 'off');
      if (enabled) setTimeout(connect, 3000);
    });
  };
  sock.onerror = () => {};
}

function disconnect() {
  if (ws) { try { ws.close(); } catch (e) {} }
  ws = null;
  connected = false;
}

async function onMessage(sock, raw) {
  let msg;
  try { msg = JSON.parse(raw); } catch (e) { return; }
  if (msg.type !== 'call') return;
  const reply = (body) => {
    if (sock.readyState === WebSocket.OPEN) sock.send(JSON.stringify({ type: 'result', id: msg.id, ...body }));
  };
  const { enabled } = await settings();
  if (!enabled) {
    reply({ isError: true, content: [{ type: 'text', text: 'My Browser is switched off in Chrome. Ask the user to switch it on (toolbar icon).' }] });
    return;
  }
  if (Date.now() < stopUntil) {
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

const stoppedText = 'Stopped by the user (Stop button in Chrome). Do not continue the task; ask the user what to do next.';

function stopAll() {
  stopUntil = Date.now() + 5000;
  for (const { reject } of running.values()) reject({ stopped: true });
  running.clear();
  detachAll();
}

async function addLog(tool, args, result) {
  const { log = [] } = await chrome.storage.session.get('log');
  const what = args && (args.url || args.action || args.query || args.ref || '');
  const first = result && result.content && result.content.find((c) => c.type === 'text');
  log.unshift({
    time: new Date().toLocaleTimeString(),
    tool,
    what: String(what).slice(0, 80),
    ok: !(result && result.isError),
    note: first ? first.text.slice(0, 100) : '',
  });
  await chrome.storage.session.set({ log: log.slice(0, 20) });
}

// Messages from the popup.
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    if (msg.type === 'status') {
      const s = await settings();
      const { log = [] } = await chrome.storage.session.get('log');
      sendResponse({ ...s, connected, log });
    } else if (msg.type === 'setEnabled') {
      await chrome.storage.local.set({ enabled: msg.enabled });
      if (msg.enabled) connect(); else { stopAll(); disconnect(); setBadge('off'); }
      sendResponse({ ok: true });
    } else if (msg.type === 'setPort') {
      await chrome.storage.local.set({ port: msg.port });
      disconnect();
      connect();
      sendResponse({ ok: true });
    } else if (msg.type === 'stop') {
      stopAll();
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
chrome.runtime.onInstalled.addListener(connect);
chrome.alarms.create('reconnect', { periodInMinutes: 0.5 });
chrome.alarms.onAlarm.addListener((a) => { if (a.name === 'reconnect') connect(); });
connect();
