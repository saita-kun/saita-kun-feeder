/**
 * MATCH-REQ-V1 充足判定（純関数）。
 *
 * `user_requirements`（LIFF / Tally 登録のユーザー要件）と
 * `subsidy_prefecture_info`（補助金公募）の 1 組が「マッチするか」を判定する。
 *
 * 設計の正: saita-kun/docs/design/matching-requirements-v1.md §F3。
 * 本モジュールは pages/api/deliver.js から呼ばれる配信判定の中核で、
 * I/O を持たない純関数として切り出してユニットテスト可能にしている。
 *
 * NULL=制約なし / 部分一致=いずれか一致 の原則。
 */

const { toEnglish } = require('./prefecture-mapper');
const { classifyUserScale, userScaleMeetsSubsidy } = require('./eligible-scale');

// user_requirements.categories / purposes は短名で格納される（pages/register.js の value）。
// subsidy 側は category_<短名> / purpose_<短名> の 0/1 列。
const CATEGORY_KEYS = [
  'new_technology', 'it', 'entertainment', 'professional', 'agriculture',
  'construction', 'wholesale', 'finance', 'realestate', 'hospitality',
  'medical', 'other',
];
const PURPOSE_KEYS = [
  'capex', 'it_intro', 'rd', 'hr', 'market', 'startup', 'succession',
];

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * 市区町村名を比較用に正規化する（NFKC + 空白除去）。
 * subsidy 側 municipality は抽出値で表記ゆれ・前後に語が付く場合があるため、
 * 呼び出し側で部分一致（包含）判定する前提の軽量正規化にとどめる。
 */
function normalizeMunicipality(s) {
  if (typeof s !== 'string') return '';
  return s.normalize('NFKC').replace(/[\s　​]+/gu, '');
}

/**
 * maximum_amount が「金額不明」か判定する。
 * extractor は情報なし時に sentinel '1' を入れる規約（design §10）。NULL も不明扱い。
 * 不明な場合、金額軸は「含める（スキップ）」方針（DRI 判断 2026-06-28）。
 */
function isAmountUnknown(maxAmount) {
  if (maxAmount === null || maxAmount === undefined || maxAmount === '') return true;
  const n = Number(maxAmount);
  return !Number.isFinite(n) || n <= 1;
}

/**
 * application_deadline（ISO 'YYYY-MM-DD' 文字列）を Date(UTC 00:00) に変換する。
 * sentinel 'No information' / NULL / 非 ISO は null を返す（= 締切不明）。
 */
function parseDeadline(deadline) {
  if (typeof deadline !== 'string') return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(deadline)) return null;
  const d = new Date(`${deadline}T00:00:00Z`);
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * 補助金が「現在 open」か（締切が today 以降）。
 * 締切不明（NULL / sentinel）は保守的に open 対象外（design §F2.1/F2.2）。
 * @param {object} subsidy
 * @param {Date} [today] 比較基準日（既定: 現在）。テスト時に固定可能。
 */
function isOpen(subsidy, today = new Date()) {
  const d = parseDeadline(subsidy.application_deadline);
  if (!d) return false;
  // today を UTC 日付境界に丸めて「締切当日も open」とする
  const todayUtc = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate());
  return d.getTime() >= todayUtc;
}

/**
 * 地域: subsidy.prefectures は romaji TEXT[] + 'zenkoku' sentinel。
 * 全国対象は includeNationwide=TRUE のユーザーにマッチ。
 * The zenkoku sentinel is guaranteed by the save-to-db write invariant: gov_level='national' <=> ['zenkoku'].
 * 都道府県が明示列挙されていれば includeNationwide によらずマッチ（design の literal より広い superset）。
 */
function matchesPrefecture(subsidy, prefecturesRomaji, includeNationwide) {
  if (!Array.isArray(prefecturesRomaji) || prefecturesRomaji.length === 0) return true;
  const prefs = Array.isArray(subsidy.prefectures) ? subsidy.prefectures : [];
  return prefecturesRomaji.some((p) => prefs.includes(p)) ||
    (prefs.includes('zenkoku') && includeNationwide !== false);
}

/**
 * 市区町村（緩めマッチ）: subsidy が市区町村レベル（municipality 非空）で、
 * かつユーザーが市区町村を設定している場合のみ、両者が一致する時だけ通す。
 * 一致は「どちらかがもう一方を包含」で判定（subsidy 側は抽出値で表記ゆれ・
 * 余分な語が付くため。例: '岸和田市内の「都市拠点」' ⊇ '岸和田市'）。
 * ユーザー未設定（company_municipality=NULL/空）なら市区町村では絞らず、
 * 都道府県一致で従来通り通す（緩め: 一致優先・未設定は県内も可）。
 */
function matchesMunicipality(subsidy, userMunicipality) {
  const subMuni = normalizeMunicipality(subsidy.municipality);
  const userMuni = normalizeMunicipality(userMunicipality);
  if (subsidy.gov_level === 'municipal' && !subMuni) return false;
  if (subMuni && userMuni) {
    return subMuni.includes(userMuni) || userMuni.includes(subMuni);
  }
  return true;
}

/**
 * 地域・市区町村以外の MATCH-REQ-V1 判定。
 * NULL=制約なし / 部分一致=いずれか一致 の原則。
 */
function matchesNonRegionCriteria(subsidy, criteria, opts = {}) {
  const today = opts.today || new Date();

  // 2. 業種: ユーザー選択業種のいずれかが subsidy.category_<c>=1。空 = 制約なし。
  const categories = Array.isArray(criteria.categories) ? criteria.categories : [];
  if (categories.length > 0) {
    const categoryMatch = categories.some(
      (c) => Number(subsidy[`category_${c}`]) === 1
    );
    if (!categoryMatch) return false;
  }

  // 3. 用途: ユーザー選択用途のいずれかが subsidy.purpose_<p>=1。空 = 制約なし。
  const purposes = Array.isArray(criteria.purposes) ? criteria.purposes : [];
  if (purposes.length > 0) {
    const purposeMatch = purposes.some(
      (p) => Number(subsidy[`purpose_${p}`]) === 1
    );
    if (!purposeMatch) return false;
  }

  // 4. 金額: 補助上限がユーザー希望レンジ内。maximum_amount 不明時は金額軸スキップ（含める）。
  if (!isAmountUnknown(subsidy.maximum_amount)) {
    const maxAmount = Number(subsidy.maximum_amount);
    if (criteria.amount_min != null && maxAmount < Number(criteria.amount_min)) return false;
    if (criteria.amount_max != null && maxAmount > Number(criteria.amount_max)) return false;
  }

  // 5. 任意フィルタ: 締切余裕日数
  if (criteria.deadline_buffer_days) {
    const d = parseDeadline(subsidy.application_deadline);
    if (!d) return false;
    const todayUtc = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate());
    const daysLeft = Math.floor((d.getTime() - todayUtc) / DAY_MS);
    if (daysLeft < Number(criteria.deadline_buffer_days)) return false;
  }

  // 6. 任意フィルタ: 補助率下限（subsidy_rate は数値化できる場合のみ評価。不可なら保守的に除外）
  if (criteria.subsidy_rate_min) {
    const rate = Number(subsidy.subsidy_rate);
    if (!Number.isFinite(rate) || rate < Number(criteria.subsidy_rate_min)) return false;
  }

  // 7. 事業者規模: ユーザーの従業員数＋業種から中小企業基本法の規模クラスを判定し、
  //    補助金の対象規模（eligible_scale）を満たすか。従業員数未入力 / eligible_scale が
  //    'any'・NULL の場合は絞らない（緩め）。
  const userScale = classifyUserScale(criteria.employee_count, criteria.categories);
  if (!userScaleMeetsSubsidy(userScale, subsidy.eligible_scale)) return false;

  // 法人格は subsidy 側に構造化列が無いため v1 では未評価（design §F3 既知の限界）。

  return true;
}

/**
 * ユーザー要件と補助金 1 件がマッチするか判定する（design §F3）。
 *
 * @param {object} subsidy subsidy_prefecture_info の行
 * @param {object} user    user_requirements の行
 * @param {object} [opts]
 * @param {Date}   [opts.today] 締切余裕日数の基準日（既定: 現在）
 * @param {boolean} [opts.isPaid=true] 有料ユーザーなら全フィルタ、無料 tier は
 *   地域 + gov_level + 規模（fail 確定除外）。docs/design/line-delivery-verdict.md §3（2026-07-07 改訂）。
 * @returns {boolean}
 */
function isSubsidyMatchingUser(subsidy, user, opts = {}) {
  const today = opts.today || new Date();
  const isPaid = opts.isPaid !== false;
  const userPref = toEnglish(user.company_prefecture);
  const includeNationwide = user.include_nationwide !== false; // 既定 TRUE

  if (!matchesPrefecture(subsidy, [userPref], includeNationwide)) return false;
  if (!isPaid) {
    return (
      (subsidy.gov_level === 'national' || subsidy.gov_level === 'prefecture') &&
      userScaleMeetsSubsidy(
        classifyUserScale(user.employee_count, user.categories),
        subsidy.eligible_scale
      )
    );
  }
  if (!matchesMunicipality(subsidy, user.company_municipality)) return false;

  return matchesNonRegionCriteria(subsidy, {
    categories: user.categories,
    purposes: user.purposes,
    amount_min: user.amount_min,
    amount_max: user.amount_max,
    deadline_buffer_days: user.deadline_buffer_days,
    subsidy_rate_min: user.subsidy_rate_min,
    employee_count: user.employee_count,
  }, { today });
}

module.exports = {
  CATEGORY_KEYS,
  PURPOSE_KEYS,
  isAmountUnknown,
  parseDeadline,
  isOpen,
  isSubsidyMatchingUser,
  matchesPrefecture,
  matchesMunicipality,
  matchesNonRegionCriteria,
  normalizeMunicipality,
};
