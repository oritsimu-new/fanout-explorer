(async () => {
  // ChatGPT Fanout Explorer, a bookmarklet for chatgpt.com. Reads the chat you have open (live while ChatGPT answers, or a saved chat) and
  // lists every search ChatGPT sent to its web.run tool, the pages each one got back, and which of those were cited.
  // Read-only: it sends no prompts and changes nothing.
  const SEARCH_TYPES = ['fast', 'slow', 'image', 'product', 'news', 'video', 'finance', 'weather', 'sports', 'business'];
  const ACTION_TYPES = ['open', 'find', 'click', 'length', 'screenshot', 'scroll'];
  const OPEN_WEB = ['fast', 'slow', 'news', 'product', 'video', 'finance', 'weather', 'sports'];
  const NO_RESULTS = ['business', 'image'];   // their results are not exposed in the payload

  const rows = [];
  const batches = [];   // batches[b] = { turn, pos, entries: [{url, raw, host, key, cited}] }
  const turns = [];     // turns[t] = { keys, urls, hasAnswer, batches, prompt }
  const meta = { id: '', at: '', prompts: 0, promptList: [], fetched: 0, cited: 0, redditFetched: 0, redditCited: 0, unknownTurns: 0 };

  const hostOf = u => { try { return new URL(u).hostname.replace(/^www\./, '').toLowerCase(); } catch (e) { return ''; } };
  const normUrl = u => String(u || '').toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, '').split(/[?\x23]/)[0].replace(/\/$/, '');
  const shortUrl = u => { const s = String(u || '').replace(/^https?:\/\//, '').replace(/^www\./, '').split(/[?\x23]/)[0].replace(/\/$/, ''); return s.length > 90 ? s.slice(0, 88) + '…' : s; };
  const lockedHostOf = r => {
    if (r.domain) return r.domain.replace(/^https?:\/\//, '').replace(/^www\./, '').split('/')[0].toLowerCase();
    const m = r.query.match(/site:([^\s"']+)/i);
    return m ? m[1].replace(/^https?:\/\//, '').replace(/^www\./, '').split('/')[0].toLowerCase() : '';
  };
  const hostMatches = (h, locked) => h === locked || h.endsWith('.' + locked);

  const parseLine = (line, batch, prompt, turn) => {
    line = line.trim(); if (!line) return;
    const p = line.split('|');
    const type = p[0].trim();
    if (ACTION_TYPES.includes(type)) return;
    if (!SEARCH_TYPES.includes(type)) return;
    let query = '', days = '', domain = '', location = '';
    if (type === 'business') {
      // business|<location>|<categories;...>  or  business|<location>||<names;...>
      location = (p[1] || '').trim();
      query = p.slice(2).filter(x => x !== '').join(' ; ').trim();
    } else {
      // <type>|<query>            <type>|<query>|<days>            <type>|<query>|<days>|<domain>
      query = (p[1] || '').trim();
      if (p.length >= 3 && /^\d+$/.test(p[2].trim())) { days = p[2].trim(); domain = (p[3] || '').trim(); }
      else if (p.length >= 3) { query = p.slice(1).join('|').trim(); }
    }
    if (!query) return;
    const reddit = /reddit/i.test(query + ' ' + domain) ? 'yes' : 'no';
    rows.push({ n: rows.length + 1, batch, turn, type, query, days, domain, reddit, location, prompt, results: '', cited: '', locked: '', batchResults: '', batchCited: '', batchDomains: '', sources: [] });
  };

  // Active branch of the conversation tree, oldest first.
  const activePath = (j) => {
    const out = [];
    let id = j.current_node;
    const seen = new Set();
    while (id && j.mapping[id] && !seen.has(id)) { seen.add(id); out.push(j.mapping[id]); id = j.mapping[id].parent; }
    return out.reverse();
  };

  // Citations: what the answer showed as sources (inline citation chips and the Sources footnote).
  // Two numbering schemes exist: item refs use the round's position inside the turn (0, 1, 2...), while the
  // cite markers in matched_text use the round's long id. Both are normalised to turn|round|type|index.
  const collectCitations = (m, t, turnNo, bigToPos) => {
    const refs = (m.metadata || {}).content_references || [];
    const addUrl = u => { if (u) t.urls.add(normUrl(u)); };
    const addRef = r => { if (r && r.turn_index != null) t.keys.add(turnNo + '|' + r.turn_index + '|' + r.ref_type + '|' + r.ref_index); };
    refs.forEach(c => {
      if (!c || !c.type) return;
      if (c.type === 'grouped_webpages' || c.type === 'webpage' || c.type === 'webpage_extended' || c.type === 'sources_footnote' || c.type === 'news' || c.type === 'products') {
        (c.items || []).forEach(it => { addUrl(it.url); (it.refs || []).forEach(addRef); });
        (c.sources || []).forEach(it => { addUrl(it.url); (it.refs || []).forEach(addRef); });
        if (c.url) addUrl(c.url);
        let mm; const re = /turn(\d+)([a-z]+)(\d+)/g; const mt = String(c.matched_text || '');
        while ((mm = re.exec(mt))) { const pos = bigToPos[mm[1]]; if (pos != null) t.keys.add(turnNo + '|' + pos + '|' + mm[2] + '|' + mm[3]); }
      }
    });
  };

  const extract = (j) => {
    rows.length = 0; batches.length = 0; turns.length = 0;
    meta.fetched = 0; meta.cited = 0; meta.redditFetched = 0; meta.redditCited = 0; meta.unknownTurns = 0; meta.promptList = [];
    let prompt = '', batch = 0, turn = 0, cur = null;
    const bigToPos = {};   // long round id (from tool results and cite markers) -> position of the round inside its turn
    const addEntry = (b, e, pos) => {
      if (!e || !e.url) return;
      const url = normUrl(e.url);
      if (b.seen.has(url)) return; b.seen.add(url);
      const rid = e.ref_id || {};
      b.entries.push({ url, raw: String(e.url), host: hostOf(e.url), key: b.turn + '|' + pos + '|' + rid.ref_type + '|' + rid.ref_index, cited: false });
    };
    activePath(j).forEach(n => {
      const m = n.message; if (!m || !m.author) return;
      const role = m.author.role;
      const md = m.metadata || {};
      if (role === 'user' && m.content && m.content.parts) {
        prompt = m.content.parts.filter(x => typeof x === 'string').join(' ').replace(/\s+/g, ' ').trim();
        turn++; turns[turn] = { keys: new Set(), urls: new Set(), hasAnswer: false, batches: [], prompt };
        meta.promptList.push(prompt);
        return;
      }
      if (!turns[turn]) turns[turn] = { keys: new Set(), urls: new Set(), hasAnswer: false, batches: [], prompt: '' };
      const T = turns[turn];
      if (m.recipient === 'web.run' && m.content) {
        const text = typeof m.content.text === 'string' ? m.content.text : (m.content.parts || []).filter(x => typeof x === 'string').join('\n');
        if (!text) return;
        batch++; cur = { turn, pos: T.batches.length, entries: [], seen: new Set() }; batches[batch] = cur; T.batches.push(batch);
        text.split(/\r?\n/).forEach(l => parseLine(l, batch, prompt, turn));
        return;
      }
      if (role === 'tool' && cur && md.search_result_groups) {
        // Results shown for the most recent round. Their ref_id.turn_index is the round's long id.
        (md.search_result_groups || []).forEach(g => (g.entries || []).forEach(e => {
          if (e && e.ref_id && e.ref_id.turn_index != null) bigToPos[e.ref_id.turn_index] = cur.pos;
          addEntry(cur, e, cur.pos);
        }));
        return;
      }
      if (role === 'assistant') {
        if (md.search_result_groups) {
          // The full retrieval pool for the turn, attached to the answer. ref_id.turn_index here is the round's position (0, 1, 2...).
          (md.search_result_groups || []).forEach(g => (g.entries || []).forEach(e => {
            let pos = e && e.ref_id ? e.ref_id.turn_index : null;
            if (pos != null && T.batches[pos] == null && bigToPos[pos] != null) pos = bigToPos[pos]; // long id instead of position
            const bn = pos != null && T.batches[pos] != null ? T.batches[pos] : T.batches[T.batches.length - 1];
            if (bn != null) addEntry(batches[bn], e, batches[bn].pos);
          }));
        }
        if (md.content_references) collectCitations(m, T, turn, bigToPos);
        if (m.end_turn === true || (md.content_references || []).length) T.hasAnswer = true;
      }
    });
    meta.prompts = turn;

    const seenAll = new Set(); const seenCited = new Set();
    batches.forEach(b => {
      if (!b) return;
      const t = turns[b.turn] || { keys: new Set(), urls: new Set() };
      b.entries.forEach(e => {
        e.cited = t.keys.has(e.key) || t.urls.has(e.url);
        if (!seenAll.has(e.url)) { seenAll.add(e.url); meta.fetched++; if (hostMatches(e.host, 'reddit.com')) meta.redditFetched++; }
        if (e.cited && !seenCited.has(e.url)) { seenCited.add(e.url); meta.cited++; if (hostMatches(e.host, 'reddit.com')) meta.redditCited++; }
      });
    });
    const topDomains = (entries) => {
      const c = {}; entries.forEach(e => { c[e.host] = (c[e.host] || 0) + 1; });
      return Object.keys(c).sort((a, b) => c[b] - c[a]).slice(0, 3).map(h => h + ' ' + c[h]).join(', ');
    };
    rows.forEach(r => {
      const b = batches[r.batch] || { entries: [], turn: 0 };
      const ents = b.entries;
      const known = !!(turns[b.turn] && turns[b.turn].hasAnswer); // false while the answer is still being written, or if it is not stored
      r.known = known;
      r.batchResults = ents.length; r.batchCited = known ? ents.filter(e => e.cited).length : ''; r.batchDomains = topDomains(ents);
      if (NO_RESULTS.includes(r.type)) return;
      const locked = lockedHostOf(r); r.locked = locked;
      const mine = locked ? ents.filter(e => hostMatches(e.host, locked)) : (OPEN_WEB.includes(r.type) ? ents : null);
      if (!mine) return;
      r.sources = mine.slice().sort((a, b) => (b.cited - a.cited) || a.host.localeCompare(b.host) || a.url.localeCompare(b.url));
      r.results = mine.length;
      r.cited = known ? mine.filter(e => e.cited).length : '';
    });
    meta.unknownTurns = turns.filter(t => t && !t.hasAnswer).length;
  };

  // ---------- Sorting (click a column header; exports follow the current order, n keeps the original order) ----------
  const COLS = ['n', 'batch', 'type', 'query', 'days', 'domain', 'results', 'cited'];
  const NUMERIC = ['n', 'batch', 'days', 'results', 'cited'];
  let sortKey = 'n', sortDir = 1;
  const shown = r => r.type === 'business' ? r.location + ' : ' + r.query : r.query;
  const cell = (r, k) => k === 'query' ? shown(r) : r[k];
  const view = () => {
    const v = rows.slice();
    v.sort((a, b) => {
      const x = cell(a, sortKey), y = cell(b, sortKey);
      if (x === '' && y !== '') return 1; if (y === '' && x !== '') return -1; // empties always last
      const c = NUMERIC.includes(sortKey) ? Number(x) - Number(y) : String(x).localeCompare(String(y), undefined, { sensitivity: 'base' });
      return (c * sortDir) || (a.n - b.n);
    });
    return v;
  };

  // ---------- Exports ----------
  const csvCell = s => '"' + String(s == null ? '' : s).replace(/"/g, '""') + '"';
  const srcList = (r, onlyCited) => r.sources.filter(e => !onlyCited || e.cited).map(e => e.raw).join(' | ');
  const toCSV = () => {
    const head = ['n', 'batch', 'type', 'query', 'freshness_days', 'domain', 'results', 'cited', 'reddit', 'location', 'locked_host', 'round_results', 'round_cited', 'round_top_domains', 'sources', 'cited_sources', 'prompt', 'conversation_id', 'captured_at'];
    return [head.join(',')].concat(view().map(r => [r.n, r.batch, r.type, r.query, r.days, r.domain, r.results, r.cited, r.reddit, r.location, r.locked, r.batchResults, r.batchCited, r.batchDomains, srcList(r, false), srcList(r, true), r.prompt, meta.id, meta.at].map(csvCell).join(','))).join('\n');
  };
  // One row per search line, followed by one row per page it got back (row_kind = search / source). Filter on row_kind in a spreadsheet.
  const toSourcesCSV = () => {
    const head = ['row_kind', 'n', 'batch', 'type', 'query', 'freshness_days', 'domain', 'results', 'cited', 'source_url', 'source_domain', 'source_cited', 'prompt', 'conversation_id', 'captured_at'];
    const out = [head.join(',')];
    view().forEach(r => {
      out.push(['search', r.n, r.batch, r.type, r.query, r.days, r.domain, r.results, r.cited, '', '', '', r.prompt, meta.id, meta.at].map(csvCell).join(','));
      r.sources.forEach(e => out.push(['source', r.n, r.batch, r.type, r.query, r.days, r.domain, r.results, r.cited, e.raw, e.host, r.known ? (e.cited ? 'yes' : 'no') : '', r.prompt, meta.id, meta.at].map(csvCell).join(',')));
    });
    return out.join('\n');
  };
  const toTSV = () => ['n\tbatch\ttype\tquery\tfreshness_days\tdomain\tresults\tcited\treddit\tlocation\tprompt'].concat(view().map(r => [r.n, r.batch, r.type, r.query, r.days, r.domain, r.results, r.cited, r.reddit, r.location, r.prompt].join('\t'))).join('\n');
  const queriesOnly = () => view().map(r => r.query).join('\n');
  const download = (text, name) => {
    const blob = new Blob(['\uFEFF' + text], { type: 'text/csv;charset=utf-8' });
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name;
    document.body.appendChild(a); a.click(); setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
  };
  const stamp = () => 'chatgpt-fanout-' + meta.id.slice(0, 8) + '-' + meta.at.slice(0, 16).replace(/[:T]/g, '-');

  // ---------- Index tab: what every column means, in plain English ----------
  const INDEX = [
    ['prompt (above the table)', 'The message you sent that started the searches. With several prompts in one chat, all of them are listed in order.', ''],
    ['n', 'The line number, in the order ChatGPT ran the searches. 1 is the first search of the chat.', 'n = 43 means it was the 43rd search in this chat.'],
    ['batch', 'ChatGPT searches in rounds. It sends a few searches together, reads what came back, then may send another round. batch is the round number.', 'All lines with batch = 2 were sent together, after ChatGPT had read the results of batch 1.'],
    ['type', 'What kind of search it was. See the Types tab for the full list.', 'fast = a normal web search. business = a places search. image = a picture search. slow = a deeper web search.'],
    ['query', 'The exact words ChatGPT sent to search, including any site: and quotes. This is the fan-out term.', 'query = "Shrimp Shack Camden" reviews portion sauce birthday'],
    ['days', 'How recent the pages had to be, in days. 30 = last month. 365 = last year. 3650 = last ten years. Empty = no limit.', 'days = 365 on a Reddit search means ChatGPT only wanted Reddit posts from the last year.'],
    ['domain', 'When filled, ChatGPT only searched that one website. Empty = the whole web. A site: inside the query does the same job.', 'domain = reddit.com means only Reddit was searched. site:linkedin.com/jobs in the query means only LinkedIn jobs pages.'],
    ['results', 'How many pages came back. For a line with a domain or a site:, it is the count from that website in that round. For an open search, it is the count for the whole round. ChatGPT records results per round, not per query, so lines in the same round that search the same place show the same number. Empty for business and image lines, whose results are not exposed.', 'results = 12 with domain = sexyfish.com means 12 pages from sexyfish.com came back. results = 0 with domain = reddit.com means the Reddit search returned nothing, so Reddit could not be cited from it.'],
    ['cited', 'How many of those pages were shown as a source in the answer, either as a citation chip in the text or in the Sources list at the end. Empty while the answer is still being written, or when the answer for that prompt is not stored in the chat.', 'results = 11, cited = 3 means 11 pages came back and 3 were shown as sources. results = 84, cited = 0 means ChatGPT read 84 pages and credited none of them.'],
    ['+ (first column)', 'Opens the line to show the pages it got back. A tick marks the ones shown as a source in the answer, a dot marks the rest. The first line inside groups them by website with the cited count per website. Expand all opens every line at once, for screenshots.', '✓ apps.shopify.com/tidio-chat/reviews (cited)  ·  reddit.com/r/shopify/comments/... (fetched, not cited)'],
    ['headline (above the table)', 'Fetched = pages that came back across the whole chat, each counted once. Shown as sources = how many of those appeared in an answer. Reddit = the same two numbers for reddit.com only.', 'Fetched 204 pages, 19 shown as sources. Reddit: 57 fetched, 5 cited.'],
    ['highlighted rows', 'Lines where the query or the domain mentions Reddit.', ''],
    ['reddit (exports only)', 'yes if the query or the domain mentions Reddit, otherwise no.', ''],
    ['location (exports only)', 'For business lines, the place ChatGPT searched around.', 'location = West Finchley, London, UK'],
    ['locked_host (CSV only)', 'The website a line was limited to, taken from the domain column or the site: in the query.', 'locked_host = linkedin.com'],
    ['round_results, round_cited, round_top_domains (CSV only)', 'For the whole round the line belongs to: How many pages came back, how many were shown as sources, and the three websites with the most pages.', 'round_top_domains = opentable.co.uk 4, wanderlog.com 1, tripadvisor.co.uk 1'],
    ['sources, cited_sources (CSV only)', 'The pages behind the + for that line, and the ones that were cited, as lists separated by |.', ''],
    ['conversation_id, captured_at (exports only)', 'The chat ID from the URL, and when you exported.', ''],
    ['Copy queries only', 'Copies the query column, one per line, ready for a spreadsheet or a keyword tool.', ''],
    ['Copy table (TSV)', 'Copies the table plus the prompt as text you can paste straight into Google Sheets or Excel.', ''],
    ['Download CSV', 'One row per search line, with every column including the sources lists.', ''],
    ['Download sources CSV', 'The expanded view as a file: Each search line, followed by one row per page it got back, with source_url, source_domain and source_cited. Filter row_kind = source to work with the pages only.', ''],
    ['Sorting', 'Click a column header to sort by it, click again to reverse. Empty cells always go last. Copies and the CSV follow the sort you see. Sort by n to get back to the original order.', ''],
    ['Saved copies', 'Every chat the panel reads is kept in this browser. Reopening a chat shows the saved copy at once, without asking ChatGPT again. The newest 30 chats are kept. Refresh re-reads the live chat.', 'Status line: Saved copy from 06/09/2026 11:20. Refresh re-reads it.'],
    ['429 / rate limiting', 'If ChatGPT refuses reads (error 429), the panel keeps showing what it has and waits before trying again, a minute at first, longer if it keeps happening. Live reads only happen while an answer is being written, so a finished chat costs one read, or none when a saved copy exists.', ''],
    ['Live: on / off', 'While on, the panel re-reads the chat every few seconds while ChatGPT is answering, and new lines appear as each round of searching finishes. Once the answer is done it stops reading until you send another prompt. Open it on a new chat, send your prompt, and watch it fill. Turn it off to stop all reads. Refresh re-reads once.', 'Open a new chat, click the bookmark, type "best AI live chat tools for a small Shopify store", send, and the rounds appear one by one.']
  ];

  // ---------- Types tab: every line type seen in ChatGPT's web.run calls ----------
  const TYPES = [
    ['fast', 'search, listed', 'A normal web search. The workhorse, most lines are this type.', 'fast|query|days|domain, the last two optional', 'fast|Tidio pricing Lyro AI 2026 official|3650|tidio.com'],
    ['slow', 'search, listed', 'A deeper web search. Seen so far on subreddit-specific queries, without a days window.', 'slow|query', 'slow|site:reddit.com/r/shopify Tidio Lyro Shopify review'],
    ['business', 'search, listed', 'A places search, like a map search, for local questions. Results are not exposed in the payload, so results and cited stay empty.', 'business|location|categories separated by ;  or  business|location||names separated by ;', 'business|West Finchley, London, UK|seafood boil;Cajun seafood;lobster restaurant'],
    ['image', 'search, listed', 'A picture search for the images shown in the answer. It does not feed the text. Results are not exposed.', 'image|query|days, days optional', 'image|Scott’s Mayfair restaurant seafood'],
    ['product', 'search, reported', 'A shopping search of product catalogues. Reported by other researchers, not yet seen in these chats. Listed if it appears.', 'product|query', ''],
    ['genui_run', 'other, reported', 'Builds a widget (a chart, a table) rather than searching. Reported by other researchers. Ignored.', '', ''],
    ['open', 'action, ignored', 'Opens one of the results that came back, by its reference number, to read the page.', 'open|turnXsearchN', 'open|turn447052search12'],
    ['find', 'action, ignored', 'Finds text inside an opened page.', 'find|turnXsearchN|text', 'find|turn447052search12|Badeparadies'],
    ['click', 'action, ignored', 'Follows a link on an opened page.', 'click|turnXsearchN|link number', 'click|turn878257search1|0'],
    ['length', 'setting, ignored', 'A hint for how long the answer should be. Always the last line of a round.', 'length|short  or  length|medium', 'length|medium'],
    ['Result types', 'for reference', 'Each page that comes back is tagged with where it came from: search (web), news, reddit (a separate Reddit source), business (places), image, view (a page ChatGPT opened). Reddit pages carrying their own tag is why Reddit can be fetched heavily and still cited rarely: it is a separate pool.', '', '']
  ];

  // ---------- Panel ----------
  const old = document.getElementById('fo-export'); if (old) old.remove();
  const box = document.createElement('div'); box.id = 'fo-export';
  box.style.cssText = 'position:fixed;top:12px;right:12px;z-index:2147483647;width:min(1040px,96vw);max-height:88vh;overflow:auto;background:rgb(17,17,17);color:rgb(235,235,235);font:13px/1.4 -apple-system,Segoe UI,Helvetica,Arial,sans-serif;border:1px solid rgb(70,70,70);border-radius:10px;padding:14px;box-shadow:0 8px 30px rgba(0,0,0,.5);text-align:left';
  const bar = document.createElement('div'); bar.style.cssText = 'display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-bottom:10px';
  const title = document.createElement('strong'); title.textContent = 'ChatGPT Fanout Explorer'; title.style.cssText = 'font-size:14px;margin-right:auto';
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

  // Reference tables (Index and Types tabs)
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
  refTable(index, 'Every line in the table is one search ChatGPT ran behind the scenes to answer this chat. Here is what each part means.', ['Column', 'What it means', 'Example'], INDEX, ['width:170px', '', 'width:34' + String.fromCharCode(37)]);
  refTable(types, 'Every kind of line ChatGPT writes to its search tool. "listed" types appear in the table, "ignored" ones are page actions or settings, not searches. "reported" means described by other researchers but not yet seen in these chats.', ['Type', 'Kind', 'What it does', 'Shape', 'Example'], TYPES, ['width:90px', 'width:110px', '', 'width:200px;font-family:Menlo,Consolas,monospace;font-size:12px', 'font-family:Menlo,Consolas,monospace;font-size:12px']);

  // ---------- Table ----------
  const expanded = new Set();
  const detailFor = (r) => {
    const wrap = document.createElement('div'); wrap.style.cssText = 'font-size:12px;line-height:1.35;color:rgb(200,200,200);padding:2px 0 8px 26px';
    if (NO_RESULTS.includes(r.type)) { wrap.textContent = 'Results for ' + r.type + ' lines are not exposed in the payload.'; return wrap; }
    if (!r.sources.length) { wrap.textContent = 'Nothing came back for this search.'; return wrap; }
    const byHost = {}; r.sources.forEach(e => { const h = byHost[e.host] || (byHost[e.host] = { n: 0, c: 0 }); h.n++; if (e.cited) h.c++; });
    const sum = document.createElement('div'); sum.style.cssText = 'margin-bottom:4px;color:rgb(235,235,235)';
    sum.textContent = r.sources.length + ' page' + (r.sources.length === 1 ? '' : 's') + (r.known ? ', ' + r.sources.filter(e => e.cited).length + ' cited' : '') + '. ' + Object.keys(byHost).sort((a, b) => byHost[b].n - byHost[a].n).map(h => h + ' ' + byHost[h].n + (r.known ? ' (' + byHost[h].c + ' cited)' : '')).join(', ');
    const list = document.createElement('div'); if (r.sources.length > 6) list.style.cssText = 'column-count:2;column-gap:28px';
    r.sources.forEach(e => {
      const d = document.createElement('div'); d.style.cssText = 'break-inside:avoid;white-space:nowrap;overflow:hidden;text-overflow:ellipsis';
      const mark = document.createElement('span'); mark.textContent = e.cited ? '✓ ' : '· '; mark.style.cssText = e.cited ? 'color:rgb(120,220,140);font-weight:700' : 'color:rgb(120,120,120)';
      const a = document.createElement('a'); a.href = e.raw; a.target = '_blank'; a.rel = 'noopener'; a.textContent = shortUrl(e.raw); a.title = e.raw; a.style.cssText = 'color:' + (e.cited ? 'rgb(235,235,235)' : 'rgb(170,170,170)') + ';text-decoration:none';
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
    const red = rows.filter(r => r.reddit === 'yes').length;
    const nb = rows.length ? rows[rows.length - 1].batch : 0;
    status.textContent = rows.length + ' search line(s) in ' + nb + ' round(s) across ' + meta.prompts + ' prompt(s). ' + red + ' mention Reddit.' + stateNote();
    headline.textContent = rows.length ? 'Fetched ' + meta.fetched + ' page(s), ' + meta.cited + ' shown as sources in the answers. Reddit: ' + meta.redditFetched + ' fetched, ' + meta.redditCited + ' cited.' + (meta.unknownTurns ? ' (' + meta.unknownTurns + ' prompt(s) have no finished answer yet, so their cited counts are left empty.)' : '') : '';
    promptLine.textContent = promptSummary();
    bE.textContent = expanded.size ? 'Collapse all' : 'Expand all';
    if (!rows.length) return;
    const t = document.createElement('table'); t.style.cssText = 'border-collapse:collapse;width:100' + String.fromCharCode(37) + ';table-layout:fixed';
    const WIDTHS = { n: 40, batch: 52, type: 62, days: 52, domain: 165, results: 62, cited: 52 };   // query takes the rest
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
      const row = document.createElement('tr'); if (r.reddit === 'yes') row.style.background = 'rgb(70,45,10)';
      const tdp = document.createElement('td'); tdp.style.cssText = 'border-bottom:1px solid rgb(42,42,42);padding:2px 0 2px 4px;vertical-align:top';
      const plus = document.createElement('button'); plus.type = 'button'; plus.textContent = isOpen ? '−' : '+'; plus.title = isOpen ? 'Hide the pages' : 'Show the pages that came back';
      plus.style.cssText = 'width:18px;height:18px;line-height:16px;padding:0;background:rgb(43,43,43);color:rgb(235,235,235);border:1px solid rgb(90,90,90);border-radius:4px;cursor:pointer;font:12px/16px inherit';
      plus.onclick = () => { if (expanded.has(r.n)) expanded.delete(r.n); else expanded.add(r.n); render(); };
      tdp.appendChild(plus); row.appendChild(tdp);
      COLS.forEach(k => {
        const td = document.createElement('td'); td.textContent = cell(r, k);
        td.style.cssText = 'border-bottom:1px solid rgb(42,42,42);padding:4px 6px;vertical-align:top;' + (k === 'query' ? 'word-break:break-word' : 'white-space:nowrap;overflow:hidden;text-overflow:ellipsis') + (k === 'cited' && r.cited !== '' && r.cited > 0 ? ';color:rgb(120,220,140);font-weight:600' : '');
        if (k === 'domain' && r.domain) td.title = r.domain;
        row.appendChild(td);
      });
      t.appendChild(row);
      if (isOpen) {
        const dr = document.createElement('tr'); if (r.reddit === 'yes') dr.style.background = 'rgb(50,34,10)';
        const td = document.createElement('td'); td.colSpan = COLS.length + 1; td.style.cssText = 'border-bottom:1px solid rgb(42,42,42);padding:0 6px';
        td.appendChild(detailFor(r)); dr.appendChild(td); t.appendChild(dr);
      }
    });
    body.appendChild(t);
  };
  bE.onclick = () => { if (expanded.size) expanded.clear(); else rows.forEach(r => expanded.add(r.n)); render(); };

  // ---------- Saved copies: every chat read once is kept in this browser (localStorage on chatgpt.com) ----------
  // Reopening a chat shows the saved copy at once, with no request. The newest 30 chats are kept.
  const CACHE = 'fo-export:v1:';
  const saveCopy = () => {
    if (!meta.id || !rows.length) return;
    const data = { at: meta.at, meta: { prompts: meta.prompts, promptList: meta.promptList, fetched: meta.fetched, cited: meta.cited, redditFetched: meta.redditFetched, redditCited: meta.redditCited, unknownTurns: meta.unknownTurns },
      rows: rows.map(r => ({ n: r.n, batch: r.batch, turn: r.turn, type: r.type, query: r.query, days: r.days, domain: r.domain, reddit: r.reddit, location: r.location, prompt: r.prompt, results: r.results, cited: r.cited, locked: r.locked, batchResults: r.batchResults, batchCited: r.batchCited, batchDomains: r.batchDomains, known: r.known, sources: r.sources.map(e => [e.raw, e.host, e.cited ? 1 : 0]) })) };
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
      d.rows.forEach(r => { r.sources = (r.sources || []).map(x => ({ raw: x[0], url: normUrl(x[0]), host: x[1], cited: !!x[2] })); rows.push(r); });
      Object.assign(meta, d.meta); meta.id = id; meta.at = d.at;
      return true;
    } catch (e) { return false; }
  };
  const when = iso => { try { const d = new Date(iso); return d.toLocaleDateString() + ' ' + d.toLocaleTimeString().replace(/:\d\d(\s|$)/, '$1'); } catch (e) { return iso; } };

  // ---------- Live mode: watch the chat in the URL and re-read it only while ChatGPT is answering ----------
  // A finished chat is read once (or not at all when a saved copy exists). Polling only happens while the answer is being
  // written, plus a short grace period after it ends. 429 answers from ChatGPT trigger a growing pause between tries.
  let chatId = null, token = '', inFlight = false, lastSig = '', timer = null, live = true, closed = false;
  let settled = false, wasStreaming = false, graceUntil = 0, backoffUntil = 0, backoffMs = 0, fromCopy = false;
  const idFromUrl = () => { const m = location.pathname.match(/\/c\/([0-9a-fA-F-]{16,})/); return m ? m[1] : ''; };
  const streaming = () => !!document.querySelector('button[data-testid="stop-button"]');
  const getToken = async () => {
    if (token) return token;
    const s = await (await fetch('/api/auth/session', { credentials: 'include' })).json();
    token = s && s.accessToken; if (!token) throw new Error('no access token. Are you logged in?');
    return token;
  };
  const stateNote = () => fromCopy ? ' Saved copy from ' + when(meta.at) + '.' + (settled ? ' Refresh re-reads it.' : ' Reading the rest...') : !live ? ' Live is off.' : settled ? ' Live: waiting for a new prompt.' : ' Live, updated ' + new Date().toLocaleTimeString() + '.';
  const load = async (force) => {
    if (inFlight || !chatId) return; inFlight = true;
    try {
      const r = await fetch('/backend-api/conversation/' + chatId, { headers: { Authorization: 'Bearer ' + await getToken() } });
      if (r.status === 429) {
        const ra = Number(r.headers.get('Retry-After')) * 1000;
        backoffMs = ra > 0 ? ra : Math.min(backoffMs ? backoffMs * 2 : 60000, 600000);
        backoffUntil = Date.now() + backoffMs;
        throw new Error('429');
      }
      if (r.status === 401 || r.status === 403) { token = ''; throw new Error('HTTP ' + r.status + ', retrying'); }
      if (!r.ok) throw new Error('HTTP ' + r.status);
      backoffMs = 0; backoffUntil = 0;
      const txt = await r.text();
      const sig = txt.length + '|' + (txt.match(/"current_node":\s*"([^"]+)"/) || ['', ''])[1];
      if (sig !== lastSig || force) {
        lastSig = sig; fromCopy = false;
        meta.id = chatId; meta.at = new Date().toISOString();
        extract(JSON.parse(txt));
        settled = !streaming() && Date.now() > graceUntil && meta.unknownTurns === 0;
        render(); saveCopy();
        if (!rows.length) status.textContent = 'No search lines yet. If the answer is finished and this stays empty, it never searched the web, or the format moved again.' + stateNote();
      } else {
        settled = !streaming() && Date.now() > graceUntil && meta.unknownTurns === 0;
        if (rows.length) status.textContent = status.textContent.replace(/ (Live|Saved copy).*$/, stateNote());
      }
    } catch (e) {
      if (e.message === '429') status.textContent = 'ChatGPT is rate limiting this browser (429). ' + (rows.length ? 'Showing the ' + (fromCopy ? 'saved copy from ' + when(meta.at) : 'last read') + '. ' : '') + 'Next try in ' + Math.ceil(backoffMs / 1000) + 's.';
      else status.textContent = 'Could not read the conversation: ' + e.message;
    } finally { inFlight = false; }
  };
  const tick = async () => {
    if (closed) return;
    const id = idFromUrl();
    if (id !== chatId) {
      chatId = id; lastSig = ''; settled = false; graceUntil = 0; fromCopy = false; rows.length = 0; expanded.clear(); body.innerHTML = ''; headline.textContent = ''; promptLine.textContent = '';
      if (!chatId) status.textContent = 'Waiting for a chat. Send your prompt here and the searches will appear as ChatGPT runs them.';
      else if (loadCopy(chatId)) { fromCopy = true; settled = meta.unknownTurns === 0 && !streaming(); render(); }
      else status.textContent = 'Reading conversation ' + chatId + ' ...';
    }
    const now = Date.now(), busy = streaming();
    if (busy) settled = false;
    if (wasStreaming && !busy) graceUntil = now + 15000;   // the answer just finished: read a couple more times to pick up the final pool and citations
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
