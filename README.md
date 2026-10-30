# My Browser

Your own browser connector for the Claude PC app. Claude can read and use any website in your normal, logged-in Chrome. There's no site blocklist and no content filter in the extension. The only built-in check is the ask-first list: Claude must get your OK before it pays or buys anything, sends a message, posts, deletes, changes account settings or uploads a file.

- Uses your normal Claude subscription. No API key, no extra cost.
- Works only on your own PC. The extension talks only to the My Browser program on `127.0.0.1`. Nothing is sent anywhere except the websites you browse.
- Tool names match the official Claude in Chrome connector: `tabs_context_mcp`, `tabs_create_mcp`, `tabs_close_mcp`, `navigate`, `get_page_text`, `read_page`, `find`, `computer`, `form_input`, `javascript_tool`.

## Install on Windows (9 steps)

1. On GitHub, open this repo's `release` folder and download both files: `my-browser-extension.zip` and `my-browser.mcpb`.
2. Unzip `my-browser-extension.zip` into a folder you'll keep, for example `Documents\My Browser`. Chrome loads the extension from that folder, so don't delete it.
3. In Chrome, go to `chrome://extensions` and switch on **Developer mode** (top right).
4. Click **Load unpacked** and choose the `my-browser-extension` folder. Pin **My Browser** to the toolbar (puzzle-piece icon > pin).
5. Open the Claude PC app, go to **Settings > Extensions**, and install `my-browser.mcpb`. You can also double-click the file, or drag it onto that screen. Click **Install**.
6. Quit Claude completely (system tray icon > Quit) and open it again.
7. In Chrome, the My Browser icon should show a green **ON** badge, and its popup should say "Connected to the Claude app".
8. In a chat, open the tools/connectors menu and make sure **My Browser** is on. For your first test, switch **Claude in Chrome** off so Claude can't mix the two up.
9. Test it: ask "Use My Browser to open reddit.com and tell me the top post titles." Or run the diagnosis prompt below.

Menu names in steps 5 and 8 may differ slightly in your version of the app (unverified, model's own knowledge).

### If step 5 doesn't work (plan B: manual setup)
1. Install Node.js LTS from nodejs.org.
2. Rename `my-browser.mcpb` to `my-browser.zip`, then unzip it into `Documents\My Browser\host`.
3. In Claude, go to **Settings > Developer > Edit Config** and add:
   ```json
   {
     "mcpServers": {
       "my-browser": {
         "command": "node",
         "args": ["C:\\Users\\YOUR-NAME\\Documents\\My Browser\\host\\server.js"]
       }
     }
   }
   ```
   If your edits seem to have no effect: the Microsoft Store version of Claude may read a different copy of this file, under `%LOCALAPPDATA%\Packages\...` rather than `%APPDATA%\Claude`.
4. Quit Claude from the tray and reopen it. If it still doesn't connect, logs are in `%APPDATA%\Claude\logs\mcp-server-my-browser.log`.

Plan C (Claude Code): `claude mcp add my-browser -- node "C:\Users\YOUR-NAME\Documents\My Browser\host\server.js"`

### Cowork
Anthropic's help pages say Cowork supports local connectors. Some users have reported that a Claude Desktop build didn't pass them through to Cowork. If My Browser shows up in a normal chat but not in Cowork, use a normal chat or Claude Code.

## Using it

- **Toolbar icon:**
  - **On** switch: off means Claude can't use the browser at all.
  - **Stop**: cancels what Claude is doing right now. Claude is told to stop and ask you.
  - **Share this tab with Claude**: Claude can only use tabs in the orange "My Browser" tab group. It opens its own tabs there, and this button adds the tab you're looking at.
  - **Recent actions**: the last 20 tool calls.
- **Ask-first list:** when Claude tries to pay or buy, send a message, post, delete, change account settings or upload, the tool stops with "NEEDS CONFIRMATION" and nothing happens. Claude has to ask you in the chat, and only after your yes repeats the action with `confirmed: true`. How it's detected:
  - Button text, such as Pay, Buy, Place order, Send, Post, Reply, Comment, Submit, Delete, Remove, Save changes or Upload.
  - File-upload fields.
  - Toggles on settings and account pages.
  - Enter pressed in a message box. Enter in a search box is fine.

  It's a strong guard, not a perfect one: a site can label a button in an unusual way. Some harmless buttons, like a Reply button that only opens a reply box, will also ask.
- **Chrome's own limits:** no extension can control `chrome://` pages, the Chrome Web Store or other extensions' pages. While Claude is clicking or typing, Chrome shows a "My Browser started debugging this browser" bar. It goes away a minute after the last action. Don't click Cancel on it mid-task, because that stops the action.
- **Hidden instructions on web pages:** page text is passed to Claude marked as website content, so Claude treats it as information, not instructions. That lowers the risk; it doesn't remove it.
- **One Claude app at a time:** if two Claude apps run My Browser at once (say Claude Desktop and Claude Code), the second one reports that the port is in use.

## Diagnosis prompt (for the install check)

Paste this into a new chat with My Browser on (and Claude in Chrome off):

```text
Use the My Browser tools only. Read only: don't log in, post, click buttons, change settings or read my private content. For each URL, open it in a My Browser tab and record: loaded yes/no, exact error text, page title. If one fails, try once more, never a third time.
https://example.com
https://en.wikipedia.org/wiki/Chrome
https://www.reddit.com
https://old.reddit.com
https://www.reddit.com/r/chrome
https://www.google.com
https://www.google.com/search?q=test
https://docs.google.com
https://mail.google.com (title only, read nothing)
Then give me a table: URL | loaded | exact error or title. Don't guess causes; write "not in what I have" if the tests don't show it.
```

Done means all 9 load. A site's own captcha or "are you a robot" page counts as the site's doing, not a My Browser block.

## How it fits together

```
Claude PC app  --MCP (stdio)-->  My Browser program (host/server.js, on your PC)
                                       |  WebSocket, 127.0.0.1 only; only the My Browser
                                       |  extension's ID is accepted
                                       v
                                 My Browser extension (extension/) in your Chrome
```

- `extension/`: the Chrome extension (Manifest V3). `tools.js` holds the tools, `page.js` runs inside pages, `background.js` holds the link and the on/off and Stop logic, and `popup.*` is the toolbar popup.
- `host/`: the program on your PC (Node.js, one dependency: `ws`). `manifest.json` describes the `.mcpb` installer.
- `release/`: the files to download.
- `tests/`: end-to-end tests. They start Chromium with the extension, start the program through a real MCP client, and check every tool, including the ask-first list. Run `cd host && npm install`, then `cd ../tests && npm install && node run.mjs`. Add `DPR=1.5` to test screen scaling.

To rebuild the installer after changing `host/`: `npx @anthropic-ai/mcpb pack host release/my-browser.mcpb`.
