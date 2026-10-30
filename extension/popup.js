// My Browser: toolbar popup (on/off switch, Stop, share this tab, recent actions).

const $ = (id) => document.getElementById(id);
const send = (msg) => chrome.runtime.sendMessage(msg);
let activeTabId = null;

async function refresh() {
  const s = await send({ type: 'status' });
  $('enabled').checked = s.enabled;
  $('port').value = s.port;
  const [color, text] = !s.enabled ? ['#757575', 'Switched off. Claude cannot use this browser.']
    : s.connected ? ['#2e7d32', 'Connected to the Claude app.']
    : ['#ef6c00', 'Waiting for the My Browser program. Open the Claude app.'];
  $('status').innerHTML = `<span class="dot" style="background:${color}"></span>${text}`;
  $('log').innerHTML = s.log.length
    ? s.log.map((l) => `<li>${l.ok ? '✓' : '✗'} <b>${esc(l.time)}</b> ${esc(l.tool)} <span class="muted">${esc(l.what)}</span></li>`).join('')
    : '<li class="muted">Nothing yet.</li>';
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  activeTabId = tab ? tab.id : null;
  const { shared } = activeTabId != null ? await send({ type: 'isShared', tabId: activeTabId }) : { shared: false };
  $('share').textContent = shared ? 'Stop sharing this tab' : 'Share this tab with Claude';
  $('share').dataset.shared = shared ? '1' : '';
}

function esc(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

$('enabled').addEventListener('change', async (e) => { await send({ type: 'setEnabled', enabled: e.target.checked }); refresh(); });
$('stop').addEventListener('click', async () => { await send({ type: 'stop' }); $('stop').textContent = 'Stopped'; setTimeout(() => { $('stop').textContent = 'Stop'; }, 1500); });
$('share').addEventListener('click', async () => {
  if (activeTabId == null) return;
  const r = await send({ type: $('share').dataset.shared ? 'unshare' : 'share', tabId: activeTabId });
  if (!r.ok) alert(r.error);
  refresh();
});
$('savePort').addEventListener('click', async () => {
  const port = Number($('port').value);
  if (port >= 1024 && port <= 65535) { await send({ type: 'setPort', port }); refresh(); }
});

refresh();
setInterval(refresh, 2000);
