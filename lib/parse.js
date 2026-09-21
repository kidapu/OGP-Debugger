/**
 * HTML から meta 情報を抽出し、OGP として妥当かを検証する。
 * 外部依存なしで動かすため、DOM を組まずにタグ単位の走査で処理する。
 */

const META_TAG_RE = /<meta\b[^>]*>/gi;
const ATTR_RE = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/g;
const TITLE_RE = /<title[^>]*>([\s\S]*?)<\/title>/i;
const LINK_TAG_RE = /<link\b[^>]*>/gi;
const HEAD_END_RE = /<\/head\s*>/i;

const HTML_ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', '#39': "'",
};

function decodeEntities(str) {
  return str.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (whole, name) => {
    if (name[0] === '#') {
      const code = name[1] === 'x' || name[1] === 'X'
        ? parseInt(name.slice(2), 16)
        : parseInt(name.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : whole;
    }
    const lower = name.toLowerCase();
    return Object.hasOwn(HTML_ENTITIES, lower) ? HTML_ENTITIES[lower] : whole;
  });
}

function parseAttrs(tag) {
  const attrs = {};
  ATTR_RE.lastIndex = 0;
  let m;
  while ((m = ATTR_RE.exec(tag)) !== null) {
    const value = m[2] ?? m[3] ?? m[4] ?? '';
    attrs[m[1].toLowerCase()] = decodeEntities(value);
  }
  return attrs;
}

/**
 * レスポンスの文字コードを決めて文字列化する。
 * Shift_JIS や EUC-JP の国内サイトを取りこぼさないため、
 * Content-Type ヘッダ → <meta charset> の順で判定する。
 */
export function decodeHtml(buffer, contentTypeHeader) {
  const bytes = new Uint8Array(buffer);
  let charset = null;

  const headerMatch = /charset\s*=\s*["']?([\w-]+)/i.exec(contentTypeHeader || '');
  if (headerMatch) charset = headerMatch[1];

  if (!charset) {
    // meta charset を読むために、先頭 4KB だけ ASCII 互換として覗く
    const head = new TextDecoder('latin1').decode(bytes.subarray(0, 4096));
    const metaCharset = /<meta[^>]+charset\s*=\s*["']?([\w-]+)/i.exec(head);
    if (metaCharset) charset = metaCharset[1];
  }

  const normalized = (charset || 'utf-8').toLowerCase();
  try {
    return { html: new TextDecoder(normalized).decode(bytes), charset: normalized };
  } catch {
    return { html: new TextDecoder('utf-8').decode(bytes), charset: 'utf-8 (fallback)' };
  }
}

/** meta / title / link を抽出する。OGP は head 内のものだけを正とする。 */
export function extractMeta(html) {
  const headEnd = HEAD_END_RE.exec(html);
  const head = headEnd ? html.slice(0, headEnd.index) : html;

  const metas = [];
  META_TAG_RE.lastIndex = 0;
  let m;
  while ((m = META_TAG_RE.exec(head)) !== null) {
    const attrs = parseAttrs(m[0]);
    const key = attrs.property || attrs.name || attrs.itemprop;
    if (!key || attrs.content === undefined) continue;
    metas.push({ key: key.trim(), value: attrs.content.trim(), source: attrs.property ? 'property' : 'name' });
  }

  const links = [];
  LINK_TAG_RE.lastIndex = 0;
  while ((m = LINK_TAG_RE.exec(head)) !== null) {
    const attrs = parseAttrs(m[0]);
    if (attrs.rel && attrs.href) links.push({ rel: attrs.rel.toLowerCase(), href: attrs.href.trim() });
  }

  const titleMatch = TITLE_RE.exec(head);
  const title = titleMatch ? decodeEntities(titleMatch[1]).trim().replace(/\s+/g, ' ') : null;

  const canonical = links.find((l) => l.rel.split(/\s+/).includes('canonical'))?.href ?? null;

  return { metas, links, title, canonical };
}

/** 同じキーが複数あっても最初の 1 件を正として辞書化する（重複は別途警告する）。 */
export function toMap(metas) {
  const map = {};
  for (const meta of metas) {
    const k = meta.key.toLowerCase();
    if (!Object.hasOwn(map, k)) map[k] = meta.value;
  }
  return map;
}

export function resolveUrl(href, baseUrl) {
  if (!href) return null;
  try {
    return new URL(href, baseUrl).toString();
  } catch {
    return null;
  }
}

/**
 * robots 指定を meta タグとレスポンスヘッダの両方から読む。
 * ステージングの noindex を本番で外し忘れる事故が一番多いので、
 * 「どこで指定されているか」まで返して原因をたどれるようにする。
 */

// meta name に入りうるクローラ名。robots は全クローラ共通の指定。
const ROBOT_META_NAMES = new Set([
  'robots', 'googlebot', 'googlebot-news', 'bingbot', 'msnbot', 'slurp',
  'duckduckbot', 'yandex', 'baiduspider', 'naver', 'applebot',
]);

// "max-snippet:50" のように値を伴うディレクティブ（UA プレフィックスと区別する）
const VALUED_DIRECTIVES = new Set([
  'max-snippet', 'max-image-preview', 'max-video-preview', 'unavailable_after',
]);

/** "googlebot: noindex, nofollow" のような値を {ua, directive} の並びに分解する。 */
function splitDirectives(value) {
  const out = [];
  let ua = null;
  for (const rawToken of String(value).split(',')) {
    const token = rawToken.trim();
    if (!token) continue;
    const colon = token.indexOf(':');
    if (colon > 0) {
      const left = token.slice(0, colon).trim().toLowerCase();
      if (!VALUED_DIRECTIVES.has(left)) {
        // UA プレフィックス。以降のトークンはこの UA 向けとして続く
        ua = left;
        const rest = token.slice(colon + 1).trim();
        if (rest) out.push({ ua, directive: rest.toLowerCase() });
        continue;
      }
    }
    out.push({ ua, directive: token.toLowerCase() });
  }
  return out;
}

export function analyzeRobots({ metas = [], xRobotsTag = null }) {
  const sources = [];

  for (const meta of metas) {
    const name = meta.key.toLowerCase();
    if (meta.source !== 'name' || !ROBOT_META_NAMES.has(name)) continue;
    sources.push({
      origin: 'meta',
      label: `<meta name="${meta.key}">`,
      ua: name === 'robots' ? null : name,
      value: meta.value,
      directives: splitDirectives(meta.value).map((d) => d.directive),
    });
  }

  if (xRobotsTag) {
    // 同名ヘッダが複数あると Headers.get はカンマで連結して返す
    for (const { ua, directive } of splitDirectives(xRobotsTag)) {
      sources.push({
        origin: 'header',
        label: 'X-Robots-Tag',
        ua,
        value: directive,
        directives: [directive],
      });
    }
  }

  const all = sources.flatMap((s) => s.directives.map((d) => ({ ...s, directive: d })));
  const has = (name) => all.filter((d) => d.directive === name || d.directive === 'none');

  const noindexBy = has('noindex');
  const nofollowBy = has('nofollow');

  return {
    sources,
    // 全クローラ向け（ua なし、または robots）の noindex だけを「検索に出ない」と判定する
    noindex: noindexBy.some((d) => !d.ua),
    noindexForSome: noindexBy.filter((d) => d.ua),
    nofollow: nofollowBy.some((d) => !d.ua),
    noarchive: all.some((d) => d.directive === 'noarchive'),
    nosnippet: all.some((d) => d.directive === 'nosnippet'),
    noindexBy,
    nofollowBy,
    directives: [...new Set(all.map((d) => d.directive))],
  };
}

const LEVEL = { error: 'error', warn: 'warn', info: 'info', ok: 'ok' };

/**
 * OGP の検証。クローラが実際に落ちる/見栄えが崩れるものを error、
 * 推奨から外れるだけのものを warn、あれば良い程度を info とする。
 */
export function validate({ map, title, canonical, finalUrl, image, metas, robots }) {
  const issues = [];
  const add = (level, field, message, detail) => issues.push({ level, field, message, detail });

  const ogTitle = map['og:title'];
  const ogDesc = map['og:description'];
  const ogImage = map['og:image'];
  const ogUrl = map['og:url'];
  const ogType = map['og:type'];
  const ogSiteName = map['og:site_name'];
  const twCard = map['twitter:card'];

  // --- og:title
  if (!ogTitle) {
    if (title) add(LEVEL.warn, 'og:title', 'og:title がありません。<title> が代用されますが、明示を推奨します', title);
    else add(LEVEL.error, 'og:title', 'og:title も <title> もありません。カードのタイトルが空になります');
  } else if ([...ogTitle].length > 60) {
    add(LEVEL.warn, 'og:title', `og:title が ${[...ogTitle].length} 文字あります。60 文字前後で省略されます`);
  }

  // --- og:description
  if (!ogDesc) {
    if (map.description) add(LEVEL.warn, 'og:description', 'og:description がありません。meta description が代用されます');
    else add(LEVEL.warn, 'og:description', 'og:description がありません。カードの説明文が空になります');
  } else if ([...ogDesc].length > 200) {
    add(LEVEL.warn, 'og:description', `og:description が ${[...ogDesc].length} 文字あります。日本語なら 80〜120 文字程度が無難です`);
  }

  // --- og:image
  if (!ogImage) {
    add(LEVEL.error, 'og:image', 'og:image がありません。画像なしの小さなカードになります');
  } else {
    if (!/^https?:\/\//i.test(ogImage)) {
      add(LEVEL.error, 'og:image', 'og:image が絶対 URL ではありません。多くのクローラが解決に失敗します', ogImage);
    }
    if (/^http:\/\//i.test(ogImage) && /^https:\/\//i.test(finalUrl || '')) {
      add(LEVEL.warn, 'og:image', 'HTTPS ページで og:image が HTTP です。ブロックされる可能性があります');
    }
    if (image?.error) {
      add(LEVEL.error, 'og:image', `og:image を取得できませんでした: ${image.error}`, image.url);
    } else if (image) {
      if (image.status === 401 || image.status === 403) {
        add(LEVEL.error, 'og:image', `og:image が ${image.status} を返しました。画像が認証で保護されているとクローラから見えません`, image.url);
      }
      if (image.bytes && image.bytes > 5 * 1024 * 1024) {
        add(LEVEL.warn, 'og:image', `og:image が ${(image.bytes / 1024 / 1024).toFixed(1)}MB あります。5MB 以下を推奨します`);
      }
      if (image.contentType && !/^image\//i.test(image.contentType)) {
        add(LEVEL.error, 'og:image', `og:image の Content-Type が ${image.contentType} です。画像として扱われません`);
      }
    }
    if (!map['og:image:alt']) {
      add(LEVEL.info, 'og:image:alt', 'og:image:alt がありません。スクリーンリーダー向けに推奨されます');
    }
  }

  // --- og:url / canonical
  if (!ogUrl) {
    add(LEVEL.warn, 'og:url', 'og:url がありません。正規 URL を明示することを推奨します');
  } else {
    if (!/^https?:\/\//i.test(ogUrl)) {
      add(LEVEL.error, 'og:url', 'og:url が絶対 URL ではありません', ogUrl);
    } else if (canonical) {
      const norm = (u) => { try { const x = new URL(u, finalUrl); x.hash = ''; return x.toString().replace(/\/$/, ''); } catch { return u; } };
      if (norm(ogUrl) !== norm(canonical)) {
        add(LEVEL.warn, 'og:url', 'og:url と canonical が一致していません', `og:url=${ogUrl} / canonical=${canonical}`);
      }
    }
  }

  if (!ogType) add(LEVEL.warn, 'og:type', 'og:type がありません。website や article の指定を推奨します');
  if (!ogSiteName) add(LEVEL.info, 'og:site_name', 'og:site_name がありません');

  // --- Twitter Card
  if (!twCard) {
    add(LEVEL.warn, 'twitter:card', 'twitter:card がありません。X では小さいカードで表示されることがあります');
  } else if (!['summary', 'summary_large_image', 'app', 'player'].includes(twCard)) {
    add(LEVEL.error, 'twitter:card', `twitter:card の値 "${twCard}" は不正です`);
  } else if (twCard === 'summary' && ogImage) {
    add(LEVEL.info, 'twitter:card', 'twitter:card が summary です。大きな画像で見せるなら summary_large_image を指定します');
  }

  // --- 重複タグ
  const counts = new Map();
  for (const meta of metas) {
    const k = meta.key.toLowerCase();
    if (!k.startsWith('og:') && !k.startsWith('twitter:')) continue;
    counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  for (const [k, n] of counts) {
    // og:image は複数指定が仕様上有効なので対象外
    if (n > 1 && k !== 'og:image' && k !== 'og:locale:alternate') {
      add(LEVEL.warn, k, `${k} が ${n} 個あります。クローラごとに採用するものが変わります`);
    }
  }

  // --- robots（noindex は本番公開時の外し忘れが致命的なので必ず目に入れる）
  if (robots) {
    if (robots.noindex) {
      const where = [...new Set(robots.noindexBy.filter((d) => !d.ua).map((d) => d.label))].join(' / ');
      add(LEVEL.warn, 'robots', 'noindex が指定されています。検索結果に表示されません（本番公開時は外し忘れに注意）', where);
    }
    for (const d of robots.noindexForSome) {
      add(LEVEL.info, 'robots', `${d.ua} に対してのみ noindex が指定されています`, d.label);
    }
    if (robots.nofollow) {
      add(LEVEL.info, 'robots', 'nofollow が指定されています。ページ内リンクは辿られません');
    }
    if (robots.noarchive) add(LEVEL.info, 'robots', 'noarchive が指定されています。キャッシュが保存されません');
    if (robots.nosnippet) add(LEVEL.info, 'robots', 'nosnippet が指定されています。検索結果にスニペットが出ません');
  }

  return issues;
}

/** 画像の実寸をバイト列から読む（PNG / JPEG / GIF / WebP のヘッダのみ解析）。 */
export function readImageSize(bytes) {
  const b = new Uint8Array(bytes);
  const view = new DataView(b.buffer, b.byteOffset, b.byteLength);

  // PNG
  if (b.length > 24 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) {
    return { width: view.getUint32(16), height: view.getUint32(20) };
  }
  // GIF
  if (b.length > 10 && b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) {
    return { width: view.getUint16(6, true), height: view.getUint16(8, true) };
  }
  // WebP
  if (b.length > 30 && b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46
      && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) {
    const fmt = String.fromCharCode(b[12], b[13], b[14], b[15]);
    if (fmt === 'VP8 ') return { width: view.getUint16(26, true) & 0x3fff, height: view.getUint16(28, true) & 0x3fff };
    if (fmt === 'VP8L') {
      const bits = view.getUint32(21, true);
      return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 };
    }
    if (fmt === 'VP8X') {
      const w = b[24] | (b[25] << 8) | (b[26] << 16);
      const h = b[27] | (b[28] << 8) | (b[29] << 16);
      return { width: w + 1, height: h + 1 };
    }
  }
  // JPEG: SOFn マーカーまでセグメントを辿る
  if (b.length > 4 && b[0] === 0xff && b[1] === 0xd8) {
    let i = 2;
    while (i + 9 < b.length) {
      if (b[i] !== 0xff) { i += 1; continue; }
      const marker = b[i + 1];
      if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { i += 2; continue; }
      const len = view.getUint16(i + 2);
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        return { width: view.getUint16(i + 7), height: view.getUint16(i + 5) };
      }
      i += 2 + len;
    }
  }
  return null;
}
