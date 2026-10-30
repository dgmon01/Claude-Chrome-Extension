# Plan: custom Claude browser connector ("My Browser")

Status: PLAN ONLY, waiting for Dhanush's go. Nothing is built yet.
Written 30 Oct 2026, 2:46 PM IST.

## 1. Why we're building this

The official Claude in Chrome extension refuses every reddit.com page with "This site is not allowed due to safety restrictions." The diagnosis run on 30 Oct 2026 confirmed it: Reddit fails 3 of 3, while Google, Docs, Gmail, Wikipedia and example.com all load. It's a known problem since 18 Sep 2026 (GitHub issue anthropics/claude-code#95326). No setting fixes it.

Goal: our own connector that lets the Claude PC app read and use any website in your normal, logged-in Chrome, with no domain blocklist.

## 2. How the official connector works (from GitHub and primary sources)

What we copy:
- **Three parts:** a Chrome extension, a small program on your PC, and Claude.
  - Claude Code installs a Chrome "native messaging host": a JSON file in Chrome's NativeMessagingHosts folder that points to a launcher (`~/.claude/chrome/chrome-native-host`) and allowlists the extension's ID.
  - Claude Desktop (Cowork) registers its own host for the same extension. [Claude Code docs: Chrome][docs-chrome], [issue 20411][i20411]
- **Tools Claude gets:** `tabs_context_mcp`, `tabs_create_mcp`, `tabs_close_mcp`, `navigate`, `computer` (click, type, scroll, screenshot), `read_page` (accessibility tree with element refs), `get_page_text`, `find`, `form_input`, `javascript_tool`, `read_console_messages`, `read_network_requests`, `file_upload`, `upload_image`, `resize_window`, `gif_creator`, `shortcuts` and `browser_batch`. Your diagnosis run listed the same names. Claude calls `tabs_context_mcp` first to get a tab ID. Claude only sees tabs in its own tab group.
- **Site checks:** every address is checked against "Anthropic's site safety list".
  - Some categories are always blocked: adult and pirated content, and in some versions of the help article also banking, trading and crypto.
  - Every other domain needs your approval, and Team/Enterprise admins can add allow and block lists. [Help: using Claude in Chrome safely][help-safe], [Claude Desktop browser docs][desk-browser]
  - A third-party clone says the official extension blocks 58 domains. Not checked: not in what I have.

What we change:
- **No domain blocklist.** Every site can be browsed.
- **We own both the extension and the PC program,** so an Anthropic update can't switch a site off.
- **No API key, no extra cost.** It runs through your normal Claude subscription in the PC app.

## 3. Options considered (cheapest first)

| Option | Build cost | Blocklist | Notes |
|---|---|---|---|
| A. Google's `chrome-devtools-mcp --autoConnect` | none: one config line | none | Official Google tool. Attaches to your running Chrome (Chrome 146+, turn on at `chrome://inspect/#remote-debugging`). Not custom. Gives the agent the whole browser. [guide][cdm] |
| B. Microsoft's Playwright MCP `--extension` | none: install the extension and one config line | none | Official Microsoft tool. Connects to a tab you pick in your logged-in Chrome. Extension v0.1.0 is early. [docs][pw] |
| C. Fork `noemica-io/open-claude-in-chrome` | small | none | MIT-licensed clean-room copy with the same 18 tools. Third-party, unreviewed, built for Claude Code. [repo][occ] |
| **D. Build our own (this plan)** | medium | none | Fully yours. Tool names match the official ones so Claude already knows how to use them. |

**Recommendation:** D, because you asked for it to be custom made. Keep A as the plan B if D gets stuck: it's free and needs no code.

## 4. What we build (option D)

### 4.1 Chrome extension (Manifest V3), folder `extension/`
- **Permissions:** `tabs`, `tabGroups`, `scripting`, `debugger`, `storage`, `activeTab`, and host permission `<all_urls>`. No blocklist.
- **Background service worker** connects to the PC program over a local WebSocket (`ws://127.0.0.1:<port>`) using a secret token made at install. It refuses anything without the token.
- **Tools** (same names and inputs as the official ones):
  - Tabs: `tabs_context_mcp`, `tabs_create_mcp`, `tabs_close_mcp`.
  - Reading: `navigate`, `get_page_text`, `read_page`, `find`.
  - Acting: `computer` (click, type, key, scroll, screenshot, using `chrome.debugger` input events and `captureVisibleTab`), `form_input`, `javascript_tool`.
  - Later, only if you want them: console and network reading, uploads, GIFs.
- **Tab group:** Claude works in its own "My Browser" tab group. You can also share any tab by clicking the toolbar icon.
- **Toolbar icon:**
  - An on/off switch (kill switch).
  - A small log of the last 20 actions.
  - A "Stop" button that halts whatever Claude is doing.
- **Limits Chrome sets for every extension** (unverified, model's own knowledge): it can't control `chrome://` pages, the Chrome Web Store, or other extensions' pages. While `chrome.debugger` is in use, Chrome shows a "started debugging this browser" bar.

### 4.2 PC program (MCP server), folder `host/`, Node.js
- **Connection to Claude:** it talks to Claude over standard MCP (stdio) and to the extension over the local WebSocket. It listens only on 127.0.0.1, never on the network.
- **Packaging:** it's packaged as a `.mcpb` desktop extension so it installs from Claude Desktop's connectors screen. Help-center docs say Cowork supports local MCP servers and `.mcpb` extensions. [Cowork help][cowork]
  - Plan B: a manual entry in `claude_desktop_config.json`.
  - Plan C: Claude Code (`claude mcp add`).

### 4.3 Safety we keep (not a site blocklist)
- **Ask first:** Claude must get your OK in the chat before it:
  - pays or buys anything
  - sends emails or messages
  - posts or comments
  - deletes anything
  - changes account settings
  - uploads files

  The tool replies "needs confirmation" until Claude calls again with `confirmed: true`.
- **Prompt injection warning:** web pages can hide instructions aimed at AI. Page text is returned marked as page content, not instructions. Unverified (model's own knowledge): this lowers the risk but doesn't remove it.
- **No hidden data collection:** no analytics, no remote server, nothing sent anywhere except between Chrome, the PC program and the Claude app.
- **Same rules as ever:** Anthropic's usage rules still apply to what Claude agrees to do. Removing the blocklist doesn't change that.

## 5. Stages, models and checks

| Stage | Work | Who | Check |
|---|---|---|---|
| 1 | Extension skeleton, WebSocket link, token, tab group | Sonnet (build) | Loads in Chromium here with 0 errors; link connects |
| 2 | Reading tools: tabs, navigate, get_page_text, read_page, find | Sonnet | Automated test on local test pages in this container |
| 3 | Action tools: computer, form_input, javascript_tool, plus ask-first rule | Sonnet | Test form page: click, type, submit; risky action blocked until confirmed |
| 4 | MCP server, `.mcpb` package, README (Windows) | Sonnet | An MCP client here lists every tool and runs each one |
| 5 | Review and audit | Fable (strongest), blind to the build chat | Audit report; one fix round only |
| 6 | You install on your PC and rerun the diagnosis prompt | You | See done list below |

Progress line per stage in `progress-log.md` (AM/PM IST). Two tries per item, then a short status.

## 6. Done means (tolerances)
1. The extension shows 0 errors on `chrome://extensions`.
2. The connector appears in Claude Desktop with every tool from stage 1–3 listed.
3. All 9 diagnosis URLs load and their page text can be read, Reddit included.
   - Tolerance: a site's own captcha or "are you a robot" page is logged, not counted as our failure.
4. The Gmail tab title reads while logged in (no email content read during tests).
5. Click, type and submit work on a test form.
6. Risky actions stop and ask first.
7. The README has install steps you can follow in 10 steps or fewer on Windows.

## 7. Not touching / not adding
- The prompt-gen-10.9 repo.
- The official Claude in Chrome extension: leave it installed. Ours uses a different connection, so they shouldn't clash (to be checked in stage 6).
- No Chrome Web Store listing, no analytics, no remote server, no API key, no extra tools beyond section 4.

## 8. Plan B for every tool or risk
| Risk | Plan B |
|---|---|
| Cowork can't see local connectors (reported in some builds: [issue 26259][i26259]) | Use Desktop Chat mode or Claude Code. Later: an HTTP bridge. |
| `.mcpb` install fails | Manual `claude_desktop_config.json` (on Windows check the MSIX path: `%LOCALAPPDATA%\Packages\...` vs `%APPDATA%\Claude`) |
| `chrome.debugger` clicks blocked or unreliable | Content-script clicks through `chrome.scripting` (less robust) |
| Port taken | Port set in the config |
| No Node on your PC | `.mcpb` uses Claude Desktop's bundled Node (unverified, model's own knowledge); else install Node LTS |
| Whole build stuck after two tries | Option A (`chrome-devtools-mcp --autoConnect`) |

## 9. Still open
See the questions in the chat message of 30 Oct 2026.

[docs-chrome]: https://code.claude.com/docs/en/chrome
[i20411]: https://github.com/anthropics/claude-code/issues/20411
[help-safe]: https://support.claude.com/en/articles/12902428-using-claude-in-chrome-safely
[desk-browser]: https://claude.com/docs/third-party/claude-desktop/browser
[cdm]: https://lilting.ch/en/articles/chrome-devtools-mcp-active-session
[pw]: https://playwright.dev/mcp/configuration/browser-extension
[occ]: https://github.com/noemica-io/open-claude-in-chrome
[cowork]: https://support.claude.com/en/articles/10949351-getting-started-with-cowork
[i26259]: https://github.com/anthropics/claude-code/issues/26259
