# My Browser: audit 2 (page walking and tab-edit retry)

Audited 30 Oct 2026 against commit 3a50aae (diff from 14f5e4f). No code was changed. The test suite passes (74/74). I ran the experiments with the real extension and host in headless Chromium, using the tests/run.mjs pattern on local pages, including a shreddit-style imitation. Scripts and pages are in `/tmp/claude-0/-home-user/7d9ed1ca-0f86-5c5f-84a5-3080f211f962/scratchpad/audit2/`.

## Verdict

Both changes are correct, and change (a) very likely fixes the Reddit symptoms. Elements are still missed in five verified cases: closed shadow roots, web-component buttons whose label is slotted, `display:contents` links, content deeper than 30 levels, and iframes. Two of these also open new holes in the ask-first check.

## Does (a) fix the Reddit symptoms?

**Very likely yes, though not proven on live Reddit.**
- **Why it fails today:** the old `visible()` called `checkVisibility()`, which returns false for any `display:contents` element. That dropped the element and everything inside it.
- **Reproduced:** I built an imitation page with `faceplate-tracker{display:contents}` wrappers around feed posts. Each post was a `shreddit-post` with an open shadow root and slotted title links. With the old page.js, read_page and find returned **0 post links**. With the new one they return all of them (`exp3.mjs`).
- **Search bar:** a nested open-shadow search bar (`reddit-header-large` > `reddit-search-large` > `faceplate-search-input` > `input`, behind a `display:contents` div) is now found by `find "search"` and `find "search box"` (`exp1.mjs`).
- **Unverified:** whether real Reddit wraps its feed and header this way. I believe it does (faceplate/shreddit components, mostly open shadow roots), but that is general knowledge. My fetch of reddit.com got a bot-check page, and I did not try to get around it.

**Checked and fine (verified):**
- **No duplicates:** walking both `el.shadowRoot.children` and `el.children` lists slotted content once.
- **Hidden content stays out:**
  - unslotted light-DOM children, including a `display:contents` one
  - content slotted into a slot inside a `display:none` part of the shadow tree
  - slot fallback content when nodes are assigned
  - closed `<details>`
  - `display:none`
  - `visibility:hidden` subtrees (a `visibility:visible` child is listed, as intended)

  The pruning comes from the `checkVisibility()` call on boxed elements.
- **`content-visibility:auto`:** off-screen content is still listed, because default `checkVisibility()` ignores it.
- **Ask-first is unchanged:** the diff doesn't touch the risk code. Refs are only given to 'show' elements.
- **The 40,000-character cap:** it cuts cleanly with a note. On a feed it allows about 660 interactive refs, roughly 60 posts at about 10 refs each.
- **aria-hidden:** read_page skips `aria-hidden="true"` subtrees, but find doesn't. This is inconsistent, but it was the same before and has little effect.

**To confirm on the owner's PC:** after updating, run read_page (interactive) and `find "search"` on r/chrome again. If posts are still missing, run this through javascript_tool and send me the output. It counts open shadow roots, `display:contents` wrappers, custom elements that look like closed roots, and the depth of the search box and post links:
```js
(() => { let els = 0, open = 0, contents = 0, maxD = 0, likelyClosed = 0; const search = [], posts = [];
  const walk = (r, d) => { for (const e of r.children) { els++; if (d > maxD) maxD = d;
    if (getComputedStyle(e).display === 'contents') contents++;
    if (e.localName.includes('-') && !e.shadowRoot && !e.children.length && e.getBoundingClientRect().width > 0) likelyClosed++;
    if (/search/i.test((e.getAttribute('placeholder') || '') + ' ' + (e.getAttribute('aria-label') || ''))) search.push(e.localName + ' depth ' + d + (e.shadowRoot ? ' (host)' : ''));
    if (e.localName === 'a' && /\/comments\//.test(e.getAttribute('href') || '') && posts.length < 3) posts.push('depth ' + d);
    if (e.shadowRoot) { open++; walk(e.shadowRoot, d + 1); } walk(e, d + 1); } };
  walk(document.body, 1); return JSON.stringify({ els, open, contents, maxD, likelyClosed, search: search.slice(0, 5), posts }); })()
```

## Findings (most severe first)

### 1. MEDIUM: Web-component buttons with a slotted label have no name, and ask-first misses off-text clicks on them
- **Where:**
  - `extension/page.js:79` (`nameOf` uses `innerText` / `textContent`)
  - `:211-213` (`labelOf`)
  - `:181-189` (`deepFromPoint`)
- **Why:** `innerText` and `textContent` don't follow slots or enter shadow roots. Take `<x-btn>Buy now</x-btn>`, whose shadow is `<button><slot></slot></button>`. The inner `<button>`'s innerText is `""` (measured).
- **Verified (`exp2.mjs`):**
  - read_page lists these as `- button [ref_1]` with no name.
  - `find "buy"` returns "Nothing on the page matches".
  - A coordinate click on the button's padding hits the inner `<button>` and gets label `""`. "Buy now" and "Post" were both clicked with **no NEEDS CONFIRMATION**. A click on the text itself does ask.
  - A light-DOM `<button>` whose text sits in a child element's shadow root also gets no name.
  - The same applies when the control is inside a shadow root and its accessible name (aria-label or placeholder) is on the host. A host with `aria-label="Search Reddit"` around a bare `<input name="q2">` is listed as `textbox "q2"`.
- **Who it hits:** Lit, Shoelace and Material Web buttons. Whether Reddit's own faceplate buttons are built this way is unverified.
- **Smallest fix:**
  1. Add a flat-tree text helper:
     ```js
     const flatText = (n) => n.nodeType === 3 ? n.data : n.nodeType !== 1 || /^(style|script)$/.test(n.localName) ? '' :
       n.localName === 'slot' ? [...(n.assignedNodes({ flatten: true }).length ? n.assignedNodes({ flatten: true }) : n.childNodes)].map(flatText).join(' ') :
       [...(rootOf(n) || n).childNodes].map(flatText).join(' ');
     ```
     `rootOf` comes from finding 2.
  2. Use `clean(flatText(el))` in `nameOf` and `labelOf` when `innerText` is empty.
  3. In `nameOf`, if the element has no name and `el.getRootNode().host` exists, fall back to the host's `aria-label` or `placeholder`.

### 2. MEDIUM: Closed shadow roots are invisible to read_page and find, and to ask-first (full click bypass)
- **Where:**
  - `extension/page.js:108-113` (`kids`)
  - `:181-189` (`deepFromPoint`)
  - `:191-195` (`deepActive`)

  All three use `el.shadowRoot`, which is `null` for `mode:'closed'`.
- **Verified (`exp1.mjs`):**
  - An `<input type="search" placeholder="Closed search box">` in a closed root is missing from read_page. `find "closed search"` doesn't return it.
  - A "Pay now" `<button>` in a closed root was clicked by coordinate with **no NEEDS CONFIRMATION** (the page title changed to `paid-closed`). The check saw only the host, whose innerText is `""`.
  - `chrome.dom.openOrClosedShadowRoot` **is** available in the world `chrome.scripting.executeScript` runs in. I checked this from the service worker: it returned the closed root's HTML.
- **How common:** closed roots are uncommon on big sites. I believe Reddit's are open, but that is unverified.
- **Smallest fix:**
  1. Add a helper inside `pageAgent`: `const rootOf = (el) => el.shadowRoot || (globalThis.chrome && chrome.dom && chrome.dom.openOrClosedShadowRoot ? chrome.dom.openOrClosedShadowRoot(el) : null);`
  2. Use it in `kids`, `deepFromPoint` and `deepActive`.

### 3. LOW-MEDIUM: read_page silently drops everything deeper than 30 levels
- **Where:** `extension/page.js:133` (`d > depth` returns with no note)
- **How depth counts:** every element adds a level, including roleless and `display:contents` wrappers. Each shadow-host hop adds one too.
- **Verified:** a link 37 levels deep is missing from both read_page modes. There is no "cut" message, so Claude thinks the page has no such link. `find` (which has no depth limit) does find it.
- **Who it hits:** Gmail and other deeply nested apps could reach this (unverified). Reddit's feed links are probably at about 10-15 levels.
- **Smallest fix:**
  - When `d > depth` and the element has children, set a flag. Then append "(parts of the page deeper than N levels were left out: pass a larger depth or a ref_id)".
  - Optionally, don't count 'pass' or roleless levels toward `depth`. The 40k cap already bounds the output.

### 4. LOW: Links and buttons that are themselves `display:contents` are never listed
- **Where:**
  - `extension/page.js:103` and `:139` / `:166`: 'pass' elements get `role = null`.
  - `:279-284`: `refRect` would return 0×0 for such an element.
- **Verified:**
  - `<a href="/c" style="display:contents"><span>Contents link</span></a>` and `<div role="button" tabindex="0" style="display:contents">` are missing from read_page.
  - `find "contents"` returns nothing.
  - The children are walked, but plain spans have no role, so nothing is listed.
  - Chrome keeps these elements in the accessibility tree and they are clickable.
- **Smallest fix:**
  1. For `display:contents`, still compute `roleOf(el)` and list it if it is interactive.
  2. In `refRect`, when `getBoundingClientRect()` is 0×0, measure with a Range instead: `const rg = document.createRange(); rg.selectNodeContents(el); r = rg.getBoundingClientRect()`.

### 5. LOW (change b): A tab that can't be added to the group is left behind as an orphan, and each retry adds one more
- **Where:** `extension/tools.js:208-210` (`tabs_create_mcp`) and `:196-198` (`createIfEmpty`)
- **Verified (`exp4.mjs`):** I made `chrome.tabs.group` throw the real drag error.
  - `tabs_create_mcp` fails after about 2 s, but the tab it already created stays open. It is active, loaded and ungrouped.
  - Claude can't see or close it (tabs_context_mcp lists only the grouped tabs).
  - Each retry by Claude adds another such tab.
  - When the error only lasts a short while (create failed 3 times, group failed twice), the retry works and exactly one tab is made.
- **The rest of (b) is right:**
  - The regex matches Chrome's message.
  - Only edit calls are wrapped: `tabs.create`, `update`, `remove`, `group`, `ungroup` and `tabGroups.update`. Read calls (`get`, `query`, `tabGroups.query`) don't raise this error.
  - Retrying `tabs.create` cannot double-create. Chrome rejects the call before making the tab. This is from Chrome source as I remember it, unverified.
  - No edit call is missed.
- **Smallest fix:**
  - Wrap `shareTab(tab.id)` in `try/catch`. On failure, run `await tabEdit(() => chrome.tabs.remove(tab.id)).catch(() => {})` and rethrow.
  - Consider a longer window (for example 25 × 200 ms), since a real tab drag can last more than 2 s.

### 6. LOW: Content inside iframes isn't read
- **Where:** `extension/tools.js:92` (executeScript runs in the top frame only) and `extension/page.js:108` (`kids` doesn't enter frames)
- **Verified:** a same-origin iframe's "Iframe link" and "Iframe button" don't appear in read_page or find, and the `<iframe>` itself isn't mentioned. The previous audit covered iframes only for ask-first.
- **Who it hits:** embedded forms, login and consent widgets, comment and chat widgets. Gmail, Google Search, YouTube and X keep their main UI outside iframes (general knowledge, unverified).
- **Smallest fix:** list frames in read_page as `- iframe "title" src="…"`, so Claude knows to use a screenshot and coordinates there. Full support would need `allFrames: true` and frame IDs in refs.

### 7. LOW: Bare IP addresses get `https://`, so router and local pages fail with a misleading message
- **Where:** `extension/tools.js:137-142` (`normalizeUrl`)
- **Verified:**
  - `navigate` to `127.0.0.1:8124/names.html` (an http-only server) went to `https://…`. The reply said "the site is down, there is no internet, or the network blocked it".
  - The same happens with `192.168.1.1` for a home router admin page.
  - `localhost:8124` works, because Chrome fixes it up.
- **Smallest fix:** use `http://` when the host is an IP address or `localhost`. For example, `/^(\d{1,3}(\.\d{1,3}){3}|localhost)(:\d+)?(\/|$)/i.test(url) ? 'http://' + url : 'https://' + url`.

## Performance (question 3)

There is no realistic risk of the 15 s page timeout. I measured in headless Chromium on Linux with the extension and host in the loop, using a shreddit-like feed: each post has an open shadow root, slots and `display:contents` wrappers.

| Feed | read_page interactive | read_page all | find (whole page) | get_page_text |
|---|---|---|---|---|
| 200 posts, 7.8k elements | 35 ms | 29 ms | 40 ms | 15 ms |
| 1,000 posts, 39k elements | 24 ms | 41 ms | 224 ms | 60 ms |
| 3,000 posts, 117k elements | 23 ms | 72 ms | 674 ms | 44 ms |

- **read_page:** stops at the 40k-character cap, so its cost stays flat.
- **find:** always walks the whole page (calling `getComputedStyle` and `checkVisibility` on every element), so its cost grows with page size. It is about 6 µs per element here.
- **The old code** looked faster only because it skipped the feed (0 refs).
- **On Windows:** a slower PC with heavy site CSS could be several times slower and still stay well under 15 s. Not measured on Windows.

## What I could not check
- **Live sites:** live Reddit, Gmail, Google Search, YouTube and X. reddit.com gave this sandbox a bot-check page, and I did not try to get around it. Everything I say about their markup (shreddit and faceplate components, open vs closed roots, `display:contents` wrappers, nesting depth) is general knowledge, unverified. The snippet above lets the owner check on their PC.
- **Real tab drags:** I couldn't raise the real "user may be dragging a tab" condition in headless Chromium. I simulated it by overriding `chrome.tabs.create` and `chrome.tabs.group` in the service worker. I also couldn't check which Chrome calls raise it on Windows, or whether `tabs.create` rejects before creating the tab (I believe so, from Chrome source).
- **Windows performance:** timings with real site CSS and many tabs open.
- **Claude Desktop:** its own tool-call timeout compared with these waits.

---

## Fix round (30 Oct 2026, 05:34 PM IST)

| # | Finding | Outcome |
|---|---|---|
| 1 | Web-component buttons with a slotted label have no name (and an ask-first gap) | **Fixed.** Names and ask-first labels now read text through slots and shadow roots, and fall back to the host's aria-label or placeholder. Tested: read_page shows button "Buy now", and a click on its padding asks first. |
| 2 | Closed shadow roots invisible (and an ask-first gap) | **Fixed.** read_page, find, the click check and the Enter check look inside closed roots via chrome.dom.openOrClosedShadowRoot. Tested: a closed-root search box is found, and a closed-root "Pay now" asks first. |
| 3 | read_page drops content deeper than 30 levels silently | **Fixed.** Depth now counts listed elements only (wrappers and shadow hops are free), and a note appears if anything is cut. Tested with a link 40 levels deep. |
| 4 | display:contents links and buttons never listed | **Fixed.** They're listed, and clicks by ref measure their contents. Tested: listed and clicked by ref. |
| 5 | A tab that can't join the group is left behind | **Fixed.** The tab is closed again with a clear error, and the busy-tab retry now lasts up to 5 s. Tested by simulating the error. |
| 6 | iframe contents not read, frame not mentioned | **Fixed (mention).** read_page lists frames with their title and address, plus a note to use a screenshot and clicks there. Reading inside frames is not done. |
| 7 | Bare IP addresses opened over https | **Fixed.** localhost and IP addresses open over http. Tested. |
| - | Found during this round: Chrome's closed-root lookup throws on SVG icons, which broke find on pages with icon buttons | **Fixed** (guarded) before release. Tested. |

Tests: 86/86 at 1200x800 (1x and 2x) and 1920x1080 (1.5x). host/ is unchanged, so my-browser.mcpb is unchanged. Only the extension zip was rebuilt.

## Still open
1. **Live check on your PC:** reload the extension, then rerun find "search" and read_page on reddit.com/r/chrome. The fix is tested on a Reddit-like page only.
2. **Same-origin iframe contents** are listed but not read. Use screenshots there.
3. **The real tab-drag condition** is only simulated here.
4. **Claude app permission prompts:** these are the Claude app's own setting, not My Browser's. Choose "Always allow" in the prompt or in the extension's settings.
