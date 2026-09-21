/**
 * 初期 HTML と JS 実行後の DOM を比べる。
 *
 * SNS クローラ（facebookexternalhit / Twitterbot / Slackbot など）は JS を実行しないので、
 * OGP は初期 HTML に無いと意味がない。一方 Googlebot はレンダリング後の DOM を見るため、
 * JS で差し込まれた noindex は実際にインデックスをブロックする。
 * この非対称を診断に落とす。
 */

/** キー単位で before / after を比べる。値は toMap 済みの辞書。 */
export function diffMeta(beforeMap, afterMap) {
  const keys = new Set([...Object.keys(beforeMap), ...Object.keys(afterMap)]);
  const added = [];
  const removed = [];
  const changed = [];

  for (const key of [...keys].sort()) {
    const before = beforeMap[key];
    const after = afterMap[key];
    if (before === undefined && after !== undefined) added.push({ key, value: after });
    else if (before !== undefined && after === undefined) removed.push({ key, value: before });
    else if (before !== after) changed.push({ key, before, after });
  }
  return { added, removed, changed };
}

const isCardTag = (key) => /^(og:|twitter:)/.test(key);

/**
 * レンダリング前後の差から診断を作る。
 * before / after は { map, robots, title } を持つ。
 */
export function validateRendered({ before, after, diff }) {
  const issues = [];
  const add = (level, field, message, detail) => issues.push({ level, field, message, detail });

  // --- noindex の出入り
  if (!before.robots.noindex && after.robots.noindex) {
    add('warn', 'robots',
      'JS 実行後に noindex が追加されています。Googlebot はレンダリング後の DOM を見るため、このページはインデックスされません',
      '初期 HTML には noindex がないので、ソースを見ただけでは気づけません');
  }
  if (before.robots.noindex && !after.robots.noindex) {
    add('error', 'robots',
      '初期 HTML の noindex を JS で取り消しています。Google は noindex を見た時点でレンダリング自体をスキップすることがあり、取り消しが効かない可能性があります',
      'インデックスさせたいなら初期 HTML から noindex を外してください');
  }

  // --- カード用タグが JS 経由でしか存在しない
  const cardAdded = diff.added.filter((d) => isCardTag(d.key));
  if (cardAdded.length) {
    add('error', 'og:*',
      `${cardAdded.map((d) => d.key).join(', ')} が JS 実行後にしか存在しません。SNS のクローラは JS を実行しないため、これらのタグは認識されません`,
      'サーバー側で HTML に埋め込む必要があります');
  }

  // --- カード用タグを JS で書き換えている
  const cardChanged = diff.changed.filter((d) => isCardTag(d.key));
  for (const d of cardChanged) {
    add('warn', d.key,
      `${d.key} を JS で書き換えています。SNS のクローラが見るのは書き換え前の値です`,
      `初期 HTML: ${d.before} → 描画後: ${d.after}`);
  }

  // --- カード用タグを JS で消している（初期 HTML の値が使われるので実害は薄い）
  const cardRemoved = diff.removed.filter((d) => isCardTag(d.key));
  if (cardRemoved.length) {
    add('info', 'og:*',
      `${cardRemoved.map((d) => d.key).join(', ')} が JS 実行後に消えています。SNS のクローラには初期 HTML の値が見えるため、カードには影響しません`);
  }

  // --- title の書き換え
  if (before.title !== after.title && after.title) {
    add('info', '<title>',
      'JS で <title> を書き換えています',
      `初期 HTML: ${before.title ?? '(なし)'} → 描画後: ${after.title}`);
  }

  if (!issues.length) {
    add('ok', '', 'JS 実行の前後でメタ情報に差はありませんでした');
  }
  return issues;
}
