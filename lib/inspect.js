/**
 * ページと画像の取得。
 * Node と Cloudflare Workers の両方で動かすため、Web 標準 API だけで書く
 * （Buffer や node:http に依存しない）。
 */
import {
  decodeHtml, extractMeta, toMap, resolveUrl, validate, readImageSize, analyzeRobots,
} from './parse.js';

const MAX_HTML_BYTES = 8 * 1024 * 1024;
const MAX_IMAGE_BYTES = 12 * 1024 * 1024;
const MAX_REDIRECTS = 5;
const TIMEOUT_MS = 20000;

/** クローラごとの見え方を再現するための UA プリセット。 */
export const USER_AGENTS = {
  browser: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36',
  facebook: 'facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)',
  twitter: 'Twitterbot/1.0',
  slack: 'Slackbot-LinkExpanding 1.0 (+https://api.slack.com/robots)',
  discord: 'Mozilla/5.0 (compatible; Discordbot/2.0; +https://discordapp.com)',
  line: 'facebookexternalhit/1.1;line-poker/1.0',
  google: 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)',
};

export class InspectError extends Error {
  constructor(message, statusCode = 502) {
    super(message);
    this.name = 'InspectError';
    this.statusCode = statusCode;
  }
}

/** 取得中の例外を利用者向けの一文に言い換える。 */
export function describeFetchError(err) {
  if (err instanceof InspectError) return err.message;
  if (err.name === 'TimeoutError') return `タイムアウトしました（${TIMEOUT_MS / 1000} 秒）`;
  const code = err.cause?.code;
  const causeMessage = err.cause?.message ?? '';
  if (code === 'ENOTFOUND' || /getaddrinfo/i.test(causeMessage)) return 'ホストが見つかりません（DNS 解決に失敗）';
  if (code === 'ECONNREFUSED') return '接続を拒否されました';
  if (code === 'ECONNRESET') return '接続が切断されました';
  if (code === 'CERT_HAS_EXPIRED') return 'SSL 証明書の期限が切れています';
  if (/wrong version number/i.test(causeMessage)) return 'HTTPS で接続できませんでした。http:// を明示してみてください';
  if (/self[- ]signed|unable to verify/i.test(causeMessage)) return 'SSL 証明書を検証できません（自己署名証明書の可能性があります）';
  return causeMessage || err.message;
}

export function toBase64(str) {
  const bytes = new TextEncoder().encode(str);
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

function basicAuthHeader(username, password) {
  if (!username && !password) return null;
  return `Basic ${toBase64(`${username ?? ''}:${password ?? ''}`)}`;
}

/**
 * 入力欄の URL を正規化し、URL に埋め込まれた認証情報も取り出す。
 * スキーム省略時はローカル宛てなら http、それ以外は https を補う。
 */
export function normalizeTarget(rawUrl, username, password) {
  if (!rawUrl) throw new InspectError('URL を入力してください', 400);
  // "localhost:3000" をスキーム扱いしないよう、"://" があるときだけスキームとみなす
  const hasScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(rawUrl);
  if (hasScheme && !/^https?:\/\//i.test(rawUrl)) {
    throw new InspectError('http / https のみ対応しています', 400);
  }
  let target;
  try {
    const isLocal = /^(localhost|127\.0\.0\.1|\[::1\]|0\.0\.0\.0|[\w-]+\.local)([:/]|$)/i.test(rawUrl);
    target = new URL(hasScheme ? rawUrl : `${isLocal ? 'http' : 'https'}://${rawUrl}`);
  } catch {
    throw new InspectError('URL の形式が不正です', 400);
  }
  if (!/^https?:$/.test(target.protocol) || !target.hostname) {
    throw new InspectError('URL の形式が不正です', 400);
  }
  const user = username || (target.username ? decodeURIComponent(target.username) : '');
  const pass = password || (target.password ? decodeURIComponent(target.password) : '');
  target.username = '';
  target.password = '';
  return { url: target.toString(), username: user, password: pass };
}

/**
 * リダイレクトを自前で辿る。Basic 認証のヘッダは
 * ホストが変わった時点で外す（漏洩防止）。外した事実は呼び出し元に返す。
 */
async function fetchFollowing(startUrl, { auth, userAgent, accept }) {
  const chain = [];
  let current = startUrl;
  let authDropped = false;
  const origin = new URL(startUrl).host;

  for (let i = 0; i <= MAX_REDIRECTS; i += 1) {
    const headers = {
      'User-Agent': userAgent,
      Accept: accept,
      'Accept-Language': 'ja,en;q=0.8',
    };
    if (auth && new URL(current).host === origin) headers.Authorization = auth;
    else if (auth) authDropped = true;

    const res = await fetch(current, {
      headers,
      redirect: 'manual',
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });

    const location = res.headers.get('location');
    if (res.status >= 300 && res.status < 400 && location) {
      const next = resolveUrl(location, current);
      if (next) {
        chain.push({ from: current, to: next, status: res.status });
        current = next;
        // 追わない本文は捨てる（Workers では未消費のボディが警告になる）
        try { await res.body?.cancel(); } catch { /* 既に閉じていれば無視 */ }
        continue;
      }
    }
    return { res, finalUrl: current, chain, authDropped };
  }
  throw new InspectError(`リダイレクトが ${MAX_REDIRECTS} 回を超えました`);
}

/** 上限付きで本文を読む。Uint8Array で返す。 */
async function readBody(res, maxBytes) {
  if (!res.body) return new Uint8Array(0);
  const reader = res.body.getReader();
  const parts = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw new InspectError(`レスポンスが ${Math.round(maxBytes / 1024 / 1024)}MB を超えました`);
    }
    parts.push(value);
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.byteLength;
  }
  return out;
}

/**
 * HTML を取得してメタ情報と診断を返す。
 * 画像は取得しない（別途 probeImage を使う）。
 */
export async function inspectPage({ url, username, password, userAgent }) {
  const target = normalizeTarget(url, username, password);
  const ua = USER_AGENTS[userAgent] ?? USER_AGENTS.browser;
  const auth = basicAuthHeader(target.username, target.password);

  const page = await fetchFollowing(target.url, {
    auth,
    userAgent: ua,
    accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  });

  const result = {
    requestedUrl: target.url,
    finalUrl: page.finalUrl,
    status: page.res.status,
    statusText: page.res.statusText,
    redirects: page.chain,
    authDropped: page.authDropped,
    userAgent: ua,
    contentType: page.res.headers.get('content-type'),
    authScheme: page.res.headers.get('www-authenticate'),
  };

  if (page.res.status === 401) {
    try { await page.res.body?.cancel(); } catch { /* 無視 */ }
    const scheme = (result.authScheme || '').split(/[\s,]/)[0] || 'Basic';
    result.authFailed = true;
    result.authMessage = /digest/i.test(scheme)
      ? 'このサイトは Digest 認証です。Basic 認証のみ対応しています'
      : auth
        ? 'Basic 認証に失敗しました。ID / パスワードを確認してください'
        : 'Basic 認証が必要です。ID / パスワードを入力してください';
    return result;
  }

  if (page.res.status >= 400) {
    try { await page.res.body?.cancel(); } catch { /* 無視 */ }
    result.fetchError = `サーバーが ${page.res.status} ${page.res.statusText} を返しました`;
    return result;
  }

  const bytes = await readBody(page.res, MAX_HTML_BYTES);
  const { html, charset } = decodeHtml(bytes, result.contentType);
  const { metas, title, canonical } = extractMeta(html);
  const map = toMap(metas);

  result.bytes = bytes.byteLength;
  result.charset = charset;
  result.title = title;
  result.canonical = canonical ? resolveUrl(canonical, page.finalUrl) : null;
  result.metas = metas;
  result.map = map;
  // noindex は meta だけでなく X-Robots-Tag ヘッダでも指定できる
  result.robots = analyzeRobots({ metas, xRobotsTag: page.res.headers.get('x-robots-tag') });

  // 画像そのものはクライアントが /api/image 経由で取りにいく
  const rawImage = map['og:image:secure_url'] || map['og:image'] || map['twitter:image'];
  if (rawImage) {
    result.imageRaw = rawImage;
    result.imageUrl = resolveUrl(rawImage, page.finalUrl);
  }

  result.issues = validate({
    map,
    title,
    canonical: result.canonical,
    finalUrl: page.finalUrl,
    image: null,
    metas,
    robots: result.robots,
  });

  return result;
}

/**
 * og:image を認証付きで取得する。
 * base64 に変換せずバイト列のまま返すので CPU をほとんど使わない
 * （Workers の無料枠は 1 リクエストあたり CPU 10ms）。
 */
export async function probeImage({ url, username, password, userAgent }) {
  const target = normalizeTarget(url, username, password);
  const ua = USER_AGENTS[userAgent] ?? USER_AGENTS.browser;
  const auth = basicAuthHeader(target.username, target.password);

  const got = await fetchFollowing(target.url, {
    auth,
    userAgent: ua,
    accept: 'image/avif,image/webp,image/*,*/*;q=0.8',
  });

  const meta = {
    status: got.res.status,
    statusText: got.res.statusText,
    contentType: got.res.headers.get('content-type'),
    finalUrl: got.finalUrl,
    authDropped: got.authDropped,
  };

  if (!got.res.ok) {
    try { await got.res.body?.cancel(); } catch { /* 無視 */ }
    return { ok: false, meta };
  }

  const bytes = await readBody(got.res, MAX_IMAGE_BYTES);
  const size = readImageSize(bytes);
  meta.bytes = bytes.byteLength;
  meta.width = size?.width ?? null;
  meta.height = size?.height ?? null;

  return { ok: true, bytes, meta };
}
