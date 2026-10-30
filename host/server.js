#!/usr/bin/env node
// My Browser: the program on your PC. It speaks MCP to the Claude app over stdio and
// forwards each tool call to the My Browser Chrome extension over a local WebSocket
// (127.0.0.1 only). It talks to nothing on the internet.

'use strict';

const readline = require('readline');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');
const { TOOLS, INSTRUCTIONS } = require('./tools');

const VERSION = '1.0.0';
const PORT = Number(process.env.MY_BROWSER_PORT) || 47615;
// Only our extension may connect (its ID is fixed by the "key" in extension/manifest.json).
const EXTENSION_ID = process.env.MY_BROWSER_EXTENSION_ID || 'knfgdpidabhgpedilggpjdeppcjpehpm';
// The pairing code shown in the extension's toolbar popup; both sides must know it.
const CODE = String(process.env.MY_BROWSER_CODE || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
const PROTOCOL_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];

const log = (...a) => process.stderr.write(`[my-browser] ${a.join(' ')}\n`);

// ---- Link to the Chrome extension ----

let ext = null; // the connected extension socket
let portProblem = null;
let pairProblem = null;
let nextId = 1;
const pending = new Map(); // id -> { resolve, timer }
const waiters = [];

function listen() {
  const wss = new WebSocketServer({
    host: '127.0.0.1',
    port: PORT,
    verifyClient: ({ origin, req }) => {
      const hostOk = /^(127\.0\.0\.1|localhost)(:\d+)?$/.test(req.headers.host || '');
      return hostOk && origin === `chrome-extension://${EXTENSION_ID}`;
    },
  });
  wss.on('listening', () => { portProblem = null; log(`waiting for the Chrome extension on 127.0.0.1:${PORT}`); });
  wss.on('error', (e) => {
    portProblem = e.code === 'EADDRINUSE'
      ? `Port ${PORT} is already in use, probably by My Browser running in another Claude app. Use one Claude app at a time with My Browser, or close the other one.`
      : `My Browser could not open port ${PORT}: ${e.message}`;
    log(portProblem);
    setTimeout(listen, 5000);
  });
  wss.on('connection', (sock) => {
    const nonce = crypto.randomBytes(16).toString('hex');
    let authed = false;
    sock.send(JSON.stringify({ type: 'challenge', nonce }));
    const timer = setTimeout(() => { if (!authed) sock.close(); }, 10000);
    sock.on('message', (raw) => {
      let msg;
      try { msg = JSON.parse(raw); } catch (e) { return; }
      if (!authed) {
        if (msg.type !== 'hello') return;
        const ok = CODE && typeof msg.mac === 'string' && typeof msg.nonce === 'string' &&
          safeEqual(msg.mac, hmac('ext:' + nonce));
        if (!ok) {
          pairProblem = CODE
            ? "The pairing code set in the Claude app doesn't match the one in Chrome. Ask the user to copy the code from the My Browser toolbar popup into My Browser's settings in the Claude app (Settings > Extensions > My Browser), then restart Claude."
            : "No pairing code is set. Ask the user to copy the code from the My Browser toolbar popup in Chrome into My Browser's settings in the Claude app (Settings > Extensions > My Browser), then restart Claude.";
          log('pairing failed');
          sock.send(JSON.stringify({ type: 'denied' }));
          sock.close();
          return;
        }
        authed = true;
        pairProblem = null;
        clearTimeout(timer);
        sock.send(JSON.stringify({ type: 'welcome', mac: hmac('host:' + msg.nonce) }));
        if (ext) ext.close();
        ext = sock;
        log('Chrome extension connected');
        while (waiters.length) waiters.shift()();
        return;
      }
      if (msg.type === 'result' && pending.has(msg.id)) {
        const p = pending.get(msg.id);
        pending.delete(msg.id);
        clearTimeout(p.timer);
        p.resolve({ content: msg.content || [], ...(msg.isError ? { isError: true } : {}) });
      }
    });
    sock.on('close', () => {
      clearTimeout(timer);
      if (ext !== sock) return;
      ext = null;
      log('Chrome extension disconnected');
      for (const [id, p] of pending) {
        clearTimeout(p.timer);
        p.resolve(errorResult('The Chrome extension disconnected during this action (Chrome closed, My Browser switched off, or the extension reloaded).'));
        pending.delete(id);
      }
    });
  });
}

function hmac(message) {
  return crypto.createHmac('sha256', CODE).update(message).digest('hex');
}

function safeEqual(a, b) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

function errorResult(text) {
  return { isError: true, content: [{ type: 'text', text }] };
}

function waitForExtension(ms) {
  if (ext) return Promise.resolve(true);
  return new Promise((resolve) => {
    const t = setTimeout(() => resolve(false), ms);
    waiters.push(() => { clearTimeout(t); resolve(true); });
  });
}

async function callExtension(tool, args) {
  if (!(await waitForExtension(10000))) {
    return errorResult(portProblem || pairProblem ||
      'The My Browser Chrome extension is not connected. Ask the user to open Chrome and check the My Browser toolbar icon is switched on (it shows ON when connected).');
  }
  const id = nextId++;
  const timeoutMs = 120000;
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      resolve(errorResult(`No answer from Chrome after ${timeoutMs / 1000} seconds.`));
    }, timeoutMs);
    pending.set(id, { resolve, timer });
    ext.send(JSON.stringify({ type: 'call', id, tool, args }));
  });
}

// ---- MCP over stdio (newline-delimited JSON-RPC) ----

function send(obj) {
  process.stdout.write(JSON.stringify(obj) + '\n');
}

async function handle(msg) {
  const { id, method, params } = msg;
  const isRequest = id !== undefined && id !== null;
  try {
    switch (method) {
      case 'initialize': {
        const asked = params && params.protocolVersion;
        return reply(id, {
          protocolVersion: PROTOCOL_VERSIONS.includes(asked) ? asked : PROTOCOL_VERSIONS[0],
          capabilities: { tools: {} },
          serverInfo: { name: 'my-browser', version: VERSION },
          instructions: INSTRUCTIONS,
        });
      }
      case 'ping':
        return reply(id, {});
      case 'tools/list':
        return reply(id, { tools: TOOLS });
      case 'tools/call': {
        const name = params && params.name;
        if (!TOOLS.some((t) => t.name === name)) return replyError(id, -32602, `Unknown tool: ${name}`);
        return reply(id, await callExtension(name, (params && params.arguments) || {}));
      }
      default:
        if (isRequest) return replyError(id, -32601, `Method not found: ${method}`);
        return; // notifications (initialized, cancelled, ...) need no answer
    }
  } catch (e) {
    if (isRequest) replyError(id, -32603, String(e && e.message ? e.message : e));
  }
}

function reply(id, result) {
  if (id !== undefined && id !== null) send({ jsonrpc: '2.0', id, result });
}

function replyError(id, code, message) {
  send({ jsonrpc: '2.0', id, error: { code, message } });
}

listen();
const rl = readline.createInterface({ input: process.stdin });
rl.on('line', (line) => {
  if (!line.trim()) return;
  let msg;
  try { msg = JSON.parse(line); } catch (e) { return replyError(null, -32700, 'Parse error'); }
  if (Array.isArray(msg)) msg.forEach(handle); else handle(msg);
});
rl.on('close', () => process.exit(0));
