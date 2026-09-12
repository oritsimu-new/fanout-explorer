(async () => {
  // Gemini Fanout Explorer, a bookmarklet for gemini.google.com. Reads the chat you have open (live once an answer
  // settles, or a saved chat) and lists every Google search query Gemini ran, and every source it cited, with the
  // answer text each source backs. Read-only: it sends no prompts and changes nothing.
  //
  // Gemini exposes less than ChatGPT or Claude: it shows the sources it cited, not the wider pool it read and passed
  // over, and its search queries live only in the stored conversation, never on screen. This surfaces both.
  const queries = [];   // { n, turn, query, prompt, reddit }
  const sources = [];   // { n, turn, url, raw, host, title, snippet, supports, prompt, reddit }
  const meta = { id: '', at: '', prompts: 0, promptList: [], model: '', queryCount: 0, sourceCount: 0, domainCount: 0, redditQueries: 0, redditSources: 0 };

  const hostOf = u => { try { return new URL(u).hostname.replace(/^www\./, '').toLowerCase(); } catch (e) { return ''; } };
  const normUrl = u => String(u || '').toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, '').split(/[?\x23]/)[0].replace(/\/$/, '');
  const shortUrl = u => { const s = String(u || '').replace(/^https?:\/\//, '').replace(/^www\./, '').split(/[?\x23]/)[0].replace(/\/$/, ''); return s.length > 90 ? s.slice(0, 88) + '…' : s; };
  const hostMatches = (h, d) => h === d || h.endsWith('.' + d);
  const clean = s => String(s == null ? '' : s).replace(/\s+/g, ' ').trim();

  // ---------- Read the stored conversation over Gemini's own batchexecute RPC ----------
  const wiz = () => (window.WIZ_global_data || {});
  const tok = (k) => { const w = wiz(); if (w[k]) return w[k]; const m = document.documentElement.innerHTML.match(new RegExp('"' + k + '":"([^"]+)"')); return m ? m[1] : ''; };
  const idFromUrl = () => { const m = location.pathname.match(/\/app\/([a-z0-9]{6,})/i); return m ? m[1] : ''; };
  const parseBatch = (txt, rpc) => {
    let data = null;
    for (const line of txt.split('\n')) {
      if (!line.startsWith('[[')) continue;
      let arr; try { arr = JSON.parse(line); } catch (e) { continue; }
      for (const item of arr) { if (Array.isArray(item) && item[0] === 'wrb.fr' && item[1] === rpc && typeof item[2] === 'string') { try { data = JSON.parse(item[2]); } catch (e) {} } }
    }
    return data;
  };
  const fetchConv = async (id) => {
    const conv = 'c_' + id;
    const args = JSON.stringify([conv, 100, null, 1, [1], [4], null, 1]);
    const freq = JSON.stringify([[['hNvQHb', args, null, 'generic']]]);
    const qs = 'rpcids=hNvQHb&source-path=' + encodeURIComponent('/app/' + id) + '&bl=' + encodeURIComponent(tok('cfb2h')) + '&f.sid=' + encodeURIComponent(tok('FdrFJe')) + '&hl=en&_reqid=' + Math.floor(Math.random() * 900000 + 100000) + '&rt=c';
    const r = await fetch('/_/BardChatUi/data/batchexecute?' + qs, { method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8' }, body: 'f.req=' + encodeURIComponent(freq) + '&at=' + encodeURIComponent(tok('SNlM0e')) });
    if (!r.ok) { const e = new Error('HTTP ' + r.status); e.status = r.status; e.retryAfter = Number(r.headers.get('Retry-After')) * 1000; throw e; }
    return parseBatch(await r.text(), 'hNvQHb');
  };

  // ---------- Turn the stored conversation into query rows and source rows ----------
  const extract = (data) => {
    queries.length = 0; sources.length = 0; meta.promptList = []; meta.model = '';
    const turns = (data && data[0]) || [];
    let turn = 0;
    const srcByUrl = {};
    turns.forEach(t => {
      if (!Array.isArray(t)) return;
      const prompt = clean(t[2] && t[2][0] && t[2][0][0]);
      const m = t[3] || [];
      const cand = m[0] && m[0][0];
      // A turn counts once it carries a model response.
      if (!cand && !(m[1] && m[1].length)) { if (prompt) { turn++; meta.promptList.push(prompt); } return; }
      turn++; if (prompt) meta.promptList.push(prompt); else meta.promptList.push('');
      if (m[21] && !meta.model) meta.model = String(m[21]);
      // Search queries (the fan-out), turn level.
      (m[1] || []).forEach(q => {
        const text = clean(Array.isArray(q) ? q[0] : q); if (!text) return;
        queries.push({ n: 0, turn, query: text, prompt, reddit: /reddit/i.test(text) ? 'yes' : 'no' });
      });
      // Cited sources, pooled at candidate level, each tied to answer segments.
      const cits = (cand && cand[2] && cand[2][1]) || [];
      cits.forEach(c => {
        const seg = clean(c && c[0] && c[0][0]);
        const list = (c && c[2]) || [];
        list.forEach(s => {
          const raw = s && s[0]; if (!raw || /gstatic\.com|googleusercontent\.com\/favicon/i.test(raw)) return;
          const key = turn + '|' + normUrl(raw);
          let row = srcByUrl[key];
          if (!row) { row = { n: 0, turn, raw: String(raw), url: normUrl(raw), host: hostOf(raw), title: clean(s[1]), snippet: clean(s[3]), site: clean(s[5]), supports: 0, segs: [], prompt, reddit: hostMatches(hostOf(raw), 'reddit.com') ? 'yes' : 'no' }; srcByUrl[key] = row; sources.push(row); }
          row.supports++; if (seg && row.segs.length < 4 && !row.segs.includes(seg)) row.segs.push(seg);
          if (!row.title && s[1]) row.title = clean(s[1]);
          if (!row.snippet && s[3]) row.snippet = clean(s[3]);
        });
      });
    });
    meta.prompts = turn;
    queries.forEach((q, i) => q.n = i + 1);
    sources.sort((a, b) => (a.turn - b.turn) || a.host.localeCompare(b.host) || a.url.localeCompare(b.url));
    sources.forEach((s, i) => s.n = i + 1);
    const domains = new Set(sources.map(s => s.host));
    meta.queryCount = queries.length;
    meta.sourceCount = sources.length;
    meta.domainCount = domains.size;
    meta.redditQueries = queries.filter(q => q.reddit === 'yes').length;
    meta.redditSources = sources.filter(s => s.reddit === 'yes').length;
  };

  // ---------- Sorting (each table sorts on its own) ----------
  const Q_NUM = ['n', 'turn'], S_NUM = ['n', 'turn', 'supports'];
  let qSort = 'n', qDir = 1, sSort = 'n', sDir = 1;
  const sortRows = (arr, key, dir, numeric) => arr.slice().sort((a, b) => {
    const x = a[key], y = b[key];
    const c = numeric.includes(key) ? Number(x) - Number(y) : String(x).localeCompare(String(y), undefined, { sensitivity: 'base' });
    return (c * dir) || (a.n - b.n);
  });
  const qView = () => sortRows(queries, qSort, qDir, Q_NUM);
  const sView = () => sortRows(sources, sSort, sDir, S_NUM);

  // ---------- Exports ----------
  const csvCell = s => '"' + String(s == null ? '' : s).replace(/"/g, '""') + '"';
  const toQueriesCSV = () => {
    const head = ['n', 'turn', 'query', 'reddit', 'prompt', 'conversation_id', 'model', 'captured_at'];
    return [head.join(',')].concat(qView().map(r => [r.n, r.turn, r.query, r.reddit, r.prompt, meta.id, meta.model, meta.at].map(csvCell).join(','))).join('\n');
  };
  const toSourcesCSV = () => {
    const head = ['n', 'turn', 'domain', 'title', 'source_url', 'supports_segments', 'reddit', 'snippet', 'prompt', 'conversation_id', 'model', 'captured_at'];
    return [head.join(',')].concat(sView().map(r => [r.n, r.turn, r.host, r.title, r.raw, r.supports, r.reddit, r.snippet, r.prompt, meta.id, meta.model, meta.at].map(csvCell).join(','))).join('\n');
  };
  const toTSV = () => {
    const q = ['SEARCH QUERIES', 'n\tturn\tquery\treddit'].concat(qView().map(r => [r.n, r.turn, r.query, r.reddit].join('\t')));
    const s = ['', 'CITED SOURCES', 'n\tturn\tdomain\ttitle\tsupports\treddit'].concat(sView().map(r => [r.n, r.turn, r.host, r.title, r.supports, r.reddit].join('\t')));
    return q.concat(s).join('\n');
  };
  const queriesOnly = () => qView().map(r => r.query).join('\n');
  const download = (text, name) => {
    const blob = new Blob(['﻿' + text], { type: 'text/csv;charset=utf-8' });
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name;
    document.body.appendChild(a); a.click(); setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
  };
  const stamp = () => 'gemini-fanout-' + meta.id.slice(0, 8) + '-' + meta.at.slice(0, 16).replace(/[:T]/g, '-');

  // ---------- Index and Types tabs ----------
  const INDEX = [
    ['prompt (above the tables)', 'The message you sent that started the searches. With several prompts in one chat, all are listed in order.', ''],
    ['Search queries table', 'Every query Gemini sent to Google Search while answering. This is the fan-out, and Gemini never shows it on screen.', ''],
    ['Cited sources table', 'Every page Gemini cited in the answer, one row each. Gemini exposes only what it cited, not the wider set it read and left out, so there is no results or discarded count to show, unlike the ChatGPT and Claude tools.', ''],
    ['n', 'The line number, in order. Each table numbers from 1.', ''],
    ['turn', 'Which of your prompts the line belongs to. turn = 2 means it happened while answering your second message.', ''],
    ['query', 'The exact words Gemini searched on Google. Queries are recorded per turn, not per source, so a query does not map to a specific page here.', 'query = Tidio vs Crisp Shopify review small business reddit'],
    ['domain, title', 'The website and page title of a cited source.', 'domain = featurebase.app'],
    ['supports', 'How many separate parts of the answer that source backs. A higher number means Gemini leaned on it more.', 'supports = 3'],
    ['snippet (expand, and CSV)', 'The short passage Gemini stored from the page, plus the answer text it backs. Open a source line with + to read it.', ''],
    ['reddit', 'yes when the query mentions Reddit, or when the cited source is a reddit.com page.', ''],
    ['headline (above the tables)', 'The count of queries, cited sources and the domains they span, then how many queries mention Reddit and how many cited sources are Reddit pages.', ''],
    ['highlighted rows', 'Query lines that mention Reddit, and source lines that are Reddit pages.', ''],
    ['Copy queries only', 'Copies the query column, one per line.', ''],
    ['Copy tables (TSV)', 'Copies both tables as text for Google Sheets or Excel.', ''],
    ['Download queries CSV', 'One row per search query.', ''],
    ['Download sources CSV', 'One row per cited source, with domain, title, url, how many answer parts it supports, the Reddit flag and the snippet.', ''],
    ['Sorting', 'Click a column header to sort that table, click again to reverse. Exports follow the sort you see. Sort by n to get back to the original order.', ''],
    ['Saved copies', 'Every chat the panel reads is kept in this browser. Reopening a chat shows the saved copy at once. The newest 30 chats are kept. Refresh re-reads the live chat.', ''],
    ['Live: on / off', 'While on, the panel re-reads the chat every few seconds while Gemini is answering, and fills once the answer settles. Gemini publishes the queries and sources only when the answer is stored, so a live chat can take a moment to appear.', '']
  ];
  const TYPES = [
    ['Google Search', 'the fan-out', 'Gemini grounds an answer by sending one or more queries to Google Search. The queries are in the Search queries table. Gemini does not expose a freshness window, a site lock or the list of pages a query returned, so those columns from the ChatGPT and Claude tools have no equivalent here.', 'Tidio vs Crisp vs Intercom Shopify reddit'],
    ['citations / sources', 'the cited pages', 'Each sentence of the answer can carry grounding sources. The panel gathers them into the Cited sources table, one row per page, counting how many answer parts each backs. These are the pages Gemini kept, not everything it read.', ''],
    ['alternate drafts', 'ignored', 'Gemini stores a second draft of some answers for its show-drafts feature. The panel reads the shown answer only.', ''],
    ['image search, tools', 'ignored', 'Image results, code execution and other non-web tools are not web searches and are left out.', '']
  ];

  // ---------- Panel ----------
  const old = document.getElementById('gm-export'); if (old) old.remove();
  const box = document.createElement('div'); box.id = 'gm-export';
  box.style.cssText = 'position:fixed;top:12px;right:12px;z-index:2147483647;width:min(1000px,96vw);max-height:88vh;overflow:auto;background:rgb(17,17,17);color:rgb(235,235,235);font:13px/1.4 -apple-system,Segoe UI,Helvetica,Arial,sans-serif;border:1px solid rgb(70,70,70);border-radius:10px;padding:14px;box-shadow:0 8px 30px rgba(0,0,0,.5);text-align:left';
  const bar = document.createElement('div'); bar.style.cssText = 'display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-bottom:10px';
  const title = document.createElement('strong'); title.textContent = 'Gemini Fanout Explorer'; title.style.cssText = 'font-size:14px;margin-right:auto';
  const mkBtn = (label) => { const b = document.createElement('button'); b.type = 'button'; b.textContent = label; b.style.cssText = 'background:rgb(43,43,43);color:rgb(255,255,255);border:1px solid rgb(90,90,90);border-radius:6px;padding:6px 10px;cursor:pointer;font:inherit'; return b; };
  const flash = (b, txt) => { const o = b.textContent; b.textContent = txt; setTimeout(() => { b.textContent = o; }, 1500); };
  const bQ = mkBtn('Copy queries only'), bT = mkBtn('Copy tables (TSV)'), bC = mkBtn('Download queries CSV'), bS = mkBtn('Download sources CSV'), bL = mkBtn('Live: on'), bR = mkBtn('Refresh'), bX = mkBtn('Close');
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
  bQ.onclick = async () => { try { await navigator.clipboard.writeText(queriesOnly()); flash(bQ, 'Copied ' + queries.length); } catch (e) { alert('Copy failed: ' + e.message); } };
  bT.onclick = async () => { try { await navigator.clipboard.writeText(toTSV()); flash(bT, 'Copied'); } catch (e) { alert('Copy failed: ' + e.message); } };
  bC.onclick = () => download(toQueriesCSV(), stamp() + '-queries.csv');
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
  refTable(index, 'Gemini answers by searching Google, then citing some of the pages. The panel lists the queries and the cited pages.', ['Column', 'What it means', 'Example'], INDEX, ['width:180px', '', 'width:28' + String.fromCharCode(37)]);
  refTable(types, 'What Gemini records for a grounded answer, and how the panel treats it.', ['Item', 'Kind', 'What it is', 'Example'], TYPES, ['width:120px', 'width:96px', '', 'font-family:Menlo,Consolas,monospace;font-size:12px']);

  // ---------- Tables ----------
  const expanded = new Set();     // source keys open
  const sectionTitle = (txt) => { const d = document.createElement('div'); d.textContent = txt; d.style.cssText = 'margin:14px 0 6px;color:rgb(255,255,255);font-weight:700'; return d; };
  const sortableHead = (cols, widths, key, dir, onSort) => {
    const tr = document.createElement('tr');
    const th0 = document.createElement('th'); th0.style.cssText = 'border-bottom:1px solid rgb(70,70,70);width:24px'; tr.appendChild(th0);
    cols.forEach(k => {
      const th = document.createElement('th');
      th.textContent = k + (key === k ? (dir === 1 ? ' ▲' : ' ▼') : '');
      th.style.cssText = 'text-align:left;border-bottom:1px solid rgb(70,70,70);padding:4px 6px;color:' + (key === k ? 'rgb(255,255,255)' : 'rgb(170,170,170)') + ';font-weight:600;white-space:nowrap;overflow:hidden;cursor:pointer;user-select:none' + (widths[k] ? ';width:' + widths[k] + 'px' : '');
      th.onclick = () => onSort(k);
      tr.appendChild(th);
    });
    return tr;
  };
  const detailForSource = (r) => {
    const wrap = document.createElement('div'); wrap.style.cssText = 'font-size:12px;line-height:1.4;color:rgb(200,200,200);padding:2px 0 8px 26px';
    const a = document.createElement('a'); a.href = r.raw; a.target = '_blank'; a.rel = 'noopener'; a.textContent = shortUrl(r.raw); a.style.cssText = 'color:rgb(150,190,255);text-decoration:none;word-break:break-all'; a.title = r.raw;
    wrap.appendChild(a);
    if (r.snippet) { const s = document.createElement('div'); s.style.cssText = 'margin-top:4px'; s.textContent = 'Snippet: ' + r.snippet; wrap.appendChild(s); }
    if (r.segs && r.segs.length) { const s = document.createElement('div'); s.style.cssText = 'margin-top:4px;color:rgb(160,160,160)'; s.textContent = 'Backs: ' + r.segs.map(x => '“' + (x.length > 120 ? x.slice(0, 118) + '…' : x) + '”').join('  '); wrap.appendChild(s); }
    return wrap;
  };
  const promptSummary = () => {
    const list = (meta.promptList || []).filter(Boolean);
    if (list.length <= 1) return list.length ? 'Prompt: ' + list[0] : '';
    const shown = list.slice(0, 4).map((p, i) => 'Prompt ' + (i + 1) + ': ' + String(p).slice(0, 300));
    const more = list.length - shown.length;
    return shown.join('   ') + (more > 0 ? '   … and ' + more + ' more prompt(s) (all in the exports)' : '');
  };

  const render = () => {
    body.innerHTML = '';
    status.textContent = meta.queryCount + ' search quer' + (meta.queryCount === 1 ? 'y' : 'ies') + ' and ' + meta.sourceCount + ' cited source' + (meta.sourceCount === 1 ? '' : 's') + ' across ' + meta.prompts + ' prompt(s).' + (meta.model ? ' Model: ' + meta.model + '.' : '') + stateNote();
    headline.textContent = (meta.queryCount || meta.sourceCount) ? meta.sourceCount + ' source(s) cited across ' + meta.domainCount + ' domain(s). Reddit: asked in ' + meta.redditQueries + ' quer' + (meta.redditQueries === 1 ? 'y' : 'ies') + ', cited on ' + meta.redditSources + ' source(s).' : '';
    promptLine.textContent = promptSummary();
    bE.textContent = expanded.size ? 'Collapse all' : 'Expand all';
    if (!meta.queryCount && !meta.sourceCount) return;

    // Search queries table
    body.appendChild(sectionTitle('Search queries (' + meta.queryCount + ')'));
    const qt = document.createElement('table'); qt.style.cssText = 'border-collapse:collapse;width:100' + String.fromCharCode(37) + ';table-layout:fixed';
    qt.appendChild(sortableHead(['n', 'turn', 'query', 'reddit'], { n: 40, turn: 48, reddit: 60 }, qSort, qDir, k => { if (qSort === k) qDir = -qDir; else { qSort = k; qDir = 1; } render(); }));
    qView().forEach(r => {
      const tr = document.createElement('tr'); if (r.reddit === 'yes') tr.style.background = 'rgb(70,45,10)';
      const sp = document.createElement('td'); sp.style.cssText = 'border-bottom:1px solid rgb(42,42,42)'; tr.appendChild(sp);
      [['n', r.n], ['turn', r.turn], ['query', r.query], ['reddit', r.reddit]].forEach(([k, v]) => { const td = document.createElement('td'); td.textContent = v; td.style.cssText = 'border-bottom:1px solid rgb(42,42,42);padding:4px 6px;vertical-align:top;' + (k === 'query' ? 'word-break:break-word' : 'white-space:nowrap'); tr.appendChild(td); });
      qt.appendChild(tr);
    });
    body.appendChild(qt);

    // Cited sources table
    body.appendChild(sectionTitle('Cited sources (' + meta.sourceCount + ')'));
    const st = document.createElement('table'); st.style.cssText = 'border-collapse:collapse;width:100' + String.fromCharCode(37) + ';table-layout:fixed';
    st.appendChild(sortableHead(['n', 'turn', 'domain', 'title', 'supports', 'reddit'], { n: 40, turn: 48, domain: 150, supports: 74, reddit: 60 }, sSort, sDir, k => { if (sSort === k) sDir = -sDir; else { sSort = k; sDir = 1; } render(); }));
    sView().forEach(r => {
      const isOpen = expanded.has(r.n);
      const tr = document.createElement('tr'); if (r.reddit === 'yes') tr.style.background = 'rgb(70,45,10)';
      const tdp = document.createElement('td'); tdp.style.cssText = 'border-bottom:1px solid rgb(42,42,42);padding:2px 0 2px 4px;vertical-align:top';
      const plus = document.createElement('button'); plus.type = 'button'; plus.textContent = isOpen ? '−' : '+'; plus.title = isOpen ? 'Hide the snippet' : 'Show the snippet and the answer text it backs';
      plus.style.cssText = 'width:18px;height:18px;line-height:16px;padding:0;background:rgb(43,43,43);color:rgb(235,235,235);border:1px solid rgb(90,90,90);border-radius:4px;cursor:pointer;font:12px/16px inherit';
      plus.onclick = () => { if (expanded.has(r.n)) expanded.delete(r.n); else expanded.add(r.n); render(); };
      tdp.appendChild(plus); tr.appendChild(tdp);
      [['n', r.n], ['turn', r.turn], ['domain', r.host], ['title', r.title || shortUrl(r.raw)], ['supports', r.supports], ['reddit', r.reddit]].forEach(([k, v]) => { const td = document.createElement('td'); td.textContent = v; td.style.cssText = 'border-bottom:1px solid rgb(42,42,42);padding:4px 6px;vertical-align:top;' + (k === 'title' ? 'word-break:break-word' : 'white-space:nowrap;overflow:hidden;text-overflow:ellipsis'); tr.appendChild(td); });
      st.appendChild(tr);
      if (isOpen) { const dr = document.createElement('tr'); const td = document.createElement('td'); td.colSpan = 7; td.style.cssText = 'border-bottom:1px solid rgb(42,42,42);padding:0 6px'; td.appendChild(detailForSource(r)); dr.appendChild(td); st.appendChild(dr); }
    });
    body.appendChild(st);
  };
  bE.onclick = () => { if (expanded.size) expanded.clear(); else sources.forEach(r => expanded.add(r.n)); render(); };

  // ---------- Saved copies (localStorage on gemini.google.com, newest 30 chats) ----------
  const CACHE = 'gs-export:v1:';
  const saveCopy = () => {
    if (!meta.id || (!queries.length && !sources.length)) return;
    const data = { at: meta.at, meta: { prompts: meta.prompts, promptList: meta.promptList, model: meta.model, queryCount: meta.queryCount, sourceCount: meta.sourceCount, domainCount: meta.domainCount, redditQueries: meta.redditQueries, redditSources: meta.redditSources },
      queries: queries.map(q => ({ n: q.n, turn: q.turn, query: q.query, prompt: q.prompt, reddit: q.reddit })),
      sources: sources.map(s => ({ n: s.n, turn: s.turn, raw: s.raw, url: s.url, host: s.host, title: s.title, snippet: s.snippet, supports: s.supports, segs: s.segs, prompt: s.prompt, reddit: s.reddit })) };
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
      const d = JSON.parse(localStorage.getItem(CACHE + id) || 'null'); if (!d || (!d.queries && !d.sources)) return false;
      queries.length = 0; sources.length = 0;
      (d.queries || []).forEach(q => queries.push(q));
      (d.sources || []).forEach(s => sources.push(s));
      Object.assign(meta, d.meta); meta.id = id; meta.at = d.at;
      return true;
    } catch (e) { return false; }
  };
  const when = iso => { try { const dt = new Date(iso); return dt.toLocaleDateString() + ' ' + dt.toLocaleTimeString().replace(/:\d\d(\s|$)/, '$1'); } catch (e) { return iso; } };

  // ---------- Live mode ----------
  let chatId = null, inFlight = false, lastSig = '', timer = null, live = true, closed = false;
  let settled = false, fromCopy = false, backoffUntil = 0, backoffMs = 0;
  const streaming = () => !!(document.querySelector('button[aria-label*="Stop"]') || document.querySelector('[data-test-id="stop-button"]'));
  const stateNote = () => fromCopy ? ' Saved copy from ' + when(meta.at) + '.' + (settled ? ' Refresh re-reads it.' : ' Checking for changes...') : !live ? ' Live is off.' : settled ? ' Live: waiting for a new prompt.' : ' Live, updated ' + new Date().toLocaleTimeString() + '.';
  const load = async (force) => {
    if (inFlight || !chatId) return; inFlight = true;
    try {
      const data = await fetchConv(chatId);
      backoffMs = 0; backoffUntil = 0;
      const sig = JSON.stringify(data).length + '|' + ((data && data[0] && data[0].length) || 0);
      if (sig !== lastSig || force) {
        lastSig = sig; fromCopy = false; meta.id = chatId; meta.at = new Date().toISOString();
        extract(data);
        settled = !streaming();
        render(); saveCopy();
        if (!meta.queryCount && !meta.sourceCount) status.textContent = 'No searches yet. If the answer is finished and this stays empty, Gemini answered without searching the web.' + stateNote();
      } else {
        settled = !streaming();
        if (meta.queryCount || meta.sourceCount) status.textContent = status.textContent.replace(/ (Live|Saved copy).*$/, stateNote());
      }
    } catch (e) {
      if (e.status === 429) { backoffMs = e.retryAfter > 0 ? e.retryAfter : Math.min(backoffMs ? backoffMs * 2 : 60000, 600000); backoffUntil = Date.now() + backoffMs; status.textContent = 'gemini.google.com is rate limiting this browser. Next try in ' + Math.ceil(backoffMs / 1000) + 's.'; }
      else status.textContent = 'Could not read the conversation: ' + e.message + '. Open a chat on gemini.google.com and try Refresh.';
    } finally { inFlight = false; }
  };
  const tick = async () => {
    if (closed) return;
    const id = idFromUrl();
    if (id !== chatId) {
      chatId = id; lastSig = ''; settled = false; fromCopy = false; queries.length = 0; sources.length = 0; expanded.clear(); body.innerHTML = ''; headline.textContent = ''; promptLine.textContent = '';
      if (!chatId) status.textContent = 'Waiting for a chat. Send your prompt here, and once Gemini has answered the queries and sources will appear.';
      else if (loadCopy(chatId)) { fromCopy = true; settled = false; render(); }
      else status.textContent = 'Reading conversation ' + chatId + ' ...';
    }
    const now = Date.now(), busy = streaming();
    if (busy) settled = false;
    const wanted = chatId && live && !settled && now >= backoffUntil;
    if (wanted) await load(false);
    else if (chatId && live && now < backoffUntil && !inFlight) status.textContent = status.textContent.replace(/Next try in \d+s\./, 'Next try in ' + Math.ceil((backoffUntil - now) / 1000) + 's.');
    timer = setTimeout(tick, busy ? 3500 : 2500);
  };
  bL.onclick = () => { live = !live; bL.textContent = live ? 'Live: on' : 'Live: off'; if (live) settled = false; render(); };
  bR.onclick = () => { if (!chatId) { status.textContent = 'Open a chat on gemini.google.com first (the URL should be /app/…).'; return; } settled = false; backoffUntil = 0; load(true); };
  bX.onclick = () => { closed = true; clearTimeout(timer); box.remove(); };
  showTab('table');
  tick();
})();
