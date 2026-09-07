# Fanout Explorer bookmarklets

Two read-only bookmarklets that show the query fan-out behind a prompt: every web search the assistant ran, the pages each search returned and which of them were cited.

- ChatGPT Fanout Explorer, for chatgpt.com. Install page: https://www.oritmutznik.com/wp-content/uploads/2026/09/chatgpt-fanout-explorer-install.html. Write-up: https://www.oritmutznik.com/ai-workflows/chatgpt-fanout-explorer-bookmarklet
- Claude Fanout Explorer (write up incoming), for claude.ai. Install page: https://www.oritmutznik.com/wp-content/uploads/2026/09/claude-fanout-explorer-install.html. Write-up: coming soon

## Install from here

1. Open `chatgpt-fanout-explorer.bookmarklet.txt` (or the Claude one) and click the copy icon at the top right of the file view (Copy raw file).
2. In your browser, bookmark any page, then right-click that bookmark and choose Edit.
3. Replace its URL with what you copied and give it a name. Open a chat on chatgpt.com or claude.ai and click the bookmark.

## Files

- `chatgpt-fanout-explorer.min.js` and `claude-fanout-explorer.min.js`: The code the short bookmarklets on the install pages load through jsDelivr (`https://cdn.jsdelivr.net/gh/oritsimu-new/fanout-explorer@main/<file>`), so updates reach everyone without reinstalling.
- `chatgpt-fanout-explorer.js` and `claude-fanout-explorer.js`: The readable sources of the same code.
- `chatgpt-fanout-explorer.bookmarklet.txt` and `claude-fanout-explorer.bookmarklet.txt`: The standalone bookmarklets, with the full code inside one `javascript:` URL.

Nothing about your chats is sent anywhere: The code reads the conversation from the assistant's own API in your browser and keeps a copy in your browser's local storage.

Built by Orit Mutznik, https://www.oritmutznik.com. Feedback: https://www.linkedin.com/in/oritsimu
