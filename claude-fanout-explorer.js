(async () => {
  // Claude Fanout Explorer, a bookmarklet for claude.ai. Reads the chat you have open (live while Claude answers, or a saved chat) and lists every
  // web search Claude ran, every page it opened, the pages each search got back, and which of those were cited.
  // Read-only: it sends no prompts and changes nothing.
  const rows = [];
  const turns = [];     // turns[t] = { prompt, cited: Set, hasAnswer }
  const meta = { id: '', at: '', prompts: 0, promptList: [], fetched: 0, cited: 0, redditFetched: 0, redditCited: 0, unknownTurns: 0 };

  const hostOf = u => { try { return new URL(u).hostname.replace(/^www\./, '').toLowerCase(); } catch (e) { return ''; } };
  const normUrl = u => String(u || '').toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, '').split(/[?\x23]/)[0].replace(/\/$/, '');
  const shortUrl = u => { const s = String(u || '').replace(/^https?:\/\//, '').replace(/^www\./, '').split(/[?\x23]/)[0].replace(/\/$/, ''); return s.length > 90 ? s.slice(0, 88) + '…' : s; };
  const hostMatches = (h, d) => h === d || h.endsWith('.' + d);

  // Active branch of the conversation tree, oldest first (walk up from the current leaf; fall back to index order).
  const activePath = (j) => {
    const msgs = j.chat_messages || [];
    const byId = {}; msgs.forEach(m => { byId[m.uuid] = m; });
    const out = []; const seen = new Set();
    let id = j.current_leaf_message_uuid;
    while (id && byId[id] && !seen.has(id)) { seen.add(id); out.push(byId[id]); id = byId[id].parent_message_uuid; }
    if (out.length < 2) return msgs.slice().sort((a, b) => (a.index || 0) - (b.index || 0));
    return out.reverse();
  };

  const extract = (j) => {
    rows.length = 0; turns.length = 0;
    meta.fetched = 0; meta.cited = 0; meta.redditFetched = 0; meta.redditCited = 0; meta.unknownTurns = 0; meta.promptList = [];
    let turn = 0, prompt = '';
    activePath(j).forEach(m => {
      const blocks = Array.isArray(m.content) ? m.content : [];
      if (m.sender === 'human') {
        prompt = String(m.text || blocks.filter(b => b.type === 'text').map(b => b.text).join(' ')).replace(/\s+/g, ' ').trim();
        turn++; turns[turn] = { prompt, cited: new Set(), hasAnswer: false };
        meta.promptList.push(prompt);
        return;
      }
      if (m.sender !== 'assistant') return;
      if (!turns[turn]) turns[turn] = { prompt: '', cited: new Set(), hasAnswer: false };
      const T = turns[turn];
      const pending = {};
      blocks.forEach(b => {
        if (!b || !b.type) return;
        if (b.type === 'tool_use' && (b.name === 'web_search' || b.name === 'web_fetch')) {
          const inp = b.input || {};
          const q = String(inp.query || inp.url || inp.q || JSON.stringify(inp)).trim();
          const type = b.name === 'web_search' ? 'search' : 'fetch';
          const r = { n: rows.length + 1, turn, type, query: q, prompt, results: '', cited: '', known: false, error: '', sources: [], seen: new Set(), reddit: /reddit/i.test(q) ? 'yes' : 'no' };
          rows.push(r); if (b.id) pending[b.id] = r;
          return;
        }
        if (b.type === 'tool_result' && (b.name === 'web_search' || b.name === 'web_fetch')) {
          let r = b.tool_use_id && pending[b.tool_use_id];
          if (!r) { for (let i = rows.length - 1; i >= 0; i--) if (rows[i].turn === turn && rows[i].type === (b.name === 'web_search' ? 'search' : 'fetch') && !rows[i].done) { r = rows[i]; break; } }
          if (!r) return;
          r.done = true;
          if (b.is_error) r.error = 'error';
          const items = Array.isArray(b.content) ? b.content : [];
          items.forEach(it => {
            if (!it || !it.url) return;
            const u = normUrl(it.url); if (r.seen.has(u)) return; r.seen.add(u);
            r.sources.push({ raw: String(it.url), url: u, host: hostOf(it.url), title: String(it.title || ''), cited: false });
          });
          if (r.type === 'fetch' && !r.sources.length && /^https?:/i.test(r.query)) { const u = normUrl(r.query); r.seen.add(u); r.sources.push({ raw: r.query, url: u, host: hostOf(r.query), title: '', cited: false }); }
          return;
        }
        if (b.type === 'text') {
          if (String(b.text || '').trim()) T.hasAnswer = true;
          (b.citations || []).forEach(c => { if (c && c.url) T.cited.add(normUrl(c.url)); (c && c.sources || []).forEach(s => { if (s && s.url) T.cited.add(normUrl(s.url)); }); });
        }
      });
    });
    meta.prompts = turn;
    const seenAll = new Set(), seenCited = new Set();
    rows.forEach(r => {
      const T = turns[r.turn] || { cited: new Set(), hasAnswer: false };
      r.known = T.hasAnswer;
      r.sources.forEach(e => {
        e.cited = T.cited.has(e.url);
        if (!seenAll.has(e.url)) { seenAll.add(e.url); meta.fetched++; if (hostMatches(e.host, 'reddit.com')) meta.redditFetched++; }
        if (e.cited && !seenCited.has(e.url)) { seenCited.add(e.url); meta.cited++; if (hostMatches(e.host, 'reddit.com')) meta.redditCited++; }
      });
      r.sources.sort((a, b) => (b.cited - a.cited) || a.host.localeCompare(b.host) || a.url.localeCompare(b.url));
      r.results = r.error ? 0 : r.sources.length;
      r.cited = r.known ? r.sources.filter(e => e.cited).length : '';
      if (r.reddit === 'no' && r.sources.some(e => hostMatches(e.host, 'reddit.com'))) r.reddit = 'results';
      delete r.seen;
    });
    meta.unknownTurns = turns.filter(t => t && !t.hasAnswer).length;
  };

  // ---------- Sorting ----------
  const COLS = ['n', 'turn', 'type', 'query', 'results', 'cited'];
  const NUMERIC = ['n', 'turn', 'results', 'cited'];
  let sortKey = 'n', sortDir = 1;
  const cell = (r, k) => r[k];
  const view = () => {
    const v = rows.slice();
    v.sort((a, b) => {
      const x = cell(a, sortKey), y = cell(b, sortKey);
      if (x === '' && y !== '') return 1; if (y === '' && x !== '') return -1;
      const c = NUMERIC.includes(sortKey) ? Number(x) - Number(y) : String(x).localeCompare(String(y), undefined, { sensitivity: 'base' });
      return (c * sortDir) || (a.n - b.n);
    });
    return v;
  };

  // ---------- Exports ----------
  const csvCell = s => '"' + String(s == null ? '' : s).replace(/"/g, '""') + '"';
  const srcList = (r, onlyCited) => r.sources.filter(e => !onlyCited || e.cited).map(e => e.raw).join(' | ');
  const toCSV = () => {
    const head = ['n', 'turn', 'type', 'query', 'results', 'cited', 'reddit', 'sources', 'cited_sources', 'prompt', 'conversation_id', 'captured_at'];
    return [head.join(',')].concat(view().map(r => [r.n, r.turn, r.type, r.query, r.results, r.cited, r.reddit, srcList(r, false), srcList(r, true), r.prompt, meta.id, meta.at].map(csvCell).join(','))).join('\n');
  };
  const toSourcesCSV = () => {
    const head = ['row_kind', 'n', 'turn', 'type', 'query', 'results', 'cited', 'source_url', 'source_domain', 'source_title', 'source_cited', 'prompt', 'conversation_id', 'captured_at'];
    const out = [head.join(',')];
    view().forEach(r => {
      out.push(['search', r.n, r.turn, r.type, r.query, r.results, r.cited, '', '', '', '', r.prompt, meta.id, meta.at].map(csvCell).join(','));
      r.sources.forEach(e => out.push(['source', r.n, r.turn, r.type, r.query, r.results, r.cited, e.raw, e.host, e.title, r.known ? (e.cited ? 'yes' : 'no') : '', r.prompt, meta.id, meta.at].map(csvCell).join(',')));
    });
    return out.join('\n');
  };
  const toTSV = () => ['n\tturn\ttype\tquery\tresults\tcited\treddit\tprompt'].concat(view().map(r => [r.n, r.turn, r.type, r.query, r.results, r.cited, r.reddit, r.prompt].join('\t'))).join('\n');
  const queriesOnly = () => view().map(r => r.query).join('\n');
  const download = (text, name) => {
    const blob = new Blob(['\uFEFF' + text], { type: 'text/csv;charset=utf-8' });
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name;
    document.body.appendChild(a); a.click(); setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
  };
  const stamp = () => 'claude-fanout-' + meta.id.slice(0, 8) + '-' + meta.at.slice(0, 16).replace(/[:T]/g, '-');

  // ---------- Index and Types tabs ----------
  const INDEX = [
    ['prompt (above the table)', 'The message you sent that started the searches. With several prompts in one chat, all are listed in order.', ''],
    ['n', 'The line number, in the order Claude ran the searches. 1 is the first search of the chat.', ''],
    ['turn', 'Which of your prompts the line belongs to. Claude searches one query at a time, reads the results, and may search again, so a turn can hold several lines.', 'turn = 2 means it happened while answering your second message.'],
    ['type', 'search = a web search with a query. fetch = Claude opened one page in full to read it. See the Types tab.', ''],
    ['query', 'For search lines, the exact words Claude searched. For fetch lines, the page it opened.', 'query = Avios eStore Apple iPhone 17 pre-order earn Avios'],
    ['results', 'How many pages the search returned. Exact per search, because Claude stores the results with each query. For a fetch line it is 1, the page opened. 0 with an error means the tool failed.', ''],
    ['cited', 'How many of those pages were cited in the answer. Claude cites at sentence level, and each citation carries its source URL, so this is matched by URL. Empty while the answer is still being written.', 'results = 6, cited = 2 means 6 pages came back and 2 were cited.'],
    ['+ (first column)', 'Opens the line to show the pages it got back. A tick marks the cited ones, a dot the rest. The first line inside groups them by website with the cited count per website. Expand all opens every line at once, for screenshots.', ''],
    ['headline (above the table)', 'Fetched = pages that came back across the whole chat, each counted once. Cited = how many of those were cited in an answer. Reddit = the same two numbers for reddit.com only.', ''],
    ['highlighted rows', 'Lines where the query mentions Reddit, or whose results include Reddit pages.', ''],
    ['reddit (exports only)', 'yes if the query mentions Reddit, results if only the results include Reddit pages, otherwise no.', ''],
    ['sources, cited_sources (CSV only)', 'The pages behind the + for that line, and the ones that were cited, as lists separated by |.', ''],
    ['conversation_id, captured_at (exports only)', 'The chat ID from the URL, and when you exported.', ''],
    ['Copy queries only', 'Copies the query column, one per line.', ''],
    ['Copy table (TSV)', 'Copies the table plus the prompt as text for Google Sheets or Excel.', ''],
    ['Download CSV', 'One row per line, with every column including the sources lists.', ''],
    ['Download sources CSV', 'The expanded view as a file: Each line, followed by one row per page it got back, with source_url, source_domain, source_title and source_cited. Filter row_kind = source to work with the pages only.', ''],
    ['Sorting', 'Click a column header to sort, click again to reverse. Empty cells go last. Exports follow the sort you see. Sort by n to get back to the original order.', ''],
    ['Saved copies', 'Every chat the panel reads is kept in this browser. Reopening a chat shows the saved copy at once, without asking claude.ai again. The newest 30 chats are kept. Refresh re-reads the live chat.', ''],
    ['429 / rate limiting', 'If claude.ai refuses reads (error 429), the panel keeps what it has and waits before trying again. Live reads only happen while an answer is being written.', ''],
    ['Live: on / off', 'While on, the panel re-reads the chat every few seconds while Claude is answering. Once the answer is done it stops until you send another prompt. Open a new chat, click the bookmark, send your prompt, and watch it fill.', '']
  ];
  const TYPES = [
    ['web_search', 'search, listed', 'A web search. One query per call. Claude reads the results, then may search again with a refined query. No freshness window or domain lock is exposed; site: goes inside the query when Claude wants one.', '{ "query": "..." }', 'Avios eStore Apple iPhone 17 pre-order earn Avios'],
    ['web_fetch', 'fetch, listed', 'Claude opens one page in full to read it, usually a result from an earlier search or a link you gave it.', '{ "url": "https://..." }', 'https://www.iagloyalty.com/news-insights/avios-shop-apple-products'],
    ['results', 'for reference', 'Each search result is stored as a knowledge item with url, title and site name. Results stay attached to the query that produced them, which is why results and cited are exact per line here, unlike ChatGPT where they are per round.', '', ''],
    ['citations', 'for reference', 'Claude cites inside the text: Each citation covers a span of the answer and carries the source url and title. A page counts as cited when any citation in the same turn points at its url.', '', ''],
    ['other tools', 'ignored', 'memory_read, message_compose, artifacts, code execution and similar tools are not searches and are left out.', '', '']
  ];

  // ---------- Panel ----------
  const old = document.getElementById('cs-export'); if (old) old.remove();
  const box = document.createElement('div'); box.id = 'cs-export';
  box.style.cssText = 'position:fixed;top:12px;right:12px;z-index:2147483647;width:min(1000px,96vw);max-height:88vh;overflow:auto;background:rgb(17,17,17);color:rgb(235,235,235);font:13px/1.4 -apple-system,Segoe UI,Helvetica,Arial,sans-serif;border:1px solid rgb(70,70,70);border-radius:10px;padding:14px;box-shadow:0 8px 30px rgba(0,0,0,.5);text-align:left';
  const bar = document.createElement('div'); bar.style.cssText = 'display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-bottom:10px';
  const title = document.createElement('strong'); title.textContent = 'Claude Fanout Explorer'; title.style.cssText = 'font-size:14px;margin-right:auto';
  const mkBtn = (label) => { const b = document.createElement('button'); b.type = 'button'; b.textContent = label; b.style.cssText = 'background:rgb(43,43,43);color:rgb(255,255,255);border:1px solid rgb(90,90,90);border-radius:6px;padding:6px 10px;cursor:pointer;font:inherit'; return b; };
  const flash = (b, txt) => { const o = b.textContent; b.textContent = txt; setTimeout(() => { b.textContent = o; }, 1500); };
  const bQ = mkBtn('Copy queries only'), bT = mkBtn('Copy table (TSV)'), bC = mkBtn('Download CSV'), bS = mkBtn('Download sources CSV'), bL = mkBtn('Live: on'), bR = mkBtn('Refresh'), bX = mkBtn('Close');
  const tabs = document.createElement('div'); tabs.style.cssText = 'display:flex;gap:6px;align-items:center;margin:0 0 10px;border-bottom:1px solid rgb(70,70,70)';
  const mkTab = (label) => { const b = document.createElement('button'); b.type = 'button'; b.textContent = label; b.style.cssText = 'background:none;color:rgb(170,170,170);border:none;border-bottom:2px solid transparent;padding:6px 10px;cursor:pointer;font:inherit;font-weight:600'; return b; };
  const tabTable = mkTab('Table'), tabIndex = mkTab('Index'), tabTypes = mkTab('Types');
  const bE = mkBtn('Expand all'); bE.style.cssText += ';margin-left:auto;padding:3px 8px;font-size:12px';
  const status = document.createElement('div'); status.style.cssText = 'margin:6px 0 4px;color:rgb(190,190,190)';
  const headline = document.createElement('div'); headline.style.cssText = 'margin:0 0 6px;color:rgb(235,235,235)';
  const promptLine = document.createElement('div'); promptLine.style.cssText = 'margin:0 0 10px;color:rgb(235,235,235);word-break:break-word';
  const body = document.createElement('div');
  const index = document.createElement('div'); index.hidden = true;
  const types = document.createElement('div'); types.hidden = true;
  bar.append(title, bQ, bT, bC, bS, bL, bR, bX); tabs.append(tabTable, tabIndex, tabTypes, bE);
  box.append(bar, tabs, status, headline, promptLine, body, index, types); document.body.appendChild(box);
  const showTab = (which) => {
    const on = 'rgb(255,255,255)', off = 'rgb(170,170,170)';
    [[tabTable, 'table'], [tabIndex, 'index'], [tabTypes, 'types']].forEach(([b, k]) => { b.style.color = which === k ? on : off; b.style.borderBottomColor = which === k ? on : 'transparent'; });
    const t = which === 'table';
    body.hidden = !t; status.hidden = !t; headline.hidden = !t; promptLine.hidden = !t; bE.hidden = !t;
    index.hidden = which !== 'index'; types.hidden = which !== 'types';
  };
  tabTable.onclick = () => showTab('table'); tabIndex.onclick = () => showTab('index'); tabTypes.onclick = () => showTab('types');
  bQ.onclick = async () => { try { await navigator.clipboard.writeText(queriesOnly()); flash(bQ, 'Copied ' + rows.length); } catch (e) { alert('Copy failed: ' + e.message); } };
  bT.onclick = async () => { try { await navigator.clipboard.writeText(toTSV()); flash(bT, 'Copied'); } catch (e) { alert('Copy failed: ' + e.message); } };
  bC.onclick = () => download(toCSV(), stamp() + '.csv');
  bS.onclick = () => download(toSourcesCSV(), stamp() + '-sources.csv');

  const refTable = (host, intro, heads, data, widths) => {
    const p = document.createElement('div'); p.style.cssText = 'margin:0 0 10px;color:rgb(190,190,190)'; p.textContent = intro;
    const t = document.createElement('table'); t.style.cssText = 'border-collapse:collapse;width:100' + String.fromCharCode(37);
    const hr = document.createElement('tr');
    heads.forEach(x => { const th = document.createElement('th'); th.textContent = x; th.style.cssText = 'text-align:left;border-bottom:1px solid rgb(70,70,70);padding:4px 6px;color:rgb(170,170,170);font-weight:600'; hr.appendChild(th); });
    t.appendChild(hr);
    data.forEach(row => {
      const tr = document.createElement('tr');
      row.forEach((x, i) => { const td = document.createElement('td'); td.textContent = x; td.style.cssText = 'border-bottom:1px solid rgb(42,42,42);padding:6px;vertical-align:top;' + (widths[i] || '') + (i === 0 ? ';font-weight:600;color:rgb(255,255,255)' : i === row.length - 1 ? ';color:rgb(190,190,190);font-style:italic;word-break:break-word' : ''); tr.appendChild(td); });
      t.appendChild(tr);
    });
    host.append(p, t);
  };
  refTable(index, 'Every line in the table is one web search Claude ran, or one page it opened, while answering this chat.', ['Column', 'What it means', 'Example'], INDEX, ['width:170px', '', 'width:30' + String.fromCharCode(37)]);
  refTable(types, 'What Claude writes to its tools, and how the panel treats it.', ['Tool', 'Kind', 'What it does', 'Shape', 'Example'], TYPES, ['width:90px', 'width:100px', '', 'width:150px;font-family:Menlo,Consolas,monospace;font-size:12px', 'font-family:Menlo,Consolas,monospace;font-size:12px']);

  // ---------- Table ----------
  const expanded = new Set();
  const detailFor = (r) => {
    const wrap = document.createElement('div'); wrap.style.cssText = 'font-size:12px;line-height:1.35;color:rgb(200,200,200);padding:2px 0 8px 26px';
    if (r.error) { wrap.textContent = 'The tool returned an error for this line.'; return wrap; }
    if (!r.sources.length) { wrap.textContent = 'Nothing came back for this search.'; return wrap; }
    const byHost = {}; r.sources.forEach(e => { const h = byHost[e.host] || (byHost[e.host] = { n: 0, c: 0 }); h.n++; if (e.cited) h.c++; });
    const sum = document.createElement('div'); sum.style.cssText = 'margin-bottom:4px;color:rgb(235,235,235)';
    sum.textContent = r.sources.length + ' page' + (r.sources.length === 1 ? '' : 's') + (r.known ? ', ' + r.sources.filter(e => e.cited).length + ' cited' : '') + '. ' + Object.keys(byHost).sort((a, b) => byHost[b].n - byHost[a].n).map(h => h + ' ' + byHost[h].n + (r.known ? ' (' + byHost[h].c + ' cited)' : '')).join(', ');
    const list = document.createElement('div'); if (r.sources.length > 6) list.style.cssText = 'column-count:2;column-gap:28px';
    r.sources.forEach(e => {
      const d = document.createElement('div'); d.style.cssText = 'break-inside:avoid;white-space:nowrap;overflow:hidden;text-overflow:ellipsis';
      const mark = document.createElement('span'); mark.textContent = e.cited ? '✓ ' : '· '; mark.style.cssText = e.cited ? 'color:rgb(120,220,140);font-weight:700' : 'color:rgb(120,120,120)';
      const a = document.createElement('a'); a.href = e.raw; a.target = '_blank'; a.rel = 'noopener'; a.textContent = shortUrl(e.raw); a.title = (e.title ? e.title + ' — ' : '') + e.raw; a.style.cssText = 'color:' + (e.cited ? 'rgb(235,235,235)' : 'rgb(170,170,170)') + ';text-decoration:none';
      d.append(mark, a); list.appendChild(d);
    });
    wrap.append(sum, list);
    return wrap;
  };

  // Prompt line: the prompts that produced lines, at most four, the rest counted (all of them are in the exports).
  const promptSummary = () => {
    const list = meta.promptList || [];
    if (list.length <= 1) return list.length ? 'Prompt: ' + list[0] : '';
    const used = [...new Set(rows.map(r => r.turn))].sort((a, b) => a - b);
    const shown = used.slice(0, 4).map(t => 'Prompt ' + t + ': ' + String(list[t - 1] || '').slice(0, 300));
    const more = used.length - shown.length;
    return shown.join('   ') + (more > 0 ? '   … and ' + more + ' more prompt(s) with searches (all in the exports)' : '');
  };
  const render = () => {
    body.innerHTML = '';
    const searches = rows.filter(r => r.type === 'search').length, fetches = rows.length - searches;
    const red = rows.filter(r => r.reddit !== 'no').length;
    status.textContent = searches + ' search(es) and ' + fetches + ' page fetch(es) across ' + meta.prompts + ' prompt(s). ' + red + ' involve Reddit.' + stateNote();
    headline.textContent = rows.length ? 'Fetched ' + meta.fetched + ' page(s), ' + meta.cited + ' cited in the answers. Reddit: ' + meta.redditFetched + ' fetched, ' + meta.redditCited + ' cited.' + (meta.unknownTurns ? ' (' + meta.unknownTurns + ' prompt(s) have no finished answer yet, so their cited counts are left empty.)' : '') : '';
    promptLine.textContent = promptSummary();
    bE.textContent = expanded.size ? 'Collapse all' : 'Expand all';
    if (!rows.length) return;
    const t = document.createElement('table'); t.style.cssText = 'border-collapse:collapse;width:100' + String.fromCharCode(37) + ';table-layout:fixed';
    const WIDTHS = { n: 40, turn: 48, type: 60, results: 62, cited: 52 };
    const tr = document.createElement('tr');
    const th0 = document.createElement('th'); th0.style.cssText = 'border-bottom:1px solid rgb(70,70,70);width:24px'; tr.appendChild(th0);
    COLS.forEach(k => {
      const th = document.createElement('th');
      th.textContent = k + (sortKey === k ? (sortDir === 1 ? ' ▲' : ' ▼') : '');
      th.title = 'Click to sort by ' + k;
      th.style.cssText = 'text-align:left;border-bottom:1px solid rgb(70,70,70);padding:4px 6px;color:' + (sortKey === k ? 'rgb(255,255,255)' : 'rgb(170,170,170)') + ';font-weight:600;white-space:nowrap;overflow:hidden;cursor:pointer;user-select:none' + (WIDTHS[k] ? ';width:' + WIDTHS[k] + 'px' : '');
      th.onclick = () => { if (sortKey === k) sortDir = -sortDir; else { sortKey = k; sortDir = 1; } render(); };
      tr.appendChild(th);
    });
    t.appendChild(tr);
    view().forEach(r => {
      const isOpen = expanded.has(r.n);
      const row = document.createElement('tr'); if (r.reddit !== 'no') row.style.background = r.reddit === 'yes' ? 'rgb(70,45,10)' : 'rgb(45,32,12)';
      const tdp = document.createElement('td'); tdp.style.cssText = 'border-bottom:1px solid rgb(42,42,42);padding:2px 0 2px 4px;vertical-align:top';
      const plus = document.createElement('button'); plus.type = 'button'; plus.textContent = isOpen ? '−' : '+'; plus.title = isOpen ? 'Hide the pages' : 'Show the pages that came back';
      plus.style.cssText = 'width:18px;height:18px;line-height:16px;padding:0;background:rgb(43,43,43);color:rgb(235,235,235);border:1px solid rgb(90,90,90);border-radius:4px;cursor:pointer;font:12px/16px inherit';
      plus.onclick = () => { if (expanded.has(r.n)) expanded.delete(r.n); else expanded.add(r.n); render(); };
      tdp.appendChild(plus); row.appendChild(tdp);
      COLS.forEach(k => {
        const td = document.createElement('td'); td.textContent = cell(r, k);
        td.style.cssText = 'border-bottom:1px solid rgb(42,42,42);padding:4px 6px;vertical-align:top;' + (k === 'query' ? 'word-break:break-word' : 'white-space:nowrap;overflow:hidden;text-overflow:ellipsis') + (k === 'cited' && r.cited !== '' && r.cited > 0 ? ';color:rgb(120,220,140);font-weight:600' : '');
        row.appendChild(td);
      });
      t.appendChild(row);
      if (isOpen) {
        const dr = document.createElement('tr'); if (r.reddit !== 'no') dr.style.background = 'rgb(50,34,10)';
        const td = document.createElement('td'); td.colSpan = COLS.length + 1; td.style.cssText = 'border-bottom:1px solid rgb(42,42,42);padding:0 6px';
        td.appendChild(detailFor(r)); dr.appendChild(td); t.appendChild(dr);
      }
    });
    body.appendChild(t);
  };
  bE.onclick = () => { if (expanded.size) expanded.clear(); else rows.forEach(r => expanded.add(r.n)); render(); };

  // ---------- Saved copies (localStorage on claude.ai, newest 30 chats) ----------
  const CACHE = 'cs-export:v1:';
  const saveCopy = () => {
    if (!meta.id || !rows.length) return;
    const data = { at: meta.at, meta: { prompts: meta.prompts, promptList: meta.promptList, fetched: meta.fetched, cited: meta.cited, redditFetched: meta.redditFetched, redditCited: meta.redditCited, unknownTurns: meta.unknownTurns },
      rows: rows.map(r => ({ n: r.n, turn: r.turn, type: r.type, query: r.query, prompt: r.prompt, results: r.results, cited: r.cited, known: r.known, error: r.error, reddit: r.reddit, sources: r.sources.map(e => [e.raw, e.host, e.cited ? 1 : 0, e.title]) })) };
    const write = () => localStorage.setItem(CACHE + meta.id, JSON.stringify(data));
    try { write(); } catch (e) { try { evict(10); write(); } catch (e2) {} }
    try { evict(30); } catch (e) {}
  };
  const evict = (keep) => {
    const ks = Object.keys(localStorage).filter(k => k.startsWith(CACHE));
    if (ks.length <= keep) return;
    ks.map(k => { let at = ''; try { at = (JSON.parse(localStorage.getItem(k)) || {}).at || ''; } catch (e) {} return { k, at }; })
      .sort((a, b) => a.at < b.at ? -1 : 1).slice(0, ks.length - keep).forEach(x => localStorage.removeItem(x.k));
  };
  const loadCopy = (id) => {
    try {
      const d = JSON.parse(localStorage.getItem(CACHE + id) || 'null'); if (!d || !d.rows) return false;
      rows.length = 0;
      d.rows.forEach(r => { r.sources = (r.sources || []).map(x => ({ raw: x[0], url: normUrl(x[0]), host: x[1], cited: !!x[2], title: x[3] || '' })); rows.push(r); });
      Object.assign(meta, d.meta); meta.id = id; meta.at = d.at;
      return true;
    } catch (e) { return false; }
  };
  const when = iso => { try { const d = new Date(iso); return d.toLocaleDateString() + ' ' + d.toLocaleTimeString().replace(/:\d\d(\s|$)/, '$1'); } catch (e) { return iso; } };

  // ---------- Live mode ----------
  let chatId = null, orgId = '', inFlight = false, lastSig = '', timer = null, live = true, closed = false;
  let settled = false, wasStreaming = false, graceUntil = 0, backoffUntil = 0, backoffMs = 0, fromCopy = false;
  const idFromUrl = () => { const m = location.pathname.match(/\/chat\/([0-9a-fA-F-]{20,})/); return m ? m[1] : ''; };
  const streaming = () => !!(document.querySelector('button[aria-label="Stop response"]') || document.querySelector('button[aria-label="Stop"]') || document.querySelector('[data-testid="stop-button"]'));
  const getOrg = async () => {
    if (orgId) return orgId;
    const m = document.cookie.match(/lastActiveOrg=([0-9a-fA-F-]{20,})/); if (m) { orgId = m[1]; return orgId; }
    const r = await fetch('/api/organizations', { credentials: 'include' });
    if (!r.ok) throw new Error('HTTP ' + r.status + ' reading organizations');
    const orgs = await r.json(); orgId = orgs && orgs[0] && orgs[0].uuid; if (!orgId) throw new Error('no organization found. Are you logged in?');
    return orgId;
  };
  const stateNote = () => fromCopy ? ' Saved copy from ' + when(meta.at) + '.' + (settled ? ' Refresh re-reads it.' : ' Checking for changes...') : !live ? ' Live is off.' : settled ? ' Live: waiting for a new prompt.' : ' Live, updated ' + new Date().toLocaleTimeString() + '.';
  const load = async (force) => {
    if (inFlight || !chatId) return; inFlight = true;
    try {
      const r = await fetch('/api/organizations/' + await getOrg() + '/chat_conversations/' + chatId + '?tree=True&rendering_mode=messages&render_all_tools=true', { credentials: 'include' });
      if (r.status === 429) {
        const ra = Number(r.headers.get('Retry-After')) * 1000;
        backoffMs = ra > 0 ? ra : Math.min(backoffMs ? backoffMs * 2 : 60000, 600000);
        backoffUntil = Date.now() + backoffMs;
        throw new Error('429');
      }
      if (!r.ok) throw new Error('HTTP ' + r.status);
      backoffMs = 0; backoffUntil = 0;
      const txt = await r.text();
      const sig = txt.length + '|' + (txt.match(/"current_leaf_message_uuid":\s*"([^"]+)"/) || ['', ''])[1];
      if (sig !== lastSig || force) {
        lastSig = sig; fromCopy = false;
        meta.id = chatId; meta.at = new Date().toISOString();
        extract(JSON.parse(txt));
        settled = !streaming() && Date.now() > graceUntil && meta.unknownTurns === 0;
        render(); saveCopy();
        if (!rows.length) status.textContent = 'No searches yet. If the answer is finished and this stays empty, Claude answered without searching the web.' + stateNote();
      } else {
        settled = !streaming() && Date.now() > graceUntil && meta.unknownTurns === 0;
        if (rows.length) status.textContent = status.textContent.replace(/ (Live|Saved copy).*$/, stateNote());
      }
    } catch (e) {
      if (e.message === '429') status.textContent = 'claude.ai is rate limiting this browser (429). ' + (rows.length ? 'Showing the ' + (fromCopy ? 'saved copy from ' + when(meta.at) : 'last read') + '. ' : '') + 'Next try in ' + Math.ceil(backoffMs / 1000) + 's.';
      else status.textContent = 'Could not read the conversation: ' + e.message;
    } finally { inFlight = false; }
  };
  const tick = async () => {
    if (closed) return;
    const id = idFromUrl();
    if (id !== chatId) {
      chatId = id; lastSig = ''; settled = false; graceUntil = 0; fromCopy = false; rows.length = 0; expanded.clear(); body.innerHTML = ''; headline.textContent = ''; promptLine.textContent = '';
      if (!chatId) status.textContent = 'Waiting for a chat. Send your prompt here and the searches will appear as Claude runs them.';
      // Show the saved copy at once, then re-read once in the background so a copy captured
      // mid-answer, or before later prompts in the same chat, cannot go stale on screen.
      else if (loadCopy(chatId)) { fromCopy = true; settled = false; render(); }
      else status.textContent = 'Reading conversation ' + chatId + ' ...';
    }
    const now = Date.now(), busy = streaming();
    if (busy) settled = false;
    if (wasStreaming && !busy) graceUntil = now + 15000;
    wasStreaming = busy;
    const wanted = chatId && live && !settled && now >= backoffUntil;
    if (wanted) await load(false);
    else if (chatId && live && now < backoffUntil && !inFlight) status.textContent = status.textContent.replace(/Next try in \d+s\./, 'Next try in ' + Math.ceil((backoffUntil - now) / 1000) + 's.');
    timer = setTimeout(tick, busy || now < graceUntil ? 4000 : 2000);
  };
  bL.onclick = () => { live = !live; bL.textContent = live ? 'Live: on' : 'Live: off'; if (live) { settled = false; } render(); };
  bR.onclick = () => { if (!chatId) return; settled = false; backoffUntil = 0; load(true); };
  bX.onclick = () => { closed = true; clearTimeout(timer); box.remove(); };
  showTab('table');
  tick();
})();
