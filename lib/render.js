/**
 * Browser Rendering で JS 実行後の DOM を取る。
 * Cloudflare Workers 専用（@cloudflare/puppeteer に依存するため、
 * ローカルの Node サーバーからは読み込まない）。
 */
import puppeteer from '@cloudflare/puppeteer';
import { normalizeTarget, USER_AGENTS, InspectError } from './inspect.js';

const RENDER_TIMEOUT_MS = 25000;

/**
 * disconnect 後にブラウザを残しておく時間。
 * 残した分だけ無料枠のブラウザ稼働時間（10 分/日）を消費するので、
 * 続けて調べるときに再利用できる程度に短くしておく。
 */
const KEEP_ALIVE_MS = 30000;

/**
 * 空いているセッションがあれば繋ぎ直す。
 * 無料枠では新しいブラウザを 20 秒に 1 つしか作れないため、
 * 続けて調べるときは使い回さないとすぐ弾かれる。
 */
async function acquireBrowser(binding) {
  try {
    const sessions = await puppeteer.sessions(binding);
    const idle = sessions.find((s) => !s.connectionId);
    if (idle) return await puppeteer.connect(binding, idle.sessionId);
  } catch {
    // 一覧が取れない、あるいは先に取られていた場合は新規作成に回す
  }

  try {
    return await puppeteer.launch(binding, { keep_alive: KEEP_ALIVE_MS });
  } catch (err) {
    if (/429|rate ?limit/i.test(err.message)) {
      throw new InspectError('ブラウザの起動制限に達しました。20 秒ほど待ってから試してください（無料枠では 20 秒に 1 つまで）');
    }
    if (/limit|quota/i.test(err.message)) {
      throw new InspectError(`Browser Rendering を利用できませんでした: ${err.message}`);
    }
    throw err;
  }
}

export async function renderPage(binding, { url, username, password, userAgent }) {
  if (!binding) {
    throw new InspectError('Browser Rendering が有効になっていません', 501);
  }
  const target = normalizeTarget(url, username, password);
  const ua = USER_AGENTS[userAgent] ?? USER_AGENTS.browser;

  const browser = await acquireBrowser(binding);
  let page;
  try {
    page = await browser.newPage();
    await page.setUserAgent(ua);

    if (target.username || target.password) {
      // 401 チャレンジに応答する方式。ブラウザ標準の動作なので、
      // 別オリジンのサブリソースに認証情報が漏れない
      await page.authenticate({ username: target.username, password: target.password });
    }

    const response = await page.goto(target.url, {
      waitUntil: 'networkidle0',
      timeout: RENDER_TIMEOUT_MS,
    });

    return {
      html: await page.content(),
      status: response?.status() ?? null,
      finalUrl: page.url(),
    };
  } catch (err) {
    if (/timeout/i.test(err.message)) {
      throw new InspectError(`レンダリングがタイムアウトしました（${RENDER_TIMEOUT_MS / 1000} 秒）`);
    }
    throw err;
  } finally {
    // ページだけ閉じてブラウザは残す。1 分ほどで自動的に閉じるまでは次の調査で使い回せる
    try { await page?.close(); } catch { /* 閉じられなくても実害はない */ }
    try { browser.disconnect(); } catch { /* 同上 */ }
  }
}
