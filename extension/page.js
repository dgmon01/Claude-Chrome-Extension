// My Browser: code that runs inside web pages (via chrome.scripting.executeScript).
// pageAgent must be self-contained: Chrome copies the function's source into the page,
// so it can't use anything defined outside it.

export function pageAgent(cmd, args) {
  const S = (window.__myBrowser = window.__myBrowser || { next: 1, byRef: new Map(), byEl: new WeakMap() });

  const clean = (s, n = 100) => (s || '').replace(/\s+/g, ' ').trim().slice(0, n);

  const INTERACTIVE = new Set(['link', 'button', 'textbox', 'searchbox', 'checkbox', 'radio', 'combobox', 'listbox',
    'option', 'menuitem', 'menuitemcheckbox', 'menuitemradio', 'tab', 'switch', 'slider', 'spinbutton', 'treeitem', 'clickable']);

  function refOf(el) {
    let r = S.byEl.get(el);
    if (!r) {
      r = 'ref_' + S.next++;
      S.byEl.set(el, r);
      S.byRef.set(r, new WeakRef(el));
    }
    return r;
  }

  function byRef(ref) {
    const w = S.byRef.get(ref);
    const el = w && w.deref();
    if (!el || !el.isConnected) throw new Error(`Element ${ref} is gone (the page changed). Call read_page or find again.`);
    return el;
  }

  function roleOf(el) {
    const r = el.getAttribute('role');
    if (r) return r.split(' ')[0];
    const tag = el.tagName.toLowerCase();
    if (tag === 'a') return el.hasAttribute('href') ? 'link' : null;
    if (tag === 'button' || tag === 'summary') return 'button';
    if (tag === 'select') return el.multiple ? 'listbox' : 'combobox';
    if (tag === 'textarea') return 'textbox';
    if (tag === 'input') {
      const t = (el.getAttribute('type') || 'text').toLowerCase();
      if (t === 'hidden') return null;
      if (['button', 'submit', 'reset', 'image', 'file'].includes(t)) return 'button';
      if (t === 'checkbox' || t === 'radio') return t;
      if (t === 'range') return 'slider';
      if (t === 'search') return 'searchbox';
      return 'textbox';
    }
    if (/^h[1-6]$/.test(tag)) return 'heading';
    if (tag === 'img') return 'img';
    if (tag === 'nav') return 'navigation';
    if (tag === 'main') return 'main';
    if (tag === 'form') return 'form';
    if (tag === 'dialog') return 'dialog';
    if (tag === 'table') return 'table';
    if (tag === 'li') return 'listitem';
    if (tag === 'p') return 'paragraph';
    if (el.isContentEditable && el.hasAttribute('contenteditable')) return 'textbox';
    if (el.hasAttribute('onclick') || (el.hasAttribute('tabindex') && el.tabIndex >= 0)) return 'clickable';
    return null;
  }

  function nameOf(el) {
    const aria = el.getAttribute('aria-label');
    if (aria) return clean(aria);
    const lb = el.getAttribute('aria-labelledby');
    if (lb) {
      const t = lb.split(/\s+/).map((id) => document.getElementById(id)).filter(Boolean).map((e) => e.innerText).join(' ');
      if (clean(t)) return clean(t);
    }
    const tag = el.tagName.toLowerCase();
    if (tag === 'input' || tag === 'select' || tag === 'textarea') {
      const t = (el.getAttribute('type') || '').toLowerCase();
      if (['button', 'submit', 'reset'].includes(t)) return clean(el.value || t);
      if (t === 'image') return clean(el.alt || 'submit');
      if (t === 'file') return 'file upload';
      const fromLabel = el.labels && [...el.labels].map((l) => l.innerText).join(' ');
      return clean(fromLabel || el.placeholder || el.title || el.name);
    }
    if (tag === 'img') return clean(el.alt || el.title);
    return clean(el.innerText || el.title || el.textContent);
  }

  function valueOf(el) {
    const tag = el.tagName.toLowerCase();
    if (tag === 'input') {
      const t = (el.getAttribute('type') || 'text').toLowerCase();
      if (t === 'checkbox' || t === 'radio') return el.checked ? 'checked' : 'unchecked';
      if (t === 'password') return el.value ? '(password entered)' : '';
      if (['button', 'submit', 'reset', 'image', 'file'].includes(t)) return '';
      return clean(el.value, 80);
    }
    if (tag === 'textarea') return clean(el.value, 80);
    if (tag === 'select') return clean(el.selectedOptions[0] ? el.selectedOptions[0].text : '', 80);
    const checked = el.getAttribute('aria-checked');
    return checked ? (checked === 'true' ? 'checked' : 'unchecked') : '';
  }

  function visible(el) {
    if (el.checkVisibility) return el.checkVisibility({ checkVisibilityCSS: true });
    const s = getComputedStyle(el);
    return s.display !== 'none' && s.visibility !== 'hidden';
  }

  function kids(el) {
    const list = [];
    if (el.shadowRoot) list.push(...el.shadowRoot.children);
    list.push(...el.children);
    return list;
  }

  function line(el, role, indent) {
    let s = `${'  '.repeat(indent)}- ${role}`;
    const n = nameOf(el);
    if (n) s += ` "${n.replace(/"/g, "'")}"`;
    if (role === 'heading') s += ` (h${el.tagName[1] || '?'})`;
    if (role === 'link' && el.href) s += ` href="${el.href.slice(0, 120)}"`;
    const v = valueOf(el);
    if (v) s += ` value="${v}"`;
    if (el.disabled) s += ' (disabled)';
    return `${s} [${refOf(el)}]`;
  }

  function tree({ filter = 'interactive', refId, depth = 30, maxChars = 40000 }) {
    const root = refId ? byRef(refId) : document.body || document.documentElement;
    const out = [];
    let size = 0;
    let cut = false;
    const walk = (el, d, indent) => {
      if (cut || d > depth || !(el instanceof Element)) return;
      const tag = el.tagName.toLowerCase();
      if (['script', 'style', 'noscript', 'template', 'svg', 'head'].includes(tag)) return;
      if (el.getAttribute('aria-hidden') === 'true' || !visible(el)) return;
      const role = roleOf(el);
      let shown = false;
      if (role && (filter === 'all' ? role !== 'paragraph' || clean(el.innerText) : INTERACTIVE.has(role))) {
        const l = line(el, role, filter === 'all' ? indent : 0);
        size += l.length + 1;
        if (size > maxChars) { cut = true; return; }
        out.push(l);
        shown = true;
      }
      // Leaf interactive elements: their text is already in the name.
      if (shown && ['link', 'button', 'textbox', 'searchbox', 'combobox', 'listbox', 'heading', 'paragraph', 'option'].includes(role) && filter !== 'all') return;
      for (const c of kids(el)) walk(c, d + 1, shown ? indent + 1 : indent);
    };
    walk(root, 0, 0);
    if (cut) out.push(`(cut at ${maxChars} characters: use ref_id to read part of the page)`);
    return out.join('\n');
  }

  function find({ query }) {
    const words = clean(query, 300).toLowerCase().split(' ').filter((w) => w.length > 1);
    const scored = [];
    const walk = (el) => {
      if (!(el instanceof Element)) return;
      const tag = el.tagName.toLowerCase();
      if (['script', 'style', 'noscript', 'template', 'svg'].includes(tag)) return;
      if (!visible(el)) return;
      const role = roleOf(el);
      if (role && (INTERACTIVE.has(role) || role === 'heading')) {
        const hay = `${role} ${nameOf(el)} ${el.getAttribute('placeholder') || ''} ${el.getAttribute('name') || ''} ${el.id || ''}`.toLowerCase();
        let score = 0;
        for (const w of words) if (hay.includes(w)) score += w.length;
        if (score) scored.push({ score, el, role });
      }
      for (const c of kids(el)) walk(c);
    };
    walk(document.body || document.documentElement);
    scored.sort((a, b) => b.score - a.score);
    const top = scored.slice(0, 15).map((x) => line(x.el, x.role, 0));
    return top.length ? top.join('\n') : `Nothing on the page matches "${query}". Try read_page.`;
  }

  function deepFromPoint(x, y) {
    let el = document.elementFromPoint(x, y);
    while (el && el.shadowRoot) {
      const inner = el.shadowRoot.elementFromPoint(x, y);
      if (!inner || inner === el) break;
      el = inner;
    }
    return el;
  }

  function deepActive() {
    let el = document.activeElement;
    while (el && el.shadowRoot && el.shadowRoot.activeElement) el = el.shadowRoot.activeElement;
    return el;
  }

  // Ask-first list: pay/buy, send messages, post, delete, change account settings, upload.
  const RISK = [
    ['pay or buy', /\b(pay|payment|buy|purchase|checkout|check out|place (your )?order|order now|confirm (order|purchase|payment|booking)|complete (order|purchase|booking)|book now|reserve|place bid|bid now|pre-?order|rent now|add funds|donate|subscribe|upgrade|transfer|send money)\b/i],
    ['send a message or post', /\b(send|reply|reply all|forward|post|publish|tweet|retweet|repost|share now|comment|submit)\b/i],
    ['delete something', /\b(delete|remove|trash|discard|erase|clear (all|history|data)|deactivate|close (my )?account|unsubscribe|cancel (my )?(subscription|membership|order|plan))\b/i],
    ['change account settings', /\b(save (changes|settings|preferences|profile)|update (settings|profile|password|email|account)|change (password|email)|apply changes)\b/i],
    ['upload a file', /\b(upload|attach)\b/i],
  ];
  // Settings pages: judged from the address path only (not the domain or query).
  const SETTINGS_PAGE = /(^|[\/_.-])(settings?|account|preferences?|privacy|security|billing|profile\/edit)([\/_.-]|$)/i;
  const onSettingsPage = () => SETTINGS_PAGE.test(location.pathname);
  // Embedded frames this page can't look inside: payment, comment and chat widgets.
  const RISKY_FRAME = /(pay|checkout|stripe|braintree|adyen|klarna|afterpay|apple|wallet|billing|purchase|comment|disqus|chat|intercom|zendesk|messenger|crisp|drift|livechat|tawk|hubspot)/i;

  function labelOf(el) {
    return clean(el.getAttribute('aria-label') || el.innerText || el.value || el.title || el.getAttribute('alt') || '', 80);
  }

  function riskOfLabel(label) {
    for (const [what, re] of RISK) if (re.test(label)) return what;
    return null;
  }

  function riskOfElement(el) {
    if (!el) return { risky: false };
    const act = el.closest('button, a, input, select, summary, label, [role=button], [role=link], [role=menuitem], [role=switch], [role=checkbox], [role=radio], [role=option], [role=tab]') || el;
    const tag = act.tagName.toLowerCase();
    const type = (act.getAttribute('type') || '').toLowerCase();
    const label = labelOf(act);
    const fileInput = (tag === 'input' && type === 'file') || (tag === 'label' && act.control && act.control.type === 'file');
    if (fileInput) return { risky: true, what: 'upload a file', label: label || 'file upload' };
    if (tag === 'iframe') {
      const desc = `${act.src || ''} ${act.title || ''} ${act.name || ''} ${act.id || ''}`;
      return RISKY_FRAME.test(desc)
        ? { risky: true, what: 'act inside an embedded payment, comment or chat box (My Browser cannot see its buttons)', label: clean(act.title || act.src, 60) }
        : { risky: false, label: '' };
    }
    // Long link texts are headlines, not action buttons ("Should you buy a house...").
    let what = tag === 'a' && label.length > 30 ? null : riskOfLabel(label);
    // A bare Save/Update/Apply/Confirm on a settings page changes account settings.
    if (!what && onSettingsPage() && /^(save|update|apply|confirm|done|ok)\b/i.test(label)) what = 'change account settings';
    const isSubmit = (tag === 'button' && (type === '' || type === 'submit')) || (tag === 'input' && (type === 'submit' || type === 'image'));
    const form = act.form || act.closest('form');
    if (!what && isSubmit && form && /(checkout|pay|purchase|order|delete|remove|send|post|comment|reply|upload|settings|account)/i.test(form.getAttribute('action') || '')) {
      what = 'submit this form (its address suggests a payment, message, post, deletion, upload or settings change)';
    }
    const toggle = ['checkbox', 'radio', 'switch'].includes(roleOf(act)) || tag === 'select' || (tag === 'label' && act.control && ['checkbox', 'radio'].includes(act.control.type));
    if (!what && toggle && onSettingsPage()) what = 'change account settings';
    return what ? { risky: true, what, label } : { risky: false, label };
  }

  function riskEnter() {
    const ae = deepActive();
    if (!ae || ae === document.body) return { risky: false };
    const tag = ae.tagName.toLowerCase();
    if (tag === 'iframe') return { risky: true, what: 'press Enter inside an embedded frame (My Browser cannot see what it would do)', label: clean(ae.title || ae.src, 60) };
    const type = (ae.getAttribute('type') || 'text').toLowerCase();
    const editable = ae.isContentEditable || tag === 'textarea' ||
      (tag === 'input' && !['button', 'submit', 'reset', 'image', 'checkbox', 'radio', 'file', 'range', 'color'].includes(type));
    if (!editable) return riskOfElement(ae);
    const form = ae.form || ae.closest('form');
    const label = `${ae.getAttribute('aria-label') || ''} ${ae.getAttribute('placeholder') || ''} ${ae.getAttribute('name') || ''} ${ae.getAttribute('role') || ''} ${type}`;
    const searchy = /search|find|filter|query|url|address|\bq\b/i.test(label) || type === 'search';
    if (searchy) return { risky: false };
    // The field's own label: message, comment and chat boxes send on Enter.
    if (/message|comment|reply|chat|compose|write|tweet|post|caption/i.test(label)) {
      return { risky: true, what: 'send a message or post (Enter in a message box usually sends it)', label: clean(label) };
    }
    if (form) {
      const buttons = [...form.querySelectorAll('button:not([type]), button[type=submit], input[type=submit], input[type=image]')];
      for (const b of buttons) {
        const what = riskOfLabel(labelOf(b));
        if (what) return { risky: true, what, label: labelOf(b) };
      }
      if (/(checkout|pay|purchase|order|delete|send|post|comment|reply|upload|settings|account)/i.test(form.getAttribute('action') || '')) {
        return { risky: true, what: 'submit this form', label: clean(label) };
      }
      return { risky: false };
    }
    return { risky: true, what: 'send a message or post (Enter in a message box usually sends it)', label: clean(label) || 'text box' };
  }

  function refRect({ ref }) {
    const el = byRef(ref);
    el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
    const r = el.getBoundingClientRect();
    return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2), w: r.width, h: r.height };
  }

  function formInput({ ref, value, confirmed }) {
    const el = byRef(ref);
    const tag = el.tagName.toLowerCase();
    const type = (el.getAttribute('type') || '').toLowerCase();
    if (tag === 'input' && type === 'file') return { error: 'File uploads are not supported by My Browser.' };
    const risk = riskOfElement(el);
    if (risk.risky && !confirmed && (risk.what === 'change account settings' || tag === 'select' || ['checkbox', 'radio'].includes(type))) {
      return { needsConfirm: true, what: risk.what, label: risk.label || nameOf(el) };
    }
    el.scrollIntoView({ block: 'center', behavior: 'instant' });
    const fire = (t) => el.dispatchEvent(new Event(t, { bubbles: true }));
    if (tag === 'select') {
      const want = String(value).toLowerCase();
      const opt = [...el.options].find((o) => o.value.toLowerCase() === want) || [...el.options].find((o) => o.text.trim().toLowerCase() === want);
      if (!opt) return { error: `No option "${value}". Options: ${[...el.options].map((o) => o.text.trim()).join(', ').slice(0, 500)}` };
      el.value = opt.value;
      fire('input'); fire('change');
      return { ok: `Selected "${opt.text.trim()}" in ${nameOf(el) || 'list'}` };
    }
    if (tag === 'input' && (type === 'checkbox' || type === 'radio')) {
      const want = value === true || /^(true|yes|on|checked|1)$/i.test(String(value));
      if (el.checked !== want) el.click();
      return { ok: `${nameOf(el) || type} is now ${el.checked ? 'checked' : 'unchecked'}` };
    }
    if (tag === 'input' || tag === 'textarea') {
      el.focus();
      const proto = tag === 'input' ? HTMLInputElement.prototype : HTMLTextAreaElement.prototype;
      Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, String(value));
      fire('input'); fire('change');
      return { ok: `Set ${nameOf(el) || 'field'} to "${type === 'password' ? '(hidden)' : String(value).slice(0, 80)}"` };
    }
    if (el.isContentEditable) {
      el.focus();
      document.execCommand('selectAll', false);
      document.execCommand('insertText', false, String(value));
      return { ok: `Set ${nameOf(el) || 'text box'} text` };
    }
    return { error: `${ref} is a ${tag}, not a form field. Use computer with left_click instead.` };
  }

  try {
    return { value: run() };
  } catch (e) {
    return { pageError: String((e && e.message) || e) };
  }

  function run() {
  switch (cmd) {
    case 'text': {
      const body = document.body || document.documentElement;
      return { title: document.title, url: location.href, text: body ? body.innerText : '' };
    }
    case 'tree': return tree(args);
    case 'find': return find(args);
    case 'refRect': return refRect(args);
    case 'riskAt': return riskOfElement(deepFromPoint(args.x, args.y));
    case 'riskEnter': return riskEnter();
    case 'riskFocused': { const ae = deepActive(); return ae && ae !== document.body && !ae.isContentEditable && ae.tagName.toLowerCase() !== 'textarea' && !(ae.tagName.toLowerCase() === 'input' && !['button', 'submit', 'reset', 'image', 'checkbox', 'radio', 'file'].includes((ae.getAttribute('type') || 'text').toLowerCase())) ? riskOfElement(ae) : { risky: false }; }
    case 'formInput': return formInput(args);
    case 'info': return { title: document.title, url: location.href, w: innerWidth, h: innerHeight, dpr: devicePixelRatio };
    default: throw new Error('unknown page command ' + cmd);
  }
  }
}
