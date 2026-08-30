/* 방잇다 웹 — 공고 목록/필터/즐겨찾기.
 *
 * 원칙 둘:
 *  1) notices.json 은 공개 저장소에서 온다. 거기 적힌 문자열을 innerHTML 로
 *     넣지 않는다 — 전부 textContent 고, 링크는 safeLink() 를 거친다.
 *     (crawler/tools/calendar_sync.py 의 safe_link 와 같은 규칙)
 *  2) 오래된 데이터를 조용히 보여주지 않는다. 마감을 놓치지 않으려고 만든
 *     서비스가 3일 지난 목록을 말없이 띄우면 그게 제일 나쁜 실패다.
 */
'use strict';

const DATA_URL = '../notices.json';
const BM_KEY = 'bangitda.bookmarks.v1';
const FILTER_KEY = 'bangitda.filters.v1';
const STALE_HOURS = 12;

const SORTS = ['deadline', 'posted', 'start', 'rent'];

/** 공고 목록 원본. */
let notices = [];
let bookmarks = new Set();

const state = {
  q: '',
  region: new Set(),
  source: new Set(),
  houseType: new Set(),
  onlyBookmarked: false,
  hideNoPrice: false,
  sort: 'deadline',
};

/* ── 저장소 (없거나 막혀 있어도 앱은 돌아가야 한다) ── */

function readStore(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch (_) {
    return fallback;                 // 시크릿 창·사이트 데이터 차단 등
  }
}

function writeStore(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch (_) { /* 저장이 안 돼도 이번 세션은 그대로 쓴다 */ }
}

/* ── 안전한 링크 ── */

function safeLink(url) {
  if (typeof url !== 'string' || !url.trim()) return null;
  let u;
  try {
    // base 를 주지 않는다. base 를 주면 '접수처 문의' 같은 URL 아닌 문자열이
    // 우리 사이트 경로로 해석돼 통과하고, '공고 원문 보기'가 깨진 링크가 된다.
    // 공고 데이터의 링크는 전부 절대 URL 이므로 절대 URL만 받는다.
    u = new URL(url);
  } catch (_) {
    return null;
  }
  // http/https 외에는 전부 거절. javascript:, data: 를 막는 게 핵심이다.
  return (u.protocol === 'http:' || u.protocol === 'https:') ? u.href : null;
}

/* ── 날짜 ── */

/** 'YYYY-MM-DD' → 로컬 자정 Date. 잘못된 값이면 null. */
function parseDate(s) {
  if (typeof s !== 'string') return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s.trim());
  if (!m) return null;
  const d = new Date(+m[1], +m[2] - 1, +m[3]);
  return Number.isNaN(d.getTime()) ? null : d;
}

function today() {
  const n = new Date();
  return new Date(n.getFullYear(), n.getMonth(), n.getDate());
}

function daysBetween(from, to) {
  return Math.round((to - from) / 86400000);
}

/** 접수 상태. {label, cls, order} — order 는 정렬용(작을수록 급하다). */
function periodState(n) {
  const t = today();
  const start = parseDate(n.apply_start);
  const end = parseDate(n.apply_end);

  if (end) {
    const left = daysBetween(t, end);
    if (left < 0) return { label: '마감', cls: '', order: 1e6 };
    if (start && daysBetween(t, start) > 0) {
      const until = daysBetween(t, start);
      return { label: `접수 시작 D-${until}`, cls: '', order: 1000 + until };
    }
    if (left === 0) return { label: '오늘 마감', cls: 'soon', order: 0 };
    return {
      label: `마감 D-${left}`,
      cls: left <= 7 ? 'soon' : 'open',
      order: left,
    };
  }
  if (start) {
    const until = daysBetween(t, start);
    if (until > 0) return { label: `접수 시작 D-${until}`, cls: '', order: 1000 + until };
    return { label: '접수중', cls: 'open', order: 900 };
  }
  return { label: '기간 미정', cls: '', order: 1e5 };
}

function fmtRange(n) {
  const s = n.apply_start, e = n.apply_end;
  if (s && e) return s === e ? s : `${s} ~ ${e}`;
  if (e) return `~ ${e}`;
  if (s) return `${s} ~`;
  return '접수기간 미정';
}

function fmtMoney(v) {
  if (typeof v !== 'number' || !Number.isFinite(v)) return null;
  if (v >= 100000000) {
    const eok = v / 100000000;
    return `${(Math.round(eok * 100) / 100).toLocaleString('ko-KR')}억원`;
  }
  if (v >= 10000) {
    return `${Math.round(v / 10000).toLocaleString('ko-KR')}만원`;
  }
  return `${v.toLocaleString('ko-KR')}원`;
}

/* ── DOM 헬퍼 ── */

function el(tag, cls, text) {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text !== undefined && text !== null) node.textContent = String(text);
  return node;
}

/* ── 필터 ── */

function matches(n) {
  if (state.onlyBookmarked && !bookmarks.has(n.uid)) return false;
  if (state.region.size && !state.region.has(n.region_sido || '기타')) return false;
  if (state.source.size && !state.source.has(n.source || '기타')) return false;
  if (state.houseType.size && !state.houseType.has(n.house_type || '기타')) return false;
  if (state.hideNoPrice &&
      typeof n.deposit !== 'number' && typeof n.monthly_rent !== 'number') return false;

  if (state.q) {
    const hay = [
      n.title, n.region_sido, n.region_sigungu, n.house_type,
      n.source, n.institution, n.building_type, n.summary,
    ].filter(Boolean).join(' ').toLowerCase();
    for (const term of state.q.toLowerCase().split(/\s+/).filter(Boolean)) {
      if (!hay.includes(term)) return false;
    }
  }
  return true;
}

function sortRows(rows) {
  const by = state.sort;
  const copy = rows.slice();
  if (by === 'posted') {
    copy.sort((a, b) => String(b.posted_at || '').localeCompare(String(a.posted_at || '')));
  } else if (by === 'start') {
    copy.sort((a, b) => String(a.apply_start || '9999').localeCompare(String(b.apply_start || '9999')));
  } else if (by === 'rent') {
    const v = (n) => (typeof n.monthly_rent === 'number' ? n.monthly_rent : Infinity);
    copy.sort((a, b) => v(a) - v(b));
  } else {
    copy.sort((a, b) => periodState(a).order - periodState(b).order);
  }
  return copy;
}

/* ── 그리기 ── */

function buildFilters() {
  const box = document.getElementById('filters');
  box.textContent = '';

  const groups = [
    { label: '지역', field: 'region_sido', set: state.region },
    { label: '유형', field: 'house_type', set: state.houseType },
    { label: '기관', field: 'source', set: state.source },
  ];

  for (const g of groups) {
    const counts = new Map();
    for (const n of notices) {
      const key = n[g.field] || '기타';
      counts.set(key, (counts.get(key) || 0) + 1);
    }
    if (counts.size <= 1) continue;

    const row = el('div', 'filter-group');
    row.appendChild(el('span', 'label', g.label));

    const keys = [...counts.keys()].sort((a, b) => counts.get(b) - counts.get(a));
    for (const key of keys) {
      const b = el('button', 'chip');
      b.type = 'button';
      b.setAttribute('aria-pressed', g.set.has(key) ? 'true' : 'false');
      b.appendChild(document.createTextNode(key + ' '));
      b.appendChild(el('span', 'count', counts.get(key)));
      b.addEventListener('click', () => {
        if (g.set.has(key)) g.set.delete(key); else g.set.add(key);
        b.setAttribute('aria-pressed', g.set.has(key) ? 'true' : 'false');
        saveFilters();
        render();
      });
      row.appendChild(b);
    }
    box.appendChild(row);
  }
}

function card(n) {
  const wrap = el('article', 'card');
  wrap.tabIndex = 0;
  wrap.setAttribute('role', 'button');

  const badges = el('div', 'badges');
  badges.appendChild(el('span', 'badge src', n.source || '기타'));
  if (n.house_type) badges.appendChild(el('span', 'badge', n.house_type));
  const where = [n.region_sido, n.region_sigungu].filter(Boolean).join(' ');
  if (where) badges.appendChild(el('span', 'badge', where));
  if (n.status === '정정공고') badges.appendChild(el('span', 'badge fix', '정정공고'));
  wrap.appendChild(badges);

  wrap.appendChild(el('h2', 'card-title', n.title || '(제목 없음)'));

  const st = periodState(n);
  const meta = el('p', 'meta');
  const dd = el('span', `dday ${st.cls}`, st.label);
  meta.appendChild(dd);
  meta.appendChild(el('span', 'sep', '·'));
  meta.appendChild(document.createTextNode(fmtRange(n)));

  const rent = fmtMoney(n.monthly_rent);
  const dep = fmtMoney(n.deposit);
  if (dep || rent) {
    meta.appendChild(el('span', 'sep', '·'));
    const parts = [];
    if (dep) parts.push(`보증금 ${dep}`);
    if (rent) parts.push(`월 ${rent}`);
    meta.appendChild(document.createTextNode(parts.join(' / ')));
  }
  wrap.appendChild(meta);

  const star = el('button', 'star', '★');
  star.type = 'button';
  const on = bookmarks.has(n.uid);
  star.setAttribute('aria-pressed', on ? 'true' : 'false');
  star.setAttribute('aria-label', on ? '즐겨찾기 해제' : '즐겨찾기 추가');
  star.addEventListener('click', (e) => {
    e.stopPropagation();
    if (bookmarks.has(n.uid)) bookmarks.delete(n.uid); else bookmarks.add(n.uid);
    writeStore(BM_KEY, [...bookmarks]);
    render();
  });
  wrap.appendChild(star);

  const open = () => showDetail(n);
  wrap.addEventListener('click', open);
  wrap.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); }
  });
  return wrap;
}

function showDetail(n) {
  const box = document.getElementById('detailBody');
  box.textContent = '';

  box.appendChild(el('h2', null, n.title || '(제목 없음)'));

  const st = periodState(n);
  const line = el('p', 'meta');
  line.appendChild(el('span', `dday ${st.cls}`, st.label));
  line.appendChild(el('span', 'sep', '·'));
  line.appendChild(document.createTextNode(fmtRange(n)));
  box.appendChild(line);

  if (n.summary) {
    box.appendChild(el('h3', null, '요약'));
    box.appendChild(el('p', null, n.summary));
  }

  const rows = [
    ['기관', n.institution || n.source],
    ['지역', [n.region_sido, n.region_sigungu].filter(Boolean).join(' ')],
    ['공급유형', n.house_type],
    ['건물유형', n.building_type],
    ['공급호수', typeof n.supply_count === 'number' ? `${n.supply_count.toLocaleString('ko-KR')}호` : null],
    ['임대보증금', fmtMoney(n.deposit)],
    ['월임대료', fmtMoney(n.monthly_rent)],
    ['공고일', n.posted_at],
    ['당첨발표', n.winner_at],
    ['문의', n.contact],
  ].filter(([, v]) => v);

  if (rows.length) {
    box.appendChild(el('h3', null, '공고 정보'));
    const t = el('table', 'kv');
    const tb = el('tbody');
    for (const [k, v] of rows) {
      const tr = el('tr');
      tr.appendChild(el('th', null, k));
      tr.appendChild(el('td', null, v));
      tb.appendChild(tr);
    }
    t.appendChild(tb);
    box.appendChild(t);
  }

  const e = n.eligibility;
  if (e && typeof e === 'object') {
    const names = { age: '나이', income: '소득', assets: '자산', residence: '거주', other: '기타' };
    const items = Object.entries(names)
      .map(([k, label]) => [label, e[k]])
      .filter(([, v]) => typeof v === 'string' && v.trim());
    if (items.length) {
      box.appendChild(el('h3', null, '신청 자격 (공고문 요약)'));
      const t = el('table', 'kv');
      const tb = el('tbody');
      for (const [k, v] of items) {
        const tr = el('tr');
        tr.appendChild(el('th', null, k));
        tr.appendChild(el('td', null, v));
        tb.appendChild(tr);
      }
      t.appendChild(tb);
      box.appendChild(t);
    }
  }

  const links = el('div', 'links');
  const detail = safeLink(n.detail_url);
  const pdf = safeLink(n.pdf_url);
  if (detail) {
    const a = el('a', null, '공고 원문 보기');
    a.href = detail; a.target = '_blank'; a.rel = 'noopener noreferrer';
    links.appendChild(a);
  }
  if (pdf) {
    const a = el('a', null, '공고문 PDF');
    a.href = pdf; a.target = '_blank'; a.rel = 'noopener noreferrer';
    links.appendChild(a);
  }
  if (links.children.length) box.appendChild(links);

  box.appendChild(el('p', 'meta',
    '자동 수집·요약된 내용입니다. 신청 전 반드시 원문을 확인하세요.'));

  document.getElementById('detail').showModal();
}

function render() {
  const rows = sortRows(notices.filter(matches));

  const list = document.getElementById('list');
  list.textContent = '';
  const frag = document.createDocumentFragment();
  for (const n of rows) frag.appendChild(card(n));
  list.appendChild(frag);

  document.getElementById('empty').hidden = rows.length > 0;

  const bmAll = notices.filter((n) => bookmarks.has(n.uid)).length;
  document.getElementById('bmCount').textContent = bmAll ? `(${bmAll})` : '';

  const active = state.q || state.region.size || state.source.size ||
                 state.houseType.size || state.onlyBookmarked || state.hideNoPrice;
  document.getElementById('reset').hidden = !active;
  document.getElementById('resultLine').textContent =
    active ? `${notices.length}건 중 ${rows.length}건` : `공고 ${rows.length}건`;

  for (const [id, key] of [['onlyBookmarked', 'onlyBookmarked'], ['hideNoPrice', 'hideNoPrice']]) {
    document.getElementById(id).setAttribute('aria-pressed', state[key] ? 'true' : 'false');
  }
}

function showFreshness(generatedAt) {
  const node = document.getElementById('freshness');
  const when = new Date(generatedAt);
  if (Number.isNaN(when.getTime())) {
    node.textContent = '';
    return;
  }
  const hours = (Date.now() - when.getTime()) / 3600000;
  const stamp = when.toLocaleString('ko-KR', {
    month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit',
  });
  if (hours < 1) node.textContent = '방금 갱신';
  else if (hours < 24) node.textContent = `${Math.floor(hours)}시간 전 갱신 · ${stamp}`;
  else node.textContent = `${Math.floor(hours / 24)}일 전 갱신 · ${stamp}`;
  node.classList.toggle('stale', hours > STALE_HOURS);
  node.title = when.toLocaleString('ko-KR');
}

/* ── 필터 저장/복원 ── */

function saveFilters() {
  writeStore(FILTER_KEY, {
    region: [...state.region],
    source: [...state.source],
    houseType: [...state.houseType],
    onlyBookmarked: state.onlyBookmarked,
    hideNoPrice: state.hideNoPrice,
    sort: state.sort,
  });
}

function loadFilters() {
  const f = readStore(FILTER_KEY, null);
  if (!f || typeof f !== 'object') return;
  if (Array.isArray(f.region)) state.region = new Set(f.region);
  if (Array.isArray(f.source)) state.source = new Set(f.source);
  if (Array.isArray(f.houseType)) state.houseType = new Set(f.houseType);
  state.onlyBookmarked = !!f.onlyBookmarked;
  state.hideNoPrice = !!f.hideNoPrice;
  if (SORTS.includes(f.sort)) state.sort = f.sort;
}

/* ── 시작 ── */

function wireControls() {
  const q = document.getElementById('q');
  let timer = null;
  q.addEventListener('input', () => {
    clearTimeout(timer);
    timer = setTimeout(() => { state.q = q.value.trim(); render(); }, 120);
  });

  document.getElementById('sort').addEventListener('change', (e) => {
    state.sort = SORTS.includes(e.target.value) ? e.target.value : 'deadline';
    saveFilters();
    render();
  });

  for (const id of ['onlyBookmarked', 'hideNoPrice']) {
    document.getElementById(id).addEventListener('click', () => {
      state[id] = !state[id];
      saveFilters();
      render();
    });
  }

  document.getElementById('reset').addEventListener('click', () => {
    state.q = '';
    q.value = '';
    state.region.clear(); state.source.clear(); state.houseType.clear();
    state.onlyBookmarked = false;
    state.hideNoPrice = false;
    saveFilters();
    buildFilters();
    render();
  });
}

async function start() {
  bookmarks = new Set(readStore(BM_KEY, []).filter((s) => typeof s === 'string'));
  loadFilters();
  wireControls();
  document.getElementById('sort').value = state.sort;

  try {
    // no-store: 마감 임박 목록을 캐시가 물고 있으면 안 된다.
    const resp = await fetch(DATA_URL, { cache: 'no-store' });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const data = await resp.json();
    notices = Array.isArray(data.notices) ? data.notices.filter((n) => n && n.uid) : [];
    showFreshness(data.generated_at);
  } catch (err) {
    document.getElementById('freshness').textContent = '';
    const list = document.getElementById('list');
    list.textContent = '';
    const box = el('div', 'card');
    box.style.cursor = 'default';
    box.appendChild(el('h2', 'card-title', '공고를 불러오지 못했습니다'));
    box.appendChild(el('p', 'meta',
      '잠시 후 새로고침해 주세요. 계속 안 되면 오류 신고로 알려주시면 고치겠습니다.'));
    box.appendChild(el('p', 'meta', String(err && err.message || err)));
    list.appendChild(box);
    document.getElementById('empty').hidden = true;
    return;
  }

  buildFilters();
  render();
}

start();
