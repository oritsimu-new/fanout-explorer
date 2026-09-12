# Fanout Explorer bookmarklets

Three free, read-only bookmarklets that show the query fan-out behind an AI answer: the web searches ChatGPT, Claude or Gemini runs for a prompt, the pages they get back and which ones they cite.

- ChatGPT Fanout Explorer, for chatgpt.com. Install page: https://www.oritmutznik.com/wp-content/uploads/2026/09/chatgpt-fanout-explorer-install.html
- Claude Fanout Explorer, for claude.ai. Install page: https://www.oritmutznik.com/wp-content/uploads/2026/09/claude-fanout-explorer-install.html
- Gemini Fanout Explorer, for gemini.google.com. Install page: https://www.oritmutznik.com/wp-content/uploads/2026/09/gemini-fanout-explorer-install.html
- All three on one page: https://www.oritmutznik.com/wp-content/uploads/2026/09/fanout-explorer.html
- Write-up: https://www.oritmutznik.com/ai-workflows/chatgpt-vs-claude-fan-outs

## What each one shows

- ChatGPT: every query, every page each search returned, which were cited, the freshness window and any single site the search was limited to. Fills batch by batch as it answers, plus saved chats.
- Claude: every query and every page it opens, the pages returned and which were cited, exact per query. Fills query by query as it answers, plus saved chats.
- Gemini: the search queries Gemini hides in its interface plus every source it cited, with how much of the answer each backs. Gemini does not expose the pages it read and dropped, or a freshness window. It fills once the answer is saved, plus saved chats.

## Install from here

1. **Download and drag** (simplest): Open the install page for the tool you want and drag its blue button to your bookmarks bar. For ChatGPT and Claude that button is short and loads the latest code from this repo through jsDelivr. Gemini blocks code loaded from other sites, so its button is the whole tool in one bookmark (standalone).
2. **Copy and paste**: On the install page click the copy button, bookmark any page, right-click it, choose Edit and paste over the URL. The `.bookmarklet.txt` files here are the same standalone code, if you prefer to copy it straight from GitHub (Copy raw file).
3. **Console route** (company-managed browsers that block bookmarklets): Open a chat, press F12, open the Console tab, paste the contents of the matching `.bookmarklet.txt` file and press Enter. Chrome asks you to type `allow pasting` the first time.

## Files

- `chatgpt-fanout-explorer.min.js`, `claude-fanout-explorer.min.js`: The code the short ChatGPT and Claude bookmarklets load through jsDelivr (`https://cdn.jsdelivr.net/gh/oritsimu-new/fanout-explorer@main/<file>`), so updates reach everyone without reinstalling.
- `gemini-fanout-explorer.min.js`: The Gemini code. Gemini blocks remote loading, so this is used by the console route and for reading, not by a short bookmarklet.
- `chatgpt-fanout-explorer.js`, `claude-fanout-explorer.js`, `gemini-fanout-explorer.js`: The readable sources.
- `chatgpt-fanout-explorer.bookmarklet.txt`, `claude-fanout-explorer.bookmarklet.txt`, `gemini-fanout-explorer.bookmarklet.txt`: The standalone bookmarklets, with the full code inside one `javascript:` URL.
- `*-install.html`: The install pages. `fanout-explorer.html` is the one page with all three.

Nothing about your chats is sent anywhere: Each tool reads the conversation from the assistant's own API in your browser and keeps a copy in your browser's local storage.

Built by Orit Mutznik, https://www.oritmutznik.com. Feedback: https://www.linkedin.com/in/oritsimu
