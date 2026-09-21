const $ = (sel) => document.querySelector(sel);
const form = $('#form');
const statusBox = $('#status');
const resultBox = $('#result');
const submitBtn = $('#submit');

let current = null;
let activeTab = 'x';
let baseIssues = [];
let objectUrl = null;

/* ---------- 入力の保持（パスワードはタブを閉じると消える sessionStorage のみ） ---------- */
const SAVED_URL = 'ogp-debugger:url';
const SAVED_CREDS = 'ogp-debugger:creds';

function restoreInputs() {
  try {
    const url = localStorage.getItem(SAVED_URL);
    if (url) $('#url').value = url;
    const creds = JSON.parse(sessionStorage.getItem(SAVED_CREDS) || 'null');
    if (creds) {
      $('#username').value = creds.username ?? '';
      $('#password').value = creds.password ?? '';
      $('#remember').checked = true;
    }
  } catch { /* プライベートモードなどでは黙って諦める */ }
}

function persistInputs({ url, username, password }) {
  try {
    localStorage.setItem(SAVED_URL, url);
    if ($('#remember').checked) sessionStorage.setItem(SAVED_CREDS, JSON.stringify({ username, password }));
    else sessionStorage.removeItem(SAVED_CREDS);
  } catch { /* 同上 */ }
}

/* ---------- 送信 ---------- */
form.addEventListener('submit', async (e) => {
  e.preventDefault();
  const payload = {
    url: $('#url').value.trim(),
    username: $('#username').value,
    password: $('#password').value,
    userAgent: $('#userAgent').value,
  };
  if (!payload.url) return;
  persistInputs(payload);

  submitBtn.disabled = true;
  submitBtn.textContent = '取得中…';
  showStatus('取得しています…');
  resultBox.hidden = true;
  $('#render-section').hidden = true;

  try {
    const res = await fetch('/api/inspect', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || `エラー (${res.status})`);
    current = data;
    baseIssues = data.issues ?? [];
    render(data);
    // 画像は本文とは別に取りにいく（サーバー側で base64 化しないぶん軽い）
    const jobs = [];
    if (data.imageUrl) jobs.push(loadImage(payload));
    if ($('#render').checked) jobs.push(loadRendered(payload));
    await Promise.all(jobs);
  } catch (err) {
    showStatus(err.message, true);
  } finally {
    submitBtn.disabled = false;
    submitBtn.textContent = 'チェックする';
  }
});

/**
 * og:image を /api/image 経由で取得する。
 * 認証が要る画像もここで取れる。寸法などは X-Image-Meta ヘッダで受け取る。
 */
async function loadImage(payload) {
  const target = current.imageUrl;
  try {
    const res = await fetch('/api/image', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...payload, url: target }),
    });
    const contentType = res.headers.get('content-type') ?? '';
    if (contentType.includes('application/json')) {
      const data = await res.json();
      current.image = { raw: current.imageRaw, url: target, error: data.error || `エラー (${res.status})`, meta: data.meta };
    } else {
      const meta = JSON.parse(decodeURIComponent(res.headers.get('x-image-meta') || '%7B%7D'));
      const blob = await res.blob();
      if (objectUrl) URL.revokeObjectURL(objectUrl);
      objectUrl = URL.createObjectURL(blob);
      current.image = { raw: current.imageRaw, url: target, meta, objectUrl };
    }
  } catch (err) {
    current.image = { raw: current.imageRaw, url: target, error: err.message };
  }
  current.issues = [...baseIssues, ...imageIssues(current.image)];
  renderSummary(current);
  renderIssues(current.issues);
  renderPreview();
}

/**
 * JS 実行後の DOM を Workers 側で取得し、初期 HTML との差分を表示する。
 * 初期 HTML の解析結果を before として渡すので、取得は 1 往復で済む。
 */
async function loadRendered(payload) {
  const section = $('#render-section');
  const body = $('#render-body');
  section.hidden = false;
  body.replaceChildren(el('p', { class: 'empty', text: 'ブラウザで JS を実行して確認しています…' }));

  try {
    const res = await fetch('/api/render', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ...payload,
        before: {
          map: current.map ?? {},
          robots: { noindex: Boolean(current.robots?.noindex) },
          title: current.title ?? null,
        },
      }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || `エラー (${res.status})`);
    renderDiff(data);
  } catch (err) {
    body.replaceChildren(el('p', { class: 'empty', text: err.message }));
  }
}

function renderDiff(data) {
  const nodes = [];

  const issues = el('ul', { class: 'issues' }, (data.issues ?? []).map((i) => el('li', { class: i.level }, [
    el('span', { class: 'lv', text: i.level.toUpperCase() }),
    el('span', {}, [
      el('span', { text: i.message }),
      i.detail ? el('span', { class: 'detail', text: i.detail }) : null,
    ]),
  ])));
  nodes.push(issues);

  const rows = [
    ...data.diff.added.map((d) => ({ cls: 'added', mark: '+', key: d.key, value: d.value })),
    ...data.diff.changed.map((d) => ({ cls: 'changed', mark: '~', key: d.key, value: d.after, was: d.before })),
    ...data.diff.removed.map((d) => ({ cls: 'removed', mark: '−', key: d.key, value: d.value })),
  ];
  if (rows.length) {
    nodes.push(el('ul', { class: 'diff-list' }, rows.map((r) => el('li', { class: r.cls }, [
      el('span', { class: 'mark', text: r.mark }),
      el('span', { class: 'key', text: r.key }),
      el('span', { class: 'val' }, [
        r.was ? el('span', { class: 'was', text: r.was }) : null,
        el('span', { text: r.value }),
      ]),
    ]))));
  }

  $('#render-body').replaceChildren(...nodes);
}

/** 画像を実際に取得してはじめて分かることを診断する。 */
function imageIssues(image) {
  const out = [];
  const add = (level, message, detail) => out.push({ level, field: 'og:image', message, detail });

  if (image.error) {
    if (/^(401|403)\b/.test(image.error)) {
      add('error', `og:image が ${image.error} を返しました。画像が認証で保護されているとクローラから見えません`, image.url);
    } else {
      add('error', `og:image を取得できませんでした: ${image.error}`, image.url);
    }
    return out;
  }

  const m = image.meta ?? {};
  if (m.contentType && !/^image\//i.test(m.contentType)) {
    add('error', `og:image の Content-Type が ${m.contentType} です。画像として扱われません`);
  }
  if (m.bytes > 5 * 1024 * 1024) {
    add('warn', `og:image が ${(m.bytes / 1024 / 1024).toFixed(1)}MB あります。5MB 以下を推奨します`);
  }
  if (m.authDropped) {
    add('warn', 'og:image のリダイレクトでホストが変わったため、認証情報を送らずに取得しました');
  }
  if (m.width && m.height) {
    if (m.width < 200 || m.height < 200) {
      add('error', `画像が ${m.width}×${m.height} しかありません。200×200 未満はカードに表示されません`);
    } else if (m.width < 600) {
      add('warn', `画像の幅が ${m.width}px です。大きなカードには 1200×630 を推奨します`);
    }
    const ratio = m.width / m.height;
    if (m.width >= 600 && (ratio < 1.6 || ratio > 2.2)) {
      add('info', `画像の比率が ${ratio.toFixed(2)}:1 です。1.91:1（1200×630）だと上下が切れません`);
    }
  } else if (m.contentType && /^image\//i.test(m.contentType)) {
    add('info', '画像の寸法を読み取れませんでした（SVG などヘッダから寸法が分からない形式）');
  }
  return out;
}

function showStatus(message, isError = false) {
  statusBox.hidden = false;
  statusBox.textContent = message;
  statusBox.classList.toggle('is-error', isError);
}

/* ---------- 描画 ---------- */
function render(data) {
  renderSummary(data);

  if (data.authFailed || data.fetchError) {
    showStatus(data.authMessage || data.fetchError, true);
    $('#issues').replaceChildren(el('li', { class: 'error' }, [
      el('span', { class: 'lv', text: 'ERROR' }),
      el('span', { text: data.authMessage || data.fetchError }),
    ]));
    $('#issue-count').textContent = '';
    $('#preview').replaceChildren();
    $('#tags').replaceChildren(el('p', { class: 'empty', text: 'ページを取得できなかったため、メタタグはありません。' }));
    resultBox.hidden = false;
    return;
  }

  statusBox.hidden = true;
  renderIssues(data.issues ?? []);
  renderPreview();
  renderTags(data);
  resultBox.hidden = false;
}

function renderSummary(data) {
  const dl = $('#summary-list');
  const rows = [];
  const okStatus = data.status >= 200 && data.status < 300;
  rows.push(['ステータス', el('span', {
    class: `pill ${okStatus ? 'pill--ok' : 'pill--bad'}`,
    text: `${data.status} ${data.statusText ?? ''}`.trim(),
  })]);
  rows.push(['最終 URL', el('span', { text: data.finalUrl })]);
  if (data.redirects?.length) {
    rows.push(['リダイレクト', el('span', {
      text: `${data.redirects.length} 回 — ` + data.redirects.map((r) => `${r.status} → ${r.to}`).join(' / '),
    })]);
  }
  if (data.authDropped) {
    rows.push(['注意', el('span', {
      class: 'pill pill--bad',
      text: 'リダイレクトでホストが変わったため認証情報を送っていません',
    })]);
  }
  if (data.robots) {
    const r = data.robots;
    rows.push(['インデックス', el('span', {}, [
      el('span', {
        class: `pill ${r.noindex ? 'pill--bad' : 'pill--ok'}`,
        text: r.noindex ? 'noindex' : 'index 可',
      }),
      el('span', { class: 'sub', text: robotsDetail(r) }),
    ])]);
  }
  if (data.charset) rows.push(['文字コード', el('span', { text: data.charset })]);
  if (data.contentType) rows.push(['Content-Type', el('span', { text: data.contentType })]);
  rows.push(['サイズ', el('span', { text: `${(data.bytes / 1024).toFixed(1)} KB` })]);
  if (data.imageUrl) rows.push(['og:image', el('span', { text: imageSummaryText(data.image) })]);
  rows.push(['User-Agent', el('code', { text: data.userAgent })]);

  dl.replaceChildren(...rows.flatMap(([k, v]) => [el('dt', { text: k }), el('dd', {}, [v])]));
}

function imageSummaryText(image) {
  if (!image) return '取得中…';
  if (image.error) return `取得失敗: ${image.error}`;
  const m = image.meta ?? {};
  return [
    m.width && m.height ? `${m.width}×${m.height}` : null,
    m.contentType,
    m.bytes ? `${(m.bytes / 1024).toFixed(0)} KB` : null,
  ].filter(Boolean).join('  ');
}

/** robots がどこで何と指定されているかを 1 行にまとめる。 */
function robotsDetail(r) {
  if (!r.sources.length) return ' robots 指定なし';
  const byLabel = new Map();
  for (const src of r.sources) {
    const list = byLabel.get(src.label) ?? [];
    for (const d of src.directives) list.push(src.ua && src.origin === 'header' ? `${src.ua}: ${d}` : d);
    byLabel.set(src.label, list);
  }
  return ' ' + [...byLabel].map(([label, ds]) => `${label} → ${[...new Set(ds)].join(', ')}`).join(' / ');
}

function renderIssues(issues) {
  const order = { error: 0, warn: 1, info: 2, ok: 3 };
  const sorted = [...issues].sort((a, b) => order[a.level] - order[b.level]);
  const counts = issues.reduce((acc, i) => ({ ...acc, [i.level]: (acc[i.level] ?? 0) + 1 }), {});
  $('#issue-count').textContent = issues.length
    ? `エラー ${counts.error ?? 0} / 警告 ${counts.warn ?? 0} / 情報 ${counts.info ?? 0}`
    : '';

  const list = $('#issues');
  if (!sorted.length) {
    list.replaceChildren(el('li', { class: 'ok' }, [
      el('span', { class: 'lv', text: 'OK' }),
      el('span', { text: '問題は見つかりませんでした。' }),
    ]));
    return;
  }
  list.replaceChildren(...sorted.map((i) => el('li', { class: i.level }, [
    el('span', { class: 'lv', text: i.level.toUpperCase() }),
    el('span', {}, [
      el('span', { text: i.message }),
      i.field ? el('span', { class: 'detail' }, [el('span', { class: 'field-name', text: i.field }), el('span', { text: i.detail ? ` — ${i.detail}` : '' })]) : null,
    ]),
  ])));
}

/* ---------- カードプレビュー ---------- */
$('#tabs').addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-tab]');
  if (!btn) return;
  activeTab = btn.dataset.tab;
  for (const b of $('#tabs').children) b.classList.toggle('is-active', b === btn);
  renderPreview();
});

/** 各サービスが実際に参照するタグの優先順でカード内容を決める。 */
function cardData(platform) {
  const m = current.map ?? {};
  const host = (() => { try { return new URL(current.finalUrl).hostname.replace(/^www\./, ''); } catch { return ''; } })();
  const base = {
    title: m['og:title'] || current.title || '(タイトルなし)',
    desc: m['og:description'] || m.description || '',
    host,
    image: current.image?.objectUrl ?? null,
  };
  if (platform === 'x') {
    return {
      ...base,
      title: m['twitter:title'] || base.title,
      desc: m['twitter:description'] || base.desc,
      summaryOnly: (m['twitter:card'] || 'summary') === 'summary',
    };
  }
  if (platform === 'slack' || platform === 'discord') {
    return { ...base, host: m['og:site_name'] || host };
  }
  return base;
}

function renderPreview() {
  if (!current) return;
  const d = cardData(activeTab);
  const wrap = $('#preview');
  const placeholder = current.image?.error ? '画像を取得できませんでした'
    : current.imageUrl && !current.image ? '画像を取得中…'
    : '画像なし';
  const imgNode = d.image
    ? el('img', { src: d.image, alt: '' })
    : el('div', { class: 'noimg', text: placeholder });

  const body = el('div', { class: 'body' }, [
    activeTab === 'x' ? null : el('div', { class: 'host', text: d.host }),
    el('div', { class: 'title', text: d.title }),
    d.desc ? el('div', { class: 'desc', text: d.desc }) : null,
    activeTab === 'x' ? el('div', { class: 'host', text: d.host }) : null,
  ]);

  const isSmall = activeTab === 'x' && d.summaryOnly;
  const card = el('div', { class: `card card--${activeTab}${isSmall ? ' is-summary' : ''}` },
    activeTab === 'slack' || activeTab === 'discord' ? [body, imgNode] : [imgNode, body]);

  const notes = [];
  if (activeTab === 'x') {
    if (d.summaryOnly) notes.push('twitter:card が summary のため小さいカードで表示されます');
    const twImage = current.map?.['twitter:image'];
    if (twImage && current.image && twImage !== current.image.raw) {
      notes.push('twitter:image が og:image と別指定です（プレビューは og:image）');
    }
  }
  const note = notes.length ? el('p', { class: 'preview-note', text: notes.join(' / ') }) : null;
  wrap.replaceChildren(...[card, note].filter(Boolean));
}

/* ---------- タグ一覧 ---------- */
function renderTags(data) {
  const metas = data.metas ?? [];
  const groups = [
    ['Open Graph', metas.filter((m) => m.key.toLowerCase().startsWith('og:'))],
    ['Twitter Card', metas.filter((m) => m.key.toLowerCase().startsWith('twitter:'))],
    ['その他', metas.filter((m) => !/^(og|twitter):/i.test(m.key))],
  ];
  const container = $('#tags');
  const nodes = [];

  const head = [];
  if (data.title) head.push({ key: '<title>', value: data.title });
  if (data.canonical) head.push({ key: 'canonical', value: data.canonical });
  // ヘッダ由来の指定はメタタグ一覧に現れないので、ここで補って見えるようにする
  const headerRobots = (data.robots?.sources ?? []).filter((src) => src.origin === 'header');
  if (headerRobots.length) {
    head.push({
      key: 'X-Robots-Tag (ヘッダ)',
      value: headerRobots.map((src) => (src.ua ? `${src.ua}: ${src.value}` : src.value)).join(', '),
    });
  }
  if (head.length) nodes.push(tagGroup('ページ', head, false));

  for (const [name, items] of groups) {
    if (!items.length) continue;
    nodes.push(tagGroup(name, items, name !== 'その他'));
  }
  if (!nodes.length) nodes.push(el('p', { class: 'empty', text: 'メタタグが 1 つも見つかりませんでした。' }));
  container.replaceChildren(...nodes);
}

function tagGroup(name, items, showLength) {
  return el('div', { class: 'tag-group' }, [
    el('h3', { text: name }),
    el('table', { class: 'tags' }, [
      el('tbody', {}, items.map((m) => el('tr', {}, [
        el('td', { class: 'k', text: m.key }),
        el('td', { text: m.value }),
        showLength ? el('td', { class: 'len', text: `${[...m.value].length}字` }) : null,
      ]))),
    ]),
  ]);
}

/* ---------- 小さな DOM ヘルパー（値は必ず textContent 経由で入れる） ---------- */
function el(tag, props = {}, children = []) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v == null) continue;
    if (k === 'text') node.textContent = v;
    else node.setAttribute(k, v);
  }
  for (const c of children) if (c) node.appendChild(c);
  return node;
}

restoreInputs();
