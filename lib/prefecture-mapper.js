// Japanese prefecture name to English (romaji) mapping
const prefectureMapping = {
  "北海道": "hokkaido", "青森県": "aomori", "岩手県": "iwate", "宮城県": "miyagi",
  "秋田県": "akita", "山形県": "yamagata", "福島県": "fukushima", "茨城県": "ibaraki",
  "栃木県": "tochigi", "群馬県": "gunma", "埼玉県": "saitama", "千葉県": "chiba",
  "東京都": "tokyo", "神奈川県": "kanagawa", "新潟県": "niigata", "富山県": "toyama",
  "石川県": "ishikawa", "福井県": "fukui", "山梨県": "yamanashi", "長野県": "nagano",
  "岐阜県": "gifu", "静岡県": "shizuoka", "愛知県": "aichi", "三重県": "mie",
  "滋賀県": "shiga", "京都府": "kyoto", "大阪府": "osaka", "兵庫県": "hyogo",
  "奈良県": "nara", "和歌山県": "wakayama", "鳥取県": "tottori", "島根県": "shimane",
  "岡山県": "okayama", "広島県": "hiroshima", "山口県": "yamaguchi", "徳島県": "tokushima",
  "香川県": "kagawa", "愛媛県": "ehime", "高知県": "kochi", "福岡県": "fukuoka",
  "佐賀県": "saga", "長崎県": "nagasaki", "熊本県": "kumamoto", "大分県": "oita",
  "宮崎県": "miyazaki", "鹿児島県": "kagoshima", "沖縄県": "okinawa", "全国": "zenkoku"
};

// Reverse mapping: English to Japanese
const reversePrefectureMapping = Object.fromEntries(
  Object.entries(prefectureMapping).map(([k, v]) => [v, k])
);

// Regex to match any Japanese prefecture name in text
const prefectureRegex = new RegExp(
  '(' + Object.keys(prefectureMapping).join('|') + ')', 'g'
);

/**
 * Extract prefecture names from text and return English names
 */
function extractPrefecturesFromText(text) {
  const matches = text.match(prefectureRegex) || [];
  const unique = [...new Set(matches)];
  return unique.map(p => prefectureMapping[p] || p);
}

/**
 * Convert a Japanese prefecture name to English
 */
function toEnglish(jaName) {
  return prefectureMapping[jaName] || jaName;
}

/**
 * Convert an English (romaji) prefecture name back to Japanese for display.
 * Unknown values (e.g. already-Japanese strings) are returned unchanged.
 */
function toJapanese(enName) {
  return reversePrefectureMapping[enName] || enName;
}

/**
 * Convert jGrants target_area_search value to English prefecture array
 * e.g. "福岡県" -> ["fukuoka"], "全国" -> ["zenkoku"]
 */
function fromJgrantsArea(areaSearch) {
  if (!areaSearch) return [];
  // May contain multiple prefectures separated by comma or space
  const matches = areaSearch.match(prefectureRegex) || [];
  if (matches.length === 0 && areaSearch.includes('全国')) return ['zenkoku'];
  return [...new Set(matches.map(p => prefectureMapping[p] || p))];
}

module.exports = {
  prefectureMapping,
  reversePrefectureMapping,
  prefectureRegex,
  extractPrefecturesFromText,
  toEnglish,
  toJapanese,
  fromJgrantsArea
};
