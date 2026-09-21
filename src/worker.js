/**
 * Cloudflare Workers 版のエントリポイント。
 * 静的ファイルは Workers Static Assets が先に処理するため、
 * ここに来るのは /api/* だけ。
 */
import { inspectPage, probeImage, describeFetchError, toBase64 } from '../lib/inspect.js';
import { extractMeta, toMap, analyzeRobots } from '../lib/parse.js';
import { diffMeta, validateRendered } from '../lib/diff.js';
import { renderPage } from '../lib/render.js';

const MAX_BODY_BYTES = 64 * 1024;

function json(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
  });
}

async function readJson(request) {
  const declared = Number(request.headers.get('content-length') ?? 0);
  if (declared > MAX_BODY_BYTES) throw Object.assign(new Error('リクエストが大きすぎます'), { statusCode: 413 });
  const text = await request.text();
  if (text.length > MAX_BODY_BYTES) throw Object.assign(new Error('リクエストが大きすぎます'), { statusCode: 413 });
  try {
    return JSON.parse(text || '{}');
  } catch {
    throw Object.assign(new Error('JSON の解析に失敗しました'), { statusCode: 400 });
  }
}

/** ハッシュを挟んでから比べることで、長さも含めて実行時間から推測されないようにする。 */
async function timingSafeEqual(a, b) {
  const encoder = new TextEncoder();
  const [left, right] = await Promise.all([
    crypto.subtle.digest('SHA-256', encoder.encode(a)),
    crypto.subtle.digest('SHA-256', encoder.encode(b)),
  ]);
  return crypto.subtle.timingSafeEqual(left, right);
}

/**
 * Worker 全体に Basic 認証をかける。
 * 通過させる場合は null を返す。
 *
 * BASIC_USER / BASIC_PASS が未設定だと誰でも開ける状態になってしまうため、
 * その場合は素通しにせず停止する（設定忘れで公開されるほうが危険）。
 */
async function guard(request, env) {
  if (!env.BASIC_USER || !env.BASIC_PASS) {
    return new Response(
      [
        'Basic 認証が未設定のため停止しています。',
        '',
        '  npx wrangler secret put BASIC_USER',
        '  npx wrangler secret put BASIC_PASS',
        '',
        'を実行してから、もう一度開いてください。',
      ].join('\n'),
      { status: 503, headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' } },
    );
  }

  const expected = `Basic ${toBase64(`${env.BASIC_USER}:${env.BASIC_PASS}`)}`;
  const given = request.headers.get('authorization') ?? '';
  if (given && await timingSafeEqual(given, expected)) return null;

  return new Response('Unauthorized', {
    status: 401,
    headers: {
      'WWW-Authenticate': 'Basic realm="Kida OGP Debugger", charset="UTF-8"',
      'Cache-Control': 'no-store',
    },
  });
}

/**
 * JS 実行後の DOM を取り、クライアントから渡された初期 HTML の結果と比べる。
 * SNS クローラは JS を実行しない一方 Googlebot は実行するので、その差が診断になる。
 */
async function handleRender(env, body) {
  const rendered = await renderPage(env.BROWSER, body);
  const { metas, title } = extractMeta(rendered.html);
  const map = toMap(metas);
  const robots = analyzeRobots({ metas });

  const before = {
    map: body.before?.map ?? {},
    robots: { noindex: Boolean(body.before?.robots?.noindex) },
    title: body.before?.title ?? null,
  };
  const after = { map, robots, title };
  const diff = diffMeta(before.map, map);

  const issues = validateRendered({ before, after, diff });
  if (rendered.status === 401 || rendered.status === 403) {
    // 認証に失敗したページを解析しても意味がないので、先頭で気づけるようにする
    issues.unshift({
      level: 'error',
      field: 'auth',
      message: `レンダリング時に ${rendered.status} が返りました。Basic 認証の ID / パスワードを確認してください`,
    });
  }

  return {
    status: rendered.status,
    finalUrl: rendered.finalUrl,
    metas,
    map,
    robots,
    title,
    diff,
    issues,
  };
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    const denied = await guard(request, env);
    if (denied) return denied;

    if (request.method !== 'POST') {
      // 認証を通ったリクエストにだけ静的ファイルを返す
      return env.ASSETS.fetch(request);
    }

    try {
      if (url.pathname === '/api/inspect') {
        return json(await inspectPage(await readJson(request)));
      }

      if (url.pathname === '/api/render') {
        return json(await handleRender(env, await readJson(request)));
      }

      if (url.pathname === '/api/image') {
        const result = await probeImage(await readJson(request));
        if (!result.ok) {
          // 取得できなかったことも「結果」なので 200 で返し、中身で伝える
          return json({ error: `${result.meta.status} ${result.meta.statusText}`.trim(), meta: result.meta });
        }
        return new Response(result.bytes, {
          headers: {
            'Content-Type': result.meta.contentType || 'application/octet-stream',
            'Cache-Control': 'no-store',
            'X-Image-Meta': encodeURIComponent(JSON.stringify(result.meta)),
          },
        });
      }
    } catch (err) {
      // 認証情報が混ざりうるので、リクエスト内容はログにも応答にも出さない
      return json({ error: describeFetchError(err) }, err.statusCode ?? 502);
    }

    return new Response('Not Found', { status: 404 });
  },
};
