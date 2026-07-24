// lib/eligible-scale.js — 事業者規模（従業員数）マッチングの純関数。
//
// 目的: 補助金の「対象規模」と、ユーザーの従業員数＋業種から求めた規模クラスを
//   突き合わせて、規模でのフィルタリングを可能にする。
//
// 規模区分の SSoT: 中小企業基本法 第2条（中小企業庁）
//   https://www.chusho.meti.go.jp/soshiki/teigi.html
//   ※ 本フィルタは「従業員数」のみで判定する（資本金は未使用の簡略化）。
//
// I/O を持たない純関数。lib/save-to-db.js（補助金の分類）・
// lib/match-user-subsidy.js（配信判定）・scripts の backfill から共用する。

// 4 区分の従業員数上限 { sme: 中小企業者, small: 小規模企業者 }。
const SEGMENT_THRESHOLDS = {
  manufacturing: { sme: 300, small: 20 }, // 製造業・建設業・運輸業その他
  wholesale:     { sme: 100, small: 5 },  // 卸売業
  retail:        { sme: 50,  small: 5 },  // 小売業
  service:       { sme: 100, small: 5 },  // サービス業
};

// register.js の 12 業種 → 中小企業基本法 4 区分。
// 卸売・小売はまとめて緩め側（卸売=100）に寄せる。農林水産・その他は「その他」＝製造業区分。
const CATEGORY_TO_SEGMENT = {
  new_technology: 'manufacturing',
  construction:   'manufacturing',
  agriculture:    'manufacturing',
  other:          'manufacturing',
  wholesale:      'wholesale',
  it:             'service',
  entertainment:  'service',
  professional:   'service',
  finance:        'service',
  realestate:     'service',
  hospitality:    'service',
  medical:        'service',
};

/**
 * ユーザーの従業員数＋業種から規模クラスを判定する。
 * 複数業種選択時は最大しきい値を採用（＝緩め: 誤って大企業扱いにして除外しない）。
 * 業種未選択/不明は最も緩い製造業その他基準。
 * @param {number|string|null} employeeCount
 * @param {string[]} categories
 * @returns {'small'|'sme'|'large'|null} 従業員数未入力は null（規模で絞らない）
 */
function classifyUserScale(employeeCount, categories) {
  if (employeeCount === null || employeeCount === undefined || employeeCount === '') return null;
  const emp = Number(employeeCount);
  if (!Number.isFinite(emp)) return null;
  const segs = (Array.isArray(categories) ? categories : [])
    .map((c) => CATEGORY_TO_SEGMENT[c])
    .filter(Boolean);
  const list = segs.length ? segs : ['manufacturing'];
  const smeMax = Math.max(...list.map((s) => SEGMENT_THRESHOLDS[s].sme));
  const smallMax = Math.max(...list.map((s) => SEGMENT_THRESHOLDS[s].small));
  if (emp <= smallMax) return 'small';
  if (emp <= smeMax) return 'sme';
  return 'large';
}

// 補助金テキストから対象規模を検出する正規表現。
const RE_SMALL = /小規模(事業者|企業者|企業|の事業者)/;
const RE_SME = /中小(企業|事業者|企業者|・小規模|零細)/;

/**
 * 補助金テキスト（title + description 等）から対象規模を分類する。
 *   - 'small': 小規模事業者に限定（小規模の記載あり・中小の記載なし）
 *   - 'sme'  : 中小企業まで対象（中小の記載あり、または中小＋小規模）
 *   - 'any'  : 規模の制限が読み取れない（大企業も可 or 記載なし）→ 絞らない
 * @param {string} text
 * @returns {'small'|'sme'|'any'}
 */
function classifySubsidyScale(text) {
  const t = typeof text === 'string' ? text.normalize('NFKC') : '';
  const hasSmall = RE_SMALL.test(t);
  const hasSme = RE_SME.test(t);
  if (hasSmall && !hasSme) return 'small';
  if (hasSme || hasSmall) return 'sme';
  return 'any';
}

/**
 * ユーザー規模クラスが補助金の対象規模を満たすか（緩めマッチ）。
 *   eligibleScale 'any'/null は常に通す。userScale null（従業員数未入力）も通す。
 * @param {'small'|'sme'|'large'|null} userScale
 * @param {'small'|'sme'|'any'|null} eligibleScale
 * @returns {boolean}
 */
function userScaleMeetsSubsidy(userScale, eligibleScale) {
  if (!eligibleScale || eligibleScale === 'any') return true;
  if (userScale == null) return true; // 従業員数未入力 → 規模で絞らない
  if (eligibleScale === 'small') return userScale === 'small';
  if (eligibleScale === 'sme') return userScale !== 'large';
  return true;
}

module.exports = {
  SEGMENT_THRESHOLDS,
  CATEGORY_TO_SEGMENT,
  classifyUserScale,
  classifySubsidyScale,
  userScaleMeetsSubsidy,
};
