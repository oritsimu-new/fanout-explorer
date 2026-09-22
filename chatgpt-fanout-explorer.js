(async () => {
  // ChatGPT Fanout Explorer, a bookmarklet for chatgpt.com. Reads the chat you have open (live while ChatGPT answers, or a saved chat) and
  // lists every search ChatGPT sent to its web.run tool, the pages each one got back, and which of those were cited.
  // Read-only: it sends no prompts and changes nothing.
  const SEARCH_TYPES = ['fast', 'slow', 'image', 'product', 'news', 'video', 'finance', 'weather', 'sports', 'business'];
  const ACTION_TYPES = ['open', 'find', 'click', 'length', 'screenshot', 'scroll'];
  const OPEN_WEB = ['fast', 'slow', 'news', 'product', 'video', 'finance', 'weather', 'sports', 'web'];
  // From September 2026 ChatGPT no longer saves the query text with the chat: the tool message body is
  // empty, the recipient is 'web' on some accounts, and the freshness window and site limit are gone.
  // The queries do still reach the browser in two places, and this reads both:
  //   - while ChatGPT answers, the stream carries metadata.search_model_queries for the first search
  //     batch. The fetch tap below catches it as it passes and keeps it per chat in this browser.
  //   - in Work workspaces the saved chat keeps metadata.search_queries as [{type, q}].
  // A round with no query from either source is kept and labelled rather than dropped.
  const HIDDEN_Q = 'query not exposed by ChatGPT';
  const HIDDEN_FIRST = 'query not captured: the bookmark was not running when this prompt was sent';
  const HIDDEN_LATER = 'follow-up batch: ChatGPT does not send these queries';
  const BUILD = '2026-09-22.3';   // shown in the panel so a stale install can be spotted at a glance
  const NO_RESULTS = ['business', 'image'];   // their results are not exposed in the payload

  const rows = [];
  const batches = [];   // batches[b] = { turn, pos, entries: [{url, raw, host, key, cited}] }
  const turns = [];     // turns[t] = { keys, urls, hasAnswer, batches, prompt }
  const meta = { id: '', title: '', at: '', prompts: 0, promptList: [], fetched: 0, cited: 0, redditFetched: 0, redditCited: 0, unknownTurns: 0, hiddenQueries: 0, liveRounds: 0, savedRounds: 0 };

  const hostOf = u => { try { return new URL(u).hostname.replace(/^www\./, '').toLowerCase(); } catch (e) { return ''; } };
  const normUrl = u => String(u || '').toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, '').split(/[?\x23]/)[0].replace(/\/$/, '');
  const shortUrl = u => { const s = String(u || '').replace(/^https?:\/\//, '').replace(/^www\./, '').split(/[?\x23]/)[0].replace(/\/$/, ''); return s.length > 90 ? s.slice(0, 88) + '…' : s; };
  const lockedHostOf = r => {
    if (r.domain) return r.domain.replace(/^https?:\/\//, '').replace(/^www\./, '').split('/')[0].toLowerCase();
    const m = r.query.match(/site:([^\s"']+)/i);
    return m ? m[1].replace(/^https?:\/\//, '').replace(/^www\./, '').split('/')[0].toLowerCase() : '';
  };
  const hostMatches = (h, locked) => h === locked || h.endsWith('.' + locked);

  // ---------- Live query capture ----------
  // Since September 2026 ChatGPT strips the query text from the saved chat, but while it answers it still
  // streams the first search batch's queries to the browser as metadata.search_model_queries, and Work
  // workspaces keep metadata.search_queries in the saved chat. This taps the page's own fetch, reads the
  // answer stream as it passes and keeps the queries per chat in this browser, so a chat captured live keeps
  // its queries for good. Installed once per page and kept after the panel closes, so every prompt sent in
  // this tab from now on is captured. Nothing is sent anywhere.
  const QSTORE = 'fo-export:q:v1';
  const readQ = () => { try { return JSON.parse(localStorage.getItem(QSTORE) || '{}') || {}; } catch (e) { return {}; } };
  const writeQ = (all) => {
    try {
      const ids = Object.keys(all).sort((a, b) => (all[b]._at || 0) - (all[a]._at || 0));
      ids.slice(40).forEach(k => { delete all[k]; });   // keep the 40 most recent chats
      localStorage.setItem(QSTORE, JSON.stringify(all));
    } catch (e) {}
  };
  const queriesFrom = (md) => {
    if (!md) return null;
    if (md.search_model_queries && Array.isArray(md.search_model_queries.queries)) {
      const q = md.search_model_queries.queries.filter(x => typeof x === 'string' && x.trim()).map(x => x.trim());
      return q.length ? { q, t: [] } : null;
    }
    if (Array.isArray(md.search_queries) && md.search_queries.length) {
      const q = [], t = [];
      md.search_queries.forEach(x => { if (x && typeof x.q === 'string' && x.q.trim()) { q.push(x.q.trim()); t.push(typeof x.type === 'string' ? x.type : ''); } });
      return q.length ? { q, t } : null;
    }
    return null;
  };
  const stashQueries = (convId, parentId, msgId, found) => {
    if (!convId || !found) return;
    const all = readQ(); const c = all[convId] || (all[convId] = {}); c._at = Date.now();
    const rec = { q: found.q, t: found.t, msg: msgId || '', at: Date.now() };
    if (parentId) c[parentId] = rec;
    if (msgId) c['@' + msgId] = rec;
    if (!parentId && !msgId) c['n' + Object.keys(c).length] = rec;
    writeQ(all);
    if (window.__foTap && window.__foTap.onCapture) { try { window.__foTap.onCapture(convId); } catch (e) {} }
  };
  if (!window.__foTap) {
    const tap = window.__foTap = { onCapture: null, captured: 0, streams: 0 };
    const nativeFetch = window.fetch;
    const chatIdNow = () => (location.pathname.split('/c/')[1] || '').split(/[?\x23]/)[0];
    const onEvent = (v, st) => {
      const payload = v && v.v;
      const cid = (v && v.conversation_id) || (payload && payload.conversation_id) || st.cid || chatIdNow();
      if (cid) st.cid = cid;
      const msg = payload && payload.message;
      if (msg && msg.id) {
        st.lastMsg = msg.id; st.lastParent = (msg.metadata && msg.metadata.parent_id) || '';
        const f = queriesFrom(msg.metadata);
        if (f) { tap.captured++; stashQueries(cid, st.lastParent, msg.id, f); }
        return;
      }
      const patches = v && v.o === 'patch' && Array.isArray(payload) ? payload : (v && v.p ? [v] : []);
      patches.forEach(pt => {
        if (!pt || typeof pt.p !== 'string') return;
        let f = null;
        if (/search_model_queries$/.test(pt.p)) f = queriesFrom({ search_model_queries: pt.v });
        else if (/search_queries$/.test(pt.p)) f = queriesFrom({ search_queries: pt.v });
        if (f) { tap.captured++; stashQueries(cid, st.lastParent, st.lastMsg, f); }
      });
    };
    const feed = (text, st) => {
      st.buf += text;
      let i;
      while ((i = st.buf.indexOf('\n\n')) >= 0) {
        const block = st.buf.slice(0, i); st.buf = st.buf.slice(i + 2);
        const dm = block.match(/^data:\s?(.*)$/m); if (!dm) continue;
        let v; try { v = JSON.parse(dm[1]); } catch (e) { continue; }
        if (v && typeof v === 'object') { try { onEvent(v, st); } catch (e) {} }
      }
    };
    window.fetch = async function (input, init) {
      const res = await nativeFetch.apply(this, arguments);
      try {
        const url = typeof input === 'string' ? input : (input && input.url) || '';
        const method = String((init && init.method) || (input && input.method) || 'GET').toUpperCase();
        const ct = (res.headers && res.headers.get('content-type')) || '';
        if (method === 'POST' && /\/backend-api\/(f\/)?conversation(\?|$)/.test(url) && /event-stream/.test(ct) && res.body) {
          const pair = res.body.tee();
          const st = { buf: '', cid: '', lastMsg: '', lastParent: '' };
          tap.streams++;
          (async () => {
            const rd = pair[1].getReader(); const dec = new TextDecoder();
            try { for (;;) { const r = await rd.read(); if (r.done) break; feed(dec.decode(r.value, { stream: true }), st); } } catch (e) {}
          })();
          return new Response(pair[0], { status: res.status, statusText: res.statusText, headers: res.headers });
        }
      } catch (e) {}
      return res;
    };
  }

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
    meta.title = typeof j.title === 'string' ? j.title : '';
    meta.fetched = 0; meta.cited = 0; meta.redditFetched = 0; meta.redditCited = 0; meta.unknownTurns = 0; meta.hiddenQueries = 0; meta.liveRounds = 0; meta.savedRounds = 0; meta.promptList = [];
    let prompt = '', batch = 0, turn = 0, cur = null, pendingNote = '';
    const path = activePath(j);
    // Queries for a search call live either in the chat (Work workspaces) or in this browser's live capture.
    // Both are keyed by the call message they answer, with a fallback on the id of the message that carried them.
    const liveQ = readQ()[j.conversation_id || meta.id] || {};
    const savedQ = {};
    path.forEach(n => {
      const m = n.message; if (!m) return;
      const f = queriesFrom(m.metadata); if (!f) return;
      const parent = (m.metadata && m.metadata.parent_id) || n.parent || '';
      if (parent) savedQ[parent] = f;
      savedQ['@' + m.id] = f;
    });
    const findQ = (map, callId, idx) => {
      if (map[callId]) return map[callId];
      for (let k = idx + 1; k < path.length; k++) {
        const nm = path[k].message; if (!nm || !nm.author) continue;
        if (nm.author.role === 'user' || nm.recipient === 'web.run' || nm.recipient === 'web') break;
        if (map['@' + nm.id]) return map['@' + nm.id];
      }
      return null;
    };
    const bigToPos = {};   // long round id (from tool results and cite markers) -> position of the round inside its turn
    const addEntry = (b, e, pos) => {
      if (!e || !e.url) return;
      const url = normUrl(e.url);
      if (b.seen.has(url)) return; b.seen.add(url);
      const rid = e.ref_id || {};
      b.entries.push({ url, raw: String(e.url), host: hostOf(e.url), key: b.turn + '|' + pos + '|' + rid.ref_type + '|' + rid.ref_index, cited: false,
        title: typeof e.title === 'string' ? e.title.slice(0, 160) : '', date: typeof e.pub_date === 'number' && e.pub_date > 0 ? e.pub_date : 0,
        snippet: typeof e.snippet === 'string' ? e.snippet.replace(/\s+/g, ' ').trim().slice(0, 240) : '' });
    };
    path.forEach((n, idx) => {
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
      // ChatGPT's own working notes: the thinking summaries it writes between searches, and the one-line preamble
      // before the first one. They are kept with the batch that follows them, as its brief.
      if (role === 'assistant' && m.content && m.content.content_type === 'thoughts') {
        const t = (m.content.thoughts || []).map(x => [x.summary, x.content].filter(Boolean).join(': ')).filter(Boolean).join(' | ');
        if (t) pendingNote = (pendingNote ? pendingNote + ' | ' : '') + t;
        return;
      }
      if (role === 'assistant' && md.is_thinking_preamble_message && m.content && Array.isArray(m.content.parts)) {
        const t = m.content.parts.filter(x => typeof x === 'string').join(' ').replace(/\s+/g, ' ').trim();
        if (t) pendingNote = (pendingNote ? pendingNote + ' | ' : '') + t;
        return;
      }
      if ((m.recipient === 'web.run' || m.recipient === 'web') && m.content) {
        const text = typeof m.content.text === 'string' ? m.content.text : (m.content.parts || []).filter(x => typeof x === 'string').join('\n');
        batch++; cur = { turn, pos: T.batches.length, entries: [], seen: new Set(), note: pendingNote.slice(0, 700) }; pendingNote = ''; batches[batch] = cur; T.batches.push(batch);
        const before = rows.length;
        if (text) text.split(/\r?\n/).forEach(l => parseLine(l, batch, prompt, turn));
        if (rows.length === before) {
          const saved = findQ(savedQ, m.id, idx), captured = saved ? null : findQ(liveQ, m.id, idx);
          const f = saved || captured;
          if (f) {
            if (saved) meta.savedRounds++; else meta.liveRounds++;
            f.q.forEach((q, i) => rows.push({ n: rows.length + 1, batch, turn, type: (f.t && f.t[i]) || 'web', query: q, days: '', domain: '',
              reddit: /reddit/i.test(q) ? 'yes' : 'no', location: '', prompt, results: '', cited: '', locked: '', batchResults: '', batchCited: '', batchDomains: '', sources: [], qsrc: saved ? 'saved' : 'live' }));
          } else {
            meta.hiddenQueries++;
            rows.push({ n: rows.length + 1, batch, turn, type: 'web', query: cur.pos === 0 ? HIDDEN_FIRST : HIDDEN_LATER, hidden: true, days: '', domain: '', reddit: 'no',
              location: '', prompt, results: '', cited: '', locked: '', batchResults: '', batchCited: '', batchDomains: '', sources: [], qsrc: '' });
          }
        }
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
      r.known = known; r.age = r.age == null ? '' : r.age; r.citedAge = ''; r.note = b.note || '';
      r.batchResults = ents.length; r.batchCited = known ? ents.filter(e => e.cited).length : ''; r.batchDomains = topDomains(ents);
      if (NO_RESULTS.includes(r.type)) return;
      const locked = lockedHostOf(r); r.locked = locked;
      const mine = locked ? ents.filter(e => hostMatches(e.host, locked)) : (OPEN_WEB.includes(r.type) ? ents : null);
      if (!mine) return;
      r.sources = mine.slice().sort((a, b) => (b.cited - a.cited) || a.host.localeCompare(b.host) || a.url.localeCompare(b.url));
      r.results = mine.length;
      r.cited = known ? mine.filter(e => e.cited).length : '';
      const ag = mine.filter(e => e.date).map(e => ageOf(e.date));
      r.age = ag.length ? median(ag) : '';
      const cg = known ? mine.filter(e => e.cited && e.date).map(e => ageOf(e.date)) : [];
      r.citedAge = cg.length ? median(cg) : '';
      r.note = b.note || '';
    });
    meta.unknownTurns = turns.filter(t => t && !t.hasAnswer).length;
  };

  // ---------- Sorting (click a column header; exports follow the current order, n keeps the original order) ----------
  const COLS = ['n', 'batch', 'type', 'query', 'days', 'age', 'citedAge', 'domain', 'results', 'cited'];
  const LABELS = { age: 'fetched age', citedAge: 'cited age' };
  const NUMERIC = ['n', 'batch', 'days', 'age', 'citedAge', 'results', 'cited'];
  const OPTIONAL = ['days', 'domain'];   // shown only when a line has something in them: gone from new chats since September 2026
  const visibleCols = () => COLS.filter(k => !OPTIONAL.includes(k) || rows.some(r => r[k] !== '' && r[k] != null));
  let sortKey = 'n', sortDir = 1;
  const shown = r => r.type === 'business' ? r.location + ' : ' + r.query : r.query;
  const cell = (r, k) => k === 'query' ? shown(r) : (k === 'age' || k === 'citedAge') ? (r[k] === '' || r[k] == null ? '' : ageLabel(r[k])) : r[k];
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
  // Where a row's query came from: the chat itself (pre-September text format or a Work workspace), the live capture, or nowhere.
  const qsrcOf = r => r.qsrc === 'live' ? 'captured live' : r.qsrc === 'saved' ? 'saved chat' : r.hidden ? 'not exposed' : 'saved chat';
  const toCSV = () => {
    const head = ['n', 'batch', 'type', 'query', 'query_source', 'freshness_days', 'domain', 'results', 'cited', 'dated_pages', 'median_fetched_age_days', 'median_cited_age_days', 'pages_under_30_days', 'batch_note', 'reddit', 'location', 'locked_host', 'round_results', 'round_cited', 'round_top_domains', 'sources', 'cited_sources', 'prompt', 'conversation_id', 'captured_at'];
    const agesOf = r => r.sources.filter(e => e.date).map(e => ageOf(e.date));
    return [head.join(',')].concat(view().map(r => { const ag = agesOf(r); return [r.n, r.batch, r.type, r.query, qsrcOf(r), r.days, r.domain, r.results, r.cited, ag.length, ag.length ? median(ag) : '', r.citedAge, ag.filter(a => a <= 30).length, r.note || '', r.reddit, r.location, r.locked, r.batchResults, r.batchCited, r.batchDomains, srcList(r, false), srcList(r, true), r.prompt, meta.id, meta.at].map(csvCell).join(','); })).join('\n');
  };
  // One row per search line, followed by one row per page it got back (row_kind = search / source). Filter on row_kind in a spreadsheet.
  const toSourcesCSV = () => {
    const head = ['row_kind', 'n', 'batch', 'type', 'query', 'freshness_days', 'domain', 'results', 'cited', 'source_url', 'source_domain', 'source_cited', 'source_title', 'source_published', 'source_age_days', 'source_snippet', 'batch_note', 'prompt', 'conversation_id', 'captured_at'];
    const out = [head.join(',')];
    view().forEach(r => {
      out.push(['search', r.n, r.batch, r.type, r.query, r.days, r.domain, r.results, r.cited, '', '', '', '', '', '', '', r.note || '', r.prompt, meta.id, meta.at].map(csvCell).join(','));
      r.sources.forEach(e => out.push(['source', r.n, r.batch, r.type, r.query, r.days, r.domain, r.results, r.cited, e.raw, e.host, r.known ? (e.cited ? 'yes' : 'no') : '', e.title || '', e.date ? dateStr(e.date) : '', e.date ? ageOf(e.date) : '', e.snippet || '', '', r.prompt, meta.id, meta.at].map(csvCell).join(',')));
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
  const slug = t => String(t || '').toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60);
  const stamp = () => 'chatgpt-fanout-' + (slug(meta.title) || meta.id.slice(0, 8)) + '-' + meta.at.slice(0, 16).replace(/[:T]/g, '-');

  // ---------- Index tab: what every column means, in plain English ----------
  const INDEX = [
    ['prompt (above the table)', 'The message you sent that started the searches. With several prompts in one chat, all of them are listed in order.', ''],
    ['n', 'The line number, in the order ChatGPT ran the searches. 1 is the first search of the chat.', 'n = 43 means it was the 43rd search in this chat.'],
    ['batch', 'ChatGPT searches in rounds. It sends a few searches together, reads what came back, then may send another round. batch is the round number.', 'All lines with batch = 2 were sent together, after ChatGPT had read the results of batch 1.'],
    ['type', 'What kind of search it was. See the Types tab for the full list.', 'fast = a normal web search. business = a places search. image = a picture search. slow = a deeper web search.'],
    ['query', 'The exact words ChatGPT sent to search, including any site: and quotes. This is the fan-out term.' + ' From September 2026 ChatGPT no longer saves it with the chat. It still streams the first batch of queries to the browser while it answers, so click the bookmark before you send a prompt and they are captured and kept for that chat. Work workspaces keep the queries in the saved chat. A round with no query from either source reads "query not exposed by ChatGPT" and still shows its pages and citations.', 'query = "Shrimp Shack Camden" reviews portion sauce birthday'],
    ['days', 'How recent the pages had to be, in days, when ChatGPT still sent it. 30 = last month. 365 = last year. 3650 = last ten years. ChatGPT stopped sending this in September 2026, so the column only appears on chats from before then and stays hidden when every line is empty. For newer chats, fetched age and cited age show how old the pages actually were.', 'days = 30 on a chat from August 2026'],
    ['domain', 'Only on chats from before September 2026, when ChatGPT still sent it, and hidden when every line is empty. When filled, ChatGPT only searched that one website. Empty = the whole web. A site: inside the query does the same job.' + ' Gone from new chats since September 2026, along with the query text, so this column is empty on them.', 'domain = reddit.com means only Reddit was searched. site:linkedin.com/jobs in the query means only LinkedIn jobs pages.'],
    ['results', 'How many pages came back. For a line with a domain or a site:, it is the count from that website in that round. For an open search, it is the count for the whole round. ChatGPT records results per round, not per query, so lines in the same round that search the same place show the same number. Empty for business and image lines, whose results are not exposed.', 'results = 12 with domain = sexyfish.com means 12 pages from sexyfish.com came back. results = 0 with domain = reddit.com means the Reddit search returned nothing, so Reddit could not be cited from it.'],
    ['cited', 'How many of those pages were shown as a source in the answer, either as a citation chip in the text or in the Sources list at the end. Empty while the answer is still being written, or when the answer for that prompt is not stored in the chat.', 'results = 11, cited = 3 means 11 pages came back and 3 were shown as sources. results = 84, cited = 0 means ChatGPT read 84 pages and credited none of them.'],
    ['+ (first column)', 'Opens the line. First every page that was shown as a source in the answer, then the pages that were not, grouped by website: a website with several pages gets its own group with its full record in brackets, and the websites that returned a single page sit in one list. The age next to a page is its publication date read against today. Hover a page for its title and date. ChatGPT returns one pool of pages for the whole batch, so every query in a batch opens the same list.', ''],
    ['Show what ChatGPT read', 'A switch inside an opened line. On, each page shows the snippet ChatGPT was given for it, which is what it judged the page on before deciding whether to cite it, and the batch shows ChatGPT\'s own working note, the short thinking summary it wrote before running that batch, when the chat has one. Off by default so the list stays readable. Both are in the sources CSV as source_snippet and batch_note.', ''],
    ['Brands it searched (under the prompt)', 'The brands ChatGPT chose to check, read from the query text: a name in a query that matches one of the websites that came back, so words like SEO or AI never qualify and a brand it named but got no page from is not listed. The first batch of queries is written before a single result arrives, so these names come from what the model already holds: its training data, and your memory and custom instructions if they are on. A brand the model does not know cannot be in that first batch and can only enter through a generic query and whatever page answers it. Blocking the training crawlers on your own site makes that a little more likely, but most of what a model knows about a brand comes from other people\'s pages, so a well-discussed brand that blocks them is still named. Turn memory off when you measure, or your own history shapes the list.', 'Brands it searched: Semrush, Ahrefs, Sistrix, Sitebulb, Screaming Frog, seoClarity'],
    ['headline (above the table)', 'Fetched = pages that came back across the whole chat, each counted once. Shown as sources = how many of those appeared in an answer. Reddit = the same two numbers for reddit.com only.', 'Fetched 204 pages, 19 shown as sources. Reddit: 57 fetched, 5 cited.'],
    ['fetched age', 'How old the pages that came back are. ChatGPT records a publication date for many of the pages it fetches, roughly half in practice. Take those dated pages, work out each one\'s age from its date to today and sort them: the column shows the middle one, the median. 2mo means half the dated pages are two months old or newer. It is the median rather than the average so one ten-year-old page cannot drag the number. Hover the cell for the newest, the oldest and how many are from the last 30 days. Inside the line each dated page shows its own age. The days column was what ChatGPT asked for, fetched age is what it got. Empty when none of the pages carry a date.', 'fetched age = 2mo. Hover: 26 of 58 pages carry a date, newest 6d, oldest 8.7y, 5 from the last 30 days'],
    ['cited age', 'The same median, taken over the pages from this batch that were cited in the answer. Read it against fetched age: when the cited pages are newer than the pool they came from, freshness helped them get picked, and keeping your page current matters for this prompt. When the two are alike, it did not. Empty while the answer is being written, when nothing from the batch was cited, or when the cited pages carry no date.', 'fetched age = 2mo, cited age = 12d means ChatGPT fetched pages two months old on average and cited pages from the last fortnight'],
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
  box.style.cssText = 'position:fixed;top:12px;right:12px;z-index:2147483647;box-sizing:border-box;width:min(1040px,96vw);max-width:calc(100vw - 24px);max-height:88vh;overflow:auto;resize:both;min-width:320px;min-height:160px;overscroll-behavior:contain;background:rgb(17,17,17);color:rgb(235,235,235);font:13px/1.4 -apple-system,Segoe UI,Helvetica,Arial,sans-serif;border:1px solid rgb(70,70,70);border-radius:10px;padding:14px;box-shadow:0 8px 30px rgba(0,0,0,.5);text-align:left';
  const bar = document.createElement('div'); bar.style.cssText = 'display:flex;gap:8px;align-items:center;flex-wrap:wrap;position:sticky;top:-14px;z-index:5;background:rgb(17,17,17);margin:-14px -14px 10px;padding:14px 14px 10px';
  const title = document.createElement('strong'); title.textContent = 'ChatGPT Fanout Explorer'; title.style.cssText = 'font-size:14px';
  const ver = document.createElement('span'); ver.textContent = 'v' + BUILD; ver.title = 'Build date of the code you are running. The install page always has the newest one.'; ver.style.cssText = 'font-size:11px;color:rgb(150,150,150);margin-right:auto';
  const mkBtn = (label) => { const b = document.createElement('button'); b.type = 'button'; b.textContent = label; b.style.cssText = 'background:rgb(43,43,43);color:rgb(255,255,255);border:1px solid rgb(90,90,90);border-radius:6px;padding:6px 10px;cursor:pointer;font:inherit'; return b; };
  const flash = (b, txt) => { const o = b.textContent; b.textContent = txt; setTimeout(() => { b.textContent = o; }, 1500); };
  const bQ = mkBtn('Copy queries only'), bT = mkBtn('Copy table (TSV)'), bC = mkBtn('Download CSV'), bS = mkBtn('Download sources CSV'), bL = mkBtn('Live: on'), bR = mkBtn('Refresh'), bX = mkBtn('Close');
  const tabs = document.createElement('div'); tabs.style.cssText = 'display:flex;gap:6px;align-items:center;margin:0 0 10px;border-bottom:1px solid rgb(70,70,70)';
  const mkTab = (label) => { const b = document.createElement('button'); b.type = 'button'; b.textContent = label; b.style.cssText = 'background:none;color:rgb(170,170,170);border:none;border-bottom:2px solid transparent;padding:6px 10px;cursor:pointer;font:inherit;font-weight:600'; return b; };
  const tabTable = mkTab('Table'), tabIndex = mkTab('Index'), tabTypes = mkTab('Types');
  const bE = mkBtn('Expand all'); bE.style.cssText += ';margin-left:auto;padding:3px 8px;font-size:12px';
  const status = document.createElement('div'); status.style.cssText = 'margin:6px 0 4px;color:rgb(190,190,190)';
  const headline = document.createElement('div'); headline.style.cssText = 'margin:0 0 6px;color:rgb(235,235,235)';
  const promptLine = document.createElement('div'); promptLine.style.cssText = 'margin:0 0 4px;color:rgb(235,235,235);word-break:break-word';
  const brandsLine = document.createElement('div'); brandsLine.style.cssText = 'margin:0 0 10px;color:rgb(235,235,235);word-break:break-word';
  const body = document.createElement('div');
  const index = document.createElement('div'); index.hidden = true;
  const types = document.createElement('div'); types.hidden = true;
  bar.append(title, ver, bQ, bT, bC, bS, bL, bR, bX); tabs.append(tabTable, tabIndex, tabTypes, bE);
  box.append(bar, tabs, status, headline, promptLine, brandsLine, body, index, types); document.body.appendChild(box);
  // A transform, filter or containment on an ancestor makes position:fixed resolve against that ancestor
  // instead of the viewport, which can push the panel and its Close button off screen. Measure after mount
  // and correct. vh units also misreport on some setups, so the height cap is set in pixels.
  // The panel opens at the top right, which is out of reach on a magnified screen or a narrow window,
  // so it can be dragged by its toolbar and resized from the bottom right corner. The last position and
  // size are remembered in this browser. Double-click the title to put it back where it started.
  const POS_KEY = 'fo-export:pos:v1';
  const readPos = () => { try { return JSON.parse(localStorage.getItem(POS_KEY) || 'null'); } catch (e) { return null; } };
  // A drag saves where the panel is, not how tall it happened to be. Only a real resize saves the size,
  // so the panel keeps growing with its content until the reader decides otherwise.
  const savePos = (withSize) => {
    const r = box.getBoundingClientRect(), prev = readPos() || {}, o = { left: Math.round(r.left), top: Math.round(r.top) };
    if (withSize) { o.width = Math.round(r.width); o.height = Math.round(r.height); }
    else if (prev.width) { o.width = prev.width; o.height = prev.height; }
    try { localStorage.setItem(POS_KEY, JSON.stringify(o)); } catch (e) {}
  };
  const clearPos = () => { try { localStorage.removeItem(POS_KEY); } catch (e) {} };

  const layout = () => {
    const p = readPos();
    const w = p && p.width ? Math.min(Math.max(320, p.width), Math.max(320, innerWidth - 16)) : Math.min(1040, innerWidth - 24);
    box.style.right = 'auto';
    box.style.width = w + 'px';
    if (p && p.height) { box.style.height = Math.min(Math.max(160, p.height), Math.max(160, innerHeight - 16)) + 'px'; box.style.maxHeight = 'none'; }
    else { box.style.height = ''; box.style.maxHeight = Math.max(220, innerHeight - 24) + 'px'; }
    const left = p ? p.left : innerWidth - w - 12;
    const top = p ? p.top : 12;
    box.style.left = Math.min(Math.max(0, left), Math.max(0, innerWidth - 120)) + 'px';
    box.style.top = Math.min(Math.max(0, top), Math.max(0, innerHeight - 40)) + 'px';
  };

  const fitPanel = () => {
    layout();
    // A transform, filter or containment on an ancestor makes position:fixed resolve against that
    // ancestor instead of the viewport, which can push the panel off screen. Measure and correct.
    let r = box.getBoundingClientRect();
    const off = () => { r = box.getBoundingClientRect(); return r.top < -1 || r.left < -1 || r.right > innerWidth + 1; };
    if (off() && box.parentNode !== document.documentElement) document.documentElement.appendChild(box);
    if (off()) {
      box.style.transform = 'none';
      box.style.top = (parseFloat(box.style.top) - r.top + 12) + 'px';
      box.style.left = (parseFloat(box.style.left) - r.left + Math.max(12, innerWidth - box.offsetWidth - 12)) + 'px';
    }
  };
  fitPanel();
  addEventListener('resize', fitPanel);

  // Drag by the toolbar, anywhere that is not a button.
  bar.style.cursor = 'move';
  bar.title = 'Drag to move the panel. Double-click to put it back at the top right.';
  bar.addEventListener('pointerdown', e => {
    if (e.target.closest('button')) return;
    const r0 = box.getBoundingClientRect(), sx = e.clientX, sy = e.clientY;
    const move = ev => {
      box.style.right = 'auto';
      box.style.left = Math.min(Math.max(0, r0.left + ev.clientX - sx), Math.max(0, innerWidth - 120)) + 'px';
      box.style.top = Math.min(Math.max(0, r0.top + ev.clientY - sy), Math.max(0, innerHeight - 40)) + 'px';
    };
    const up = () => { removeEventListener('pointermove', move); removeEventListener('pointerup', up); savePos(); };
    addEventListener('pointermove', move); addEventListener('pointerup', up);
    e.preventDefault();
  });
  bar.addEventListener('dblclick', e => { if (e.target.closest('button')) return; clearPos(); box.style.height = ''; fitPanel(); });
  // Remember a size the reader dragged out of the bottom right corner.
  let lastSize = '';
  box.addEventListener('pointerup', () => setTimeout(() => {
    const s = box.offsetWidth + 'x' + box.offsetHeight;
    if (lastSize && s !== lastSize) savePos(true);
    lastSize = s;
  }, 0));
  lastSize = box.offsetWidth + 'x' + box.offsetHeight;
  const showTab = (which) => {
    const on = 'rgb(255,255,255)', off = 'rgb(170,170,170)';
    [[tabTable, 'table'], [tabIndex, 'index'], [tabTypes, 'types']].forEach(([b, k]) => { b.style.color = which === k ? on : off; b.style.borderBottomColor = which === k ? on : 'transparent'; });
    const t = which === 'table';
    body.hidden = !t; status.hidden = !t; headline.hidden = !t; promptLine.hidden = !t; brandsLine.hidden = !t; bE.hidden = !t;
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
  // Page age: ChatGPT records a publication date for many of the pages it fetches. It is the closest thing left to
  // the freshness window it used to send: not what it asked for, but how old what came back actually was.
  const ageOf = ts => ts ? Math.max(0, Math.round((Date.now() / 1000 - ts) / 86400)) : null;
  const ageLabel = d => d == null ? '' : d < 1 ? 'today' : d < 30 ? d + 'd' : d < 365 ? Math.round(d / 30) + 'mo' : (Math.round(d / 36.5) / 10) + 'y';
  const median = a => a.length ? a.slice().sort((x, y) => x - y)[Math.floor(a.length / 2)] : null;
  const dateStr = ts => { try { return new Date(ts * 1000).toISOString().slice(0, 10); } catch (e) { return ''; } };
  let showRead = false;   // one switch for every opened line: the snippet ChatGPT read for each page, and its own note for the batch
  const detailFor = (r) => {
    const wrap = document.createElement('div'); wrap.style.cssText = 'font-size:12px;line-height:1.35;color:rgb(200,200,200);padding:2px 0 8px 26px';
    if (NO_RESULTS.includes(r.type)) { wrap.textContent = 'Results for ' + r.type + ' lines are not exposed in the payload.'; return wrap; }
    if (!r.sources.length) { wrap.textContent = 'Nothing came back for this search.'; return wrap; }
    const n = r.sources.length, cited = r.sources.filter(e => e.cited).length;
    const inBatch = rows.filter(x => x.batch === r.batch).length;
    const ages = r.sources.filter(e => e.date).map(e => ageOf(e.date));
    const citedAges = r.sources.filter(e => e.cited && e.date).map(e => ageOf(e.date));
    const sum = document.createElement('div'); sum.style.cssText = 'margin-bottom:6px;color:rgb(235,235,235)';
    sum.textContent = n + ' page' + (n === 1 ? '' : 's') + ' came back for ' + (inBatch > 1 ? 'the ' + inBatch + ' queries in this batch' : 'this batch') + (r.known ? ', ' + cited + ' cited' : '') + '.'
      + (ages.length ? ' ' + ages.length + ' carry a publication date: the middle one is ' + ageLabel(median(ages)) + ' old, ' + ages.filter(a => a <= 30).length + ' from the last 30 days' + (r.known && citedAges.length ? ', the middle cited one ' + ageLabel(median(citedAges)) : '') + '.' : '');
    // Cited pages first, as one list. Then the pages that were not cited, grouped by how their website did: every
    // website with the same counts shares one group, so the many websites that returned one page sit in one list.
    const pageLine = (e, indent) => {
      const d = document.createElement('div'); d.style.cssText = 'white-space:nowrap;overflow:hidden;text-overflow:ellipsis;padding-left:' + indent + 'px';
      const mark = document.createElement('span'); mark.textContent = e.cited ? '✓ ' : '· '; mark.style.cssText = e.cited ? 'color:rgb(120,220,140);font-weight:700' : 'color:rgb(120,120,120)';
      const age = document.createElement('span'); age.textContent = e.date ? ageLabel(ageOf(e.date)) : ''; age.title = e.date ? 'Published ' + dateStr(e.date) : 'No date recorded for this page';
      age.style.cssText = 'display:inline-block;width:38px;color:rgb(185,185,185);font-size:11px';
      const a = document.createElement('a'); a.href = e.raw; a.target = '_blank'; a.rel = 'noopener'; a.textContent = shortUrl(e.raw);
      a.title = (e.title ? e.title + '\n' : '') + (e.date ? 'Published ' + dateStr(e.date) + '\n' : '') + e.raw;
      a.style.cssText = 'color:' + (e.cited ? 'rgb(235,235,235)' : 'rgb(170,170,170)') + ';text-decoration:none';
      d.append(mark, age, a);
      if (showRead) {
        const holder = document.createElement('div'); holder.style.cssText = 'padding-left:' + indent + 'px';
        holder.appendChild(d); d.style.paddingLeft = '0';
        const sn = document.createElement('div'); sn.style.cssText = 'color:rgb(150,150,150);font-size:11px;line-height:1.3;padding:0 0 4px 52px;white-space:normal;word-break:break-word';
        sn.textContent = e.snippet ? e.snippet : 'No snippet recorded for this page.';
        holder.appendChild(sn);
        return holder;
      }
      return d;
    };
    const section = (text) => { const h = document.createElement('div'); h.textContent = text; h.style.cssText = 'color:rgb(235,235,235);font-weight:700;margin:6px 0 3px'; return h; };
    const byUrl = (a, b) => a.host.localeCompare(b.host) || a.url.localeCompare(b.url);
    const list = document.createElement('div');
    const citedPages = r.known ? r.sources.filter(e => e.cited).sort(byUrl) : [];
    const rest = r.known ? r.sources.filter(e => !e.cited) : r.sources.slice();
    if (r.known) {
      list.appendChild(section('Cited (' + citedPages.length + ')'));
      if (citedPages.length) { const cl = document.createElement('div'); if (citedPages.length > 6) cl.style.cssText = 'column-count:2;column-gap:28px'; citedPages.forEach(e => cl.appendChild(pageLine(e, 4))); list.appendChild(cl); }
      else { const none = document.createElement('div'); none.textContent = 'None of the pages from this batch were shown as a source.'; none.style.cssText = 'color:rgb(170,170,170);padding-left:4px'; list.appendChild(none); }
      list.appendChild(section(r.known ? 'Not cited (' + rest.length + '), by website' : 'By website'));
    }
    const byHost = {};
    r.sources.forEach(e => { const h = byHost[e.host] || (byHost[e.host] = { host: e.host, n: 0, c: 0, list: [] }); h.n++; if (e.cited) h.c++; });
    rest.forEach(e => byHost[e.host].list.push(e));
    const tiers = {};
    Object.values(byHost).forEach(h => { if (!h.list.length) return; const k = h.list.length + '|' + h.n + '|' + (r.known ? h.c : 0); (tiers[k] || (tiers[k] = { shown: h.list.length, n: h.n, c: r.known ? h.c : 0, hosts: [] })).hosts.push(h); });
    const order = Object.values(tiers).sort((a, b) => (b.c - a.c) || (b.n - a.n));
    const groups = document.createElement('div'); if (rest.length > 6) groups.style.cssText = 'column-count:2;column-gap:28px';
    order.forEach(t => {
      const block = document.createElement('div'); block.style.cssText = 'break-inside:avoid;margin:0 0 8px';
      const head = document.createElement('div'); head.style.cssText = 'color:rgb(235,235,235);font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis';
      const hosts = t.hosts.sort((a, b) => a.host.localeCompare(b.host));
      const pages = t.shown + ' page' + (t.shown === 1 ? '' : 's');
      const record = r.known && t.c ? ' (' + t.n + ' fetched, ' + t.c + ' cited)' : '';
      head.textContent = hosts.length === 1 ? pages + ': ' + hosts[0].host + record : pages + (t.shown === 1 ? '' : ' each') + ': ' + hosts.length + ' websites' + record;
      block.appendChild(head);
      if (hosts.length === 1 || t.shown === 1) {
        hosts.forEach(h => h.list.slice().sort(byUrl).forEach(e => block.appendChild(pageLine(e, 4))));
      } else {
        hosts.forEach(h => {
          const hl = document.createElement('div'); hl.textContent = h.host; hl.style.cssText = 'color:rgb(200,200,200);padding:2px 0 0 4px';
          block.appendChild(hl);
          h.list.slice().sort(byUrl).forEach(e => block.appendChild(pageLine(e, 12)));
        });
      }
      groups.appendChild(block);
    });
    list.appendChild(groups);
    // The switch, and what it reveals
    const sw = document.createElement('button'); sw.type = 'button'; sw.textContent = showRead ? 'Hide what ChatGPT read' : 'Show what ChatGPT read';
    sw.title = 'The snippet ChatGPT was given for each page, which is what it judged the page on, and its own working note for this batch when the chat has one';
    sw.style.cssText = 'background:none;color:rgb(170,170,170);border:1px solid rgb(90,90,90);border-radius:5px;padding:2px 8px;margin-left:10px;cursor:pointer;font:inherit;font-size:11px';
    sw.onclick = () => { showRead = !showRead; render(); };
    sum.appendChild(sw);
    wrap.appendChild(sum);
    if (showRead) {
      const nt = document.createElement('div'); nt.style.cssText = 'margin:0 0 8px;padding:6px 8px;border-left:2px solid rgb(90,90,90);color:rgb(200,200,200);white-space:normal;word-break:break-word';
      nt.textContent = r.note ? 'ChatGPT\u2019s note before this batch: ' + r.note : 'ChatGPT left no note before this batch.';
      wrap.appendChild(nt);
    }
    wrap.appendChild(list);
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
  // The brands ChatGPT chose to check, read from the query text. A brand is a run of capitalised words in a query
  // whose letters match one of the websites that came back (Screaming Frog and screamingfrog.co.uk, Profound and
  // tryprofound.com), so generic words like SEO or AI never qualify. Order is the order ChatGPT first named them.
  const brandsSearched = () => {
    const qs = rows.filter(r => !r.hidden && r.query).map(r => r.query);
    if (!qs.length) return '';
    const labels = new Set();
    const hostsSeen = batches.some(Boolean) ? [].concat.apply([], batches.filter(Boolean).map(b => b.entries)) : [].concat.apply([], rows.map(r => r.sources));
    hostsSeen.forEach(e => { const parts = e.host.split('.'); const lab = parts.length > 2 && /^(co|com|org|net|ac|gov)$/.test(parts[parts.length - 2]) ? parts[parts.length - 3] : parts[parts.length - 2] || parts[0]; if (lab) labels.add(lab.toLowerCase()); });
    if (!labels.size) return '';
    const found = [];
    const seen = new Set();
    const matches = key => { if (key.length < 3) return false; for (const l of labels) { if (l === key) return true; if (key.length >= 4 && (l.startsWith(key) || l.endsWith(key)) && l.length - key.length <= 4) return true; } return false; };
    qs.forEach(q => {
      const words = q.replace(/["“”]/g, ' ').split(/\s+/).filter(Boolean);
      for (let i = 0; i < words.length; i++) {
        if (!/^[A-Z][A-Za-z0-9.&+-]*$|^[a-z]+[A-Z][A-Za-z0-9]*$/.test(words[i])) continue;   // Capitalised, or camelCase like seoClarity
        let best = '';
        for (let n = Math.min(3, words.length - i); n >= 1; n--) {
          const phrase = words.slice(i, i + n);
          if (!phrase.every(w => /^[A-Z][A-Za-z0-9.&+-]*$|^[a-z]+[A-Z][A-Za-z0-9]*$/.test(w))) continue;
          const key = phrase.join('').toLowerCase().replace(/[^a-z0-9]/g, '');
          if (matches(key)) { best = phrase.join(' '); i += n - 1; break; }
        }
        if (best && !seen.has(best.toLowerCase())) { seen.add(best.toLowerCase()); found.push(best); }
      }
    });
    return found.length ? 'Brands it searched: ' + found.join(', ') : '';
  };
  const render = () => {
    body.innerHTML = '';
    const red = rows.filter(r => r.reddit === 'yes').length;
    const nb = rows.length ? rows[rows.length - 1].batch : 0;
    const got = (meta.liveRounds ? ' Queries for ' + meta.liveRounds + ' round(s) were captured live while ChatGPT answered and are kept for this chat in this browser.' : '')
      + (meta.savedRounds ? ' Queries for ' + meta.savedRounds + ' round(s) come from the saved chat.' : '');
    const hidden = meta.hiddenQueries ? ' ChatGPT no longer saves the query text with the chat and only streams it while answering, so ' + meta.hiddenQueries + ' round(s) show pages and citations without the query, freshness window or site limit.' + (meta.liveRounds ? '' : ' Click the bookmark before you send a prompt and the queries are captured.') : '';
    const hidden2 = got + hidden;
    status.textContent = rows.length + ' search line(s) in ' + nb + ' round(s) across ' + meta.prompts + ' prompt(s). ' + red + ' mention Reddit.' + hidden2 + stateNote();
    headline.textContent = rows.length ? 'Fetched ' + meta.fetched + ' page(s), ' + meta.cited + ' shown as sources in the answers. Reddit: ' + meta.redditFetched + ' fetched, ' + meta.redditCited + ' cited.' + (meta.unknownTurns ? ' (' + meta.unknownTurns + ' prompt(s) have no finished answer yet, so their cited counts are left empty.)' : '') : '';
    promptLine.textContent = promptSummary();
    brandsLine.textContent = brandsSearched();
    bE.textContent = expanded.size ? 'Collapse all' : 'Expand all';
    if (!rows.length) return;
    const t = document.createElement('table'); t.style.cssText = 'border-collapse:collapse;width:100' + String.fromCharCode(37) + ';table-layout:fixed';
    const WIDTHS = { n: 40, batch: 52, type: 62, days: 52, age: 78, citedAge: 68, domain: 140, results: 62, cited: 52 };   // query takes the rest
    const cols = visibleCols();
    const tr = document.createElement('tr');
    const th0 = document.createElement('th'); th0.style.cssText = 'border-bottom:1px solid rgb(70,70,70);width:24px'; tr.appendChild(th0);
    cols.forEach(k => {
      const th = document.createElement('th');
      th.textContent = (LABELS[k] || k) + (sortKey === k ? (sortDir === 1 ? ' ▲' : ' ▼') : '');
      th.title = k === 'age' ? 'Median age of the dated pages that came back for this batch. Hover a cell for the spread. Click to sort.' : k === 'citedAge' ? 'Median age of the dated pages from this batch that were cited in the answer. Click to sort.' : 'Click to sort by ' + (LABELS[k] || k);
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
      cols.forEach(k => {
        const td = document.createElement('td'); td.textContent = cell(r, k);
        td.style.cssText = 'border-bottom:1px solid rgb(42,42,42);padding:4px 6px;vertical-align:top;' + (k === 'query' ? 'word-break:break-word' : 'white-space:nowrap;overflow:hidden;text-overflow:ellipsis') + (k === 'cited' && r.cited !== '' && r.cited > 0 ? ';color:rgb(120,220,140);font-weight:600' : '');
        if (k === 'domain' && r.domain) td.title = r.domain;
        if (k === 'query') { td.title = r.qsrc === 'live' ? 'Captured live while ChatGPT answered, kept for this chat in this browser' : r.qsrc === 'saved' ? 'From the saved chat' : r.hidden ? 'ChatGPT did not send this query to the browser' : ''; if (r.hidden) td.style.cssText += ';color:rgb(140,140,140);font-style:italic'; }
        if (k === 'age' && r.age !== '' && r.age != null) { const ag = r.sources.filter(e => e.date).map(e => ageOf(e.date)); td.title = ag.length + ' of ' + r.sources.length + ' pages that came back carry a date. Median ' + ageLabel(median(ag)) + ', newest ' + ageLabel(Math.min.apply(null, ag)) + ', oldest ' + ageLabel(Math.max.apply(null, ag)) + ', ' + ag.filter(a => a <= 30).length + ' from the last 30 days.'; }
        if (k === 'citedAge') { const ca = r.sources.filter(e => e.cited && e.date).map(e => ageOf(e.date)), nc = r.sources.filter(e => e.cited).length; td.title = !r.known ? 'The answer is not finished yet' : !nc ? 'Nothing from this batch was cited' : ca.length ? ca.length + ' of the ' + nc + ' cited pages carry a date. Median ' + ageLabel(median(ca)) + ', newest ' + ageLabel(Math.min.apply(null, ca)) + ', oldest ' + ageLabel(Math.max.apply(null, ca)) + '.' : 'None of the ' + nc + ' cited pages carry a date'; }
        row.appendChild(td);
      });
      t.appendChild(row);
      if (isOpen) {
        const dr = document.createElement('tr'); if (r.reddit === 'yes') dr.style.background = 'rgb(50,34,10)';
        const td = document.createElement('td'); td.colSpan = cols.length + 1; td.style.cssText = 'border-bottom:1px solid rgb(42,42,42);padding:0 6px';
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
    const data = { at: meta.at, meta: { title: meta.title, prompts: meta.prompts, promptList: meta.promptList, fetched: meta.fetched, cited: meta.cited, redditFetched: meta.redditFetched, redditCited: meta.redditCited, unknownTurns: meta.unknownTurns },
      rows: rows.map(r => ({ n: r.n, batch: r.batch, turn: r.turn, type: r.type, query: r.query, days: r.days, domain: r.domain, reddit: r.reddit, location: r.location, prompt: r.prompt, results: r.results, cited: r.cited, locked: r.locked, batchResults: r.batchResults, batchCited: r.batchCited, batchDomains: r.batchDomains, known: r.known, hidden: !!r.hidden, qsrc: r.qsrc || '', age: r.age, citedAge: r.citedAge, note: r.note || '', sources: r.sources.map(e => [e.raw, e.host, e.cited ? 1 : 0, e.date || 0, e.title || '', e.snippet || '']) })) };
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
      d.rows.forEach(r => { r.sources = (r.sources || []).map(x => ({ raw: x[0], url: normUrl(x[0]), host: x[1], cited: !!x[2], date: x[3] || 0, title: x[4] || '', snippet: x[5] || '' })); if (r.age == null) r.age = ''; if (r.citedAge == null) r.citedAge = ''; if (r.note == null) r.note = ''; rows.push(r); });
      Object.assign(meta, d.meta); meta.id = id; meta.at = d.at;
      return true;
    } catch (e) { return false; }
  };
  const when = iso => { try { const d = new Date(iso); return d.toLocaleDateString() + ' ' + d.toLocaleTimeString().replace(/:\d\d(\s|$)/, '$1'); } catch (e) { return iso; } };

  // ---------- Live mode: watch the chat in the URL and re-read it only while ChatGPT is answering ----------
  // A finished chat is read once (or not at all when a saved copy exists). Polling only happens while the answer is being
  // written, plus a short grace period after it ends, and never from a background tab. Turns with no stored answer are
  // history and do not keep the reader polling: the rate limit is shared with ChatGPT's own page, so a reader that keeps
  // re-reading a long chat every few seconds makes ChatGPT itself answer 429 when you move between chats. 429 answers from ChatGPT trigger a growing pause between tries.
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
        settled = !streaming() && Date.now() > graceUntil;
        render(); saveCopy();
        if (!rows.length) status.textContent = 'No search lines yet. If the answer is finished and this stays empty, it never searched the web, or the format moved again.' + stateNote();
      } else {
        settled = !streaming() && Date.now() > graceUntil;
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
      if (!chatId) status.textContent = (window.__foTap ? 'Query capture is armed. ' : '') + 'Waiting for a chat. Send your prompt here and the searches, with their queries, will appear as ChatGPT runs them.';
      else if (loadCopy(chatId)) { fromCopy = true; settled = !streaming(); render(); }
      else status.textContent = 'Reading conversation ' + chatId + ' ...';
    }
    const now = Date.now(), busy = streaming();
    if (busy) settled = false;
    if (wasStreaming && !busy) graceUntil = now + 15000;   // the answer just finished: read a couple more times to pick up the final pool and citations
    wasStreaming = busy;
    const wanted = chatId && live && !settled && now >= backoffUntil && document.visibilityState !== 'hidden';
    if (wanted) await load(false);
    else if (chatId && live && now < backoffUntil && !inFlight) status.textContent = status.textContent.replace(/Next try in \d+s\./, 'Next try in ' + Math.ceil((backoffUntil - now) / 1000) + 's.');
    timer = setTimeout(tick, busy || now < graceUntil ? 4000 : 3000);
  };
  bL.onclick = () => { live = !live; bL.textContent = live ? 'Live: on' : 'Live: off'; if (live) { settled = false; } render(); };
  bR.onclick = () => { if (!chatId) return; settled = false; backoffUntil = 0; load(true); };
  const closePanel = () => { closed = true; clearTimeout(timer); removeEventListener('resize', fitPanel); document.removeEventListener('keydown', onKey, true); if (window.__foTap) window.__foTap.onCapture = null; box.remove(); };
  // A live capture for this chat wakes the reader so the queries show as soon as the chat has the call they belong to.
  if (window.__foTap) window.__foTap.onCapture = (cid) => { if (closed) return; if (!chatId || cid === chatId) { settled = false; lastSig = ''; } };
  bX.onclick = closePanel;
  // Escape is the guaranteed way out, in case the page's own layout ever hides the Close button.
  const onKey = (e) => {
    if (e.key !== 'Escape' || !box.isConnected) return;
    const t = e.target, tag = t && t.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || (t && t.isContentEditable)) return;
    closePanel();
  };
  document.addEventListener('keydown', onKey, true);
  showTab('table');
  tick();
})();
