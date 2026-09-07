# Fanout Explorer bookmarklets

Two read-only bookmarklets that show the query fan-out behind a prompt: every web search the assistant ran, the pages each search returned and which of them were cited.

- ChatGPT Fanout Explorer, for chatgpt.com. Install page: https://www.oritmutznik.com/wp-content/uploads/2026/09/chatgpt-fanout-explorer-install.html. Write-up: https://www.oritmutznik.com/ai-workflows/chatgpt-fanout-explorer-bookmarklet
- Claude Fanout Explorer, for claude.ai. Install page: https://www.oritmutznik.com/wp-content/uploads/2026/09/claude-fanout-explorer-install.html. Write-up: https://www.oritmutznik.com/ai-workflows/chatgpt-vs-claude-fan-outs

## Install from here

1. **Download and drag** (Mac and Windows, the simplest): Open `chatgpt-fanout-explorer-install.html` or `claude-fanout-explorer-install.html` above, click the download icon at the top right of the file view (Download raw file), open the downloaded file in Chrome, Edge or Brave and drag the blue button onto your bookmarks bar. The button is short, so it survives the drag on Windows and fetches the latest code from this repo each time you click it.
2. **Copy and paste** (best on Windows if the drag did not take, or if you prefer the standalone code): On the downloaded install page click Copy short version, bookmark any page, right-click that bookmark, choose Edit and paste over the URL. For the standalone code, which never contacts GitHub afterwards, open `chatgpt-fanout-explorer.bookmarklet.txt` or `claude-fanout-explorer.bookmarklet.txt`, click the copy icon at the top right of the file view (Copy raw file) and paste that as the URL instead.
3. **Console route** (company-managed browsers that block bookmarklets): Open a chat on chatgpt.com or claude.ai, press F12, open the Console tab, paste the contents of the matching `.bookmarklet.txt` file and press Enter. Chrome asks you to type `allow pasting` the first time. This runs the tool for that page only, so repeat it per chat.

Then open a chat on chatgpt.com or claude.ai and click the bookmark. The panel opens over the chat.

## Files

- `chatgpt-fanout-explorer-install.html` and `claude-fanout-explorer-install.html`: The install pages, the same files as on oritmutznik.com. Download, open, drag.
- `chatgpt-fanout-explorer.min.js` and `claude-fanout-explorer.min.js`: The code the short bookmarklets load through jsDelivr (`https://cdn.jsdelivr.net/gh/oritsimu-new/fanout-explorer@main/<file>`), so updates reach everyone without reinstalling.
- `chatgpt-fanout-explorer.js` and `claude-fanout-explorer.js`: The readable sources of the same code.
- `chatgpt-fanout-explorer.bookmarklet.txt` and `claude-fanout-explorer.bookmarklet.txt`: The standalone bookmarklets, with the full code inside one `javascript:` URL.

Nothing about your chats is sent anywhere: The code reads the conversation from the assistant's own API in your browser and keeps a copy in your browser's local storage.

Built by Orit Mutznik, https://www.oritmutznik.com. Feedback: https://www.linkedin.com/in/oritsimu
