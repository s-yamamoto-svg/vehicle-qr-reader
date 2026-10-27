/* 車検証QR読み取り(ロングラン補償申込フォーム組み込み用) v1.1.0
   国土交通省「二次元コード項目定義」(2023.1版)に基づき、二次元コード2・3を結合して項目に分解します。
   読み取りは端末のブラウザ内だけで行い、画像や結果を外部へ送信しません。 */
(function () {
// DOMに依存しない処理(連結・順序判定・項目分解)。単体テストできるよう分離しています。
"use strict";

const DELIM = "/";

// 検出したQR1個を識別するキー(同じQRの重複検出の除去、表示の対応付けに使う)
function symKey(s) {
  return [s.sequenceSize, s.sequenceIndex, s.sequenceId, Array.from(s.bytes).join(",")].join("|");
}

function concatBytes(list) {
  let n = 0;
  for (const b of list) n += b.length;
  const out = new Uint8Array(n);
  let o = 0;
  for (const b of list) { out.set(b, o); o += b.length; }
  return out;
}

// 連結後のバイト列を文字列化。UTF-8として厳密に解釈できなければShift_JIS(CP932)。
// ※ 分割コードの境目で全角文字が割れる可能性があるため、必ず「結合してから」デコードする。
function decodeBytes(bytes) {
  try { return new TextDecoder("utf-8", { fatal: true }).decode(bytes); } catch (e) { /* fallthrough */ }
  return new TextDecoder("shift_jis").decode(bytes);
}

// ---- コード表(仕様書の設定例より) ----
const PLATE_BASE = [
  "小板・2枚・ペイント", "大板・2枚・ペイント", "小板・1枚・ペイント", "大板・1枚・ペイント",
  "小板・2枚・字光", "大板・2枚・字光", "小板・1枚・字光", "大板・1枚・字光"
];
function plateLabel(c) {
  if (c === "-") return "番号指示キー無し又は転入抹消番号";
  const li = "ABCDEFGH".indexOf(c);
  if (li >= 0) return PLATE_BASE[li] + "・希望番号";
  const di = "12345678".indexOf(c);
  if (di >= 0) return PLATE_BASE[di] + "・希望番号以外";
  return "";
}
const NOISE = { "10": "平成10年規制", "11": "平成11年規制", "12": "平成12年規制", "13": "平成13年規制",
                "26": "平成26年規制", "28": "平成28年規制", "-": "騒音規制対象外" };
const DRIVE = { "1": "全輪駆動車", "2": "全輪駆動車以外", "0": "設定値無し", "-": "一般車" };
const OPA   = { "1": "オパシメータ測定対象車", "0": "測定対象外車" };
const NOXMODE = { "A": "排出ガス測定モードあり", "-": "設定されない" };
const FUEL = { "01": "ガソリン", "02": "軽油", "03": "LPG", "04": "灯油", "05": "電気", "06": "ガソリン・LPG",
  "07": "ガソリン・灯油", "08": "メタノール", "09": "CNG", "11": "LNG", "12": "ANG", "13": "圧縮水素",
  "14": "ガソリン・電気", "15": "LPG・電気", "16": "軽油・電気", "99": "その他", "00": "－" };

function modelNote(s) {
  if (s === "*SHISAKU") return "試作(型式の値なし)";
  if (s === "*KUMITATE") return "組立";
  if (s === "*FUMEI") return "型式IDコードが不明";
  if (/\*K$/.test(s)) return "改造車";
  if (/\*S$/.test(s)) return "試作";
  return "";
}

// ---- 二次元コード2(別紙1) ----
// 実データで確認: 全項目が「/」で区切られて並ぶ(バージョンの直後も、固定長項目の間も「/」)。
//   例) 2/練馬△△３２９そ２５１０/-/GT7-059483/FB20/2
// [0]バージョン [1]自動車登録番号(全角12) [2]標板区分 [3]車台番号 [4]原動機型式 [5]帳票種別
function parseCode2(s) {
  const errors = [];
  const t = s.split(DELIM);
  if (t.length !== 6) errors.push("項目数が想定(6)と異なります(" + t.length + "項目)");
  const g = i => (t[i] === undefined ? "" : t[i]);
  const f = { version: g(0), reg: g(1), plate: g(2), chassis: g(3), engine: g(4), formType: g(5) };

  if (!/^\d$/.test(f.version)) errors.push("バージョン情報が数字ではありません");
  if (f.reg.length !== 12) errors.push("自動車登録番号が12文字ではありません(" + f.reg.length + "文字)");
  if (!/^[A-H1-8-]$/.test(f.plate)) errors.push("標板区分のコードが想定外です");
  if (!/^[\x21-\x7e]{1,23}$/.test(f.chassis)) errors.push("車台番号が半角1〜23文字ではありません");
  if (!/^[\x21-\x7e]{0,24}$/.test(f.engine)) errors.push("原動機型式が半角24文字以内ではありません");
  if (!/^\d$/.test(f.formType)) errors.push("帳票種別が数字ではありません");
  return { fields: f, errors };
}

// ---- 二次元コード3(別紙2) ----
//   例) 2/-▲▲/184361001/000000/1801/DBA-GT7/0083/-▲▲▲/-▲▲▲/0054/28/-▲▲/1/0/I/0001/-▲▲▲▲/171207/01
// [0]バージョン [1]車台番号打刻位置 [2]型式指定番号・類別区分番号 [3]有効期間の満了する日(6)
// [4]初度登録年月(4) [5]型式 [6〜9]軸重(前前・前後・後前・後後) [10]騒音規制 [11]近接排気騒音規制値
// [12]駆動方式 [13]オパシメータ測定車 [14]NOx・PM測定モード [15]NOx値 [16]PM値
// [17]保安基準適用年月日(6) [18]燃料の種類コード
function parseCode3(s) {
  const errors = [];
  const t = s.split(DELIM);
  if (t.length !== 19) errors.push("項目数が想定(19)と異なります(" + t.length + "項目)");
  const g = i => (t[i] === undefined ? "" : t[i]);
  const f = {
    version: g(0), stamp: g(1), typeNo: g(2), expiry: g(3), firstReg: g(4), model: g(5),
    axle: [g(6), g(7), g(8), g(9)], noise: g(10), nearNoise: g(11), drive: g(12), opa: g(13),
    noxMode: g(14), nox: g(15), pm: g(16), standardDate: g(17), fuel: g(18)
  };
  const b = v => v.trim(); // 空白埋め(半角)は除いて形式チェック

  if (!/^\d$/.test(f.version)) errors.push("バージョン情報が数字ではありません");
  if (!/^(\d{3}|-)$/.test(b(f.stamp))) errors.push("車台番号打刻位置の形式が想定外です");
  if (!/^\d{0,10}$/.test(f.typeNo)) errors.push("型式指定番号・類別区分番号が数字10桁以内ではありません");
  if (!/^\d{6}$/.test(f.expiry)) errors.push("有効期間の満了する日が数字6桁ではありません");
  if (!/^\d{4}$/.test(f.firstReg)) errors.push("初度登録年月が数字4桁ではありません");
  if (!/^[\x21-\x7e]{0,17}$/.test(f.model)) errors.push("型式が半角17文字以内ではありません");
  f.axle.forEach((a, i) => { if (!/^(\d{4}|-)$/.test(b(a))) errors.push("軸重(" + ["前前","前後","後前","後後"][i] + ")の形式が想定外です"); });
  if (!/^(\d{2}|-)$/.test(b(f.noise))) errors.push("騒音規制の形式が想定外です");
  if (!/^(\d{3}|-)$/.test(b(f.nearNoise))) errors.push("近接排気騒音規制値の形式が想定外です");
  if (!/^[0-2-]$/.test(f.drive)) errors.push("駆動方式のコードが想定外です");
  if (!/^[01]$/.test(f.opa)) errors.push("オパシメータ測定車のコードが想定外です");
  if (!/^[A-Z-]$/.test(f.noxMode)) errors.push("NOx・PM測定モードのコードが想定外です");
  if (!/^(\d{4}|-)$/.test(b(f.nox))) errors.push("NOx値の形式が想定外です");
  if (!/^(\d{5}|-)$/.test(b(f.pm))) errors.push("PM値の形式が想定外です");
  if (!/^\d{6}$/.test(f.standardDate)) errors.push("保安基準適用年月日が数字6桁ではありません");
  if (!/^\d{2}$/.test(f.fuel)) errors.push("燃料の種類コードが数字2桁ではありません");
  return { fields: f, errors };
}

// ---- 軽自動車(軽自動車検査協会の仕様。普通車とは別仕様で、各コードは分割なしの1個のQR) ----
// コード2: K/22/車両番号(全角12)/標板の枚数・大きさ/車台番号/原動機型式/帳票種別
// コード3: K/32/車台番号打刻位置/型式指定番号・類別区分番号/有効期間満了日(6)/初度検査年月(4,西暦下2桁+月)/型式/
//          軸重×4/騒音規制/近接排気騒音規制値/駆動方式/オパシメータ測定車/NOx・PM測定モード/NOx値/PM値/燃料の種類コード/予備項目(6)
function parseKeiCode2(s) {
  const errors = [];
  const t = s.split(DELIM);
  if (t.length !== 7) errors.push("項目数が想定(7)と異なります(" + t.length + "項目)");
  const g = i => (t[i] === undefined ? "" : t[i]);
  const f = { version: g(0) + g(1), reg: g(2), plate: g(3), chassis: g(4), engine: g(5), formType: g(6), kei: true };
  if (g(0) !== "K" || g(1) !== "22") errors.push("システムID・バージョン(K/22)が想定と異なります");
  if (f.reg.length !== 12) errors.push("車両番号が12文字ではありません(" + f.reg.length + "文字)");
  if (!/^[A-H1-8-]$/.test(f.plate)) errors.push("標板の枚数・大きさのコードが想定外です");
  if (!/^[\x20-\x7e\[\]]{1,24}$/.test(f.chassis)) errors.push("車台番号が半角1〜24文字ではありません");
  if (!/^[\x20-\x7e]{0,26}$/.test(f.engine)) errors.push("原動機型式が半角26文字以内ではありません");
  if (!/^[1-4]$/.test(f.formType)) errors.push("帳票種別が想定外です");
  return { fields: f, errors };
}

function parseKeiCode3(s) {
  const errors = [];
  const t = s.split(DELIM);
  if (t.length !== 20) errors.push("項目数が想定(20)と異なります(" + t.length + "項目)");
  const g = i => (t[i] === undefined ? "" : t[i]);
  const f = {
    version: g(0) + g(1), stamp: g(2), typeNo: g(3), expiry: g(4), firstReg: g(5), model: g(6),
    axle: [g(7), g(8), g(9), g(10)], noise: g(11), nearNoise: g(12), drive: g(13), opa: g(14),
    noxMode: g(15), nox: g(16), pm: g(17), standardDate: "", fuel: g(18), reserve: g(19), kei: true
  };
  const b = v => v.trim();
  if (g(0) !== "K" || g(1) !== "32") errors.push("システムID・バージョン(K/32)が想定と異なります");
  if (!/^(\d{3}|-)$/.test(b(f.stamp))) errors.push("車台番号打刻位置の形式が想定外です");
  if (!/^\d{0,10}$/.test(f.typeNo)) errors.push("型式指定番号・類別区分番号が数字10桁以内ではありません");
  if (!/^\d{6}$/.test(f.expiry)) errors.push("有効期間満了日が数字6桁ではありません");
  if (!/^\d{4}$/.test(f.firstReg)) errors.push("初度検査年月が数字4桁ではありません");
  if (!/^[\x20-\x7e]{0,22}$/.test(f.model)) errors.push("型式が半角22文字以内ではありません");
  f.axle.forEach((a, i) => { if (!/^(\d{4}|-)$/.test(b(a))) errors.push("軸重(" + ["前前","前後","後前","後後"][i] + ")の形式が想定外です"); });
  if (!/^(\d{2}|-)$/.test(b(f.noise))) errors.push("騒音規制の形式が想定外です");
  if (!/^(\d{3}|-)$/.test(b(f.nearNoise))) errors.push("近接排気騒音規制値の形式が想定外です");
  if (!/^(\d{2}|-{1,2})$/.test(b(f.fuel))) errors.push("燃料の種類コードが想定外です");
  return { fields: f, errors };
}

// ---- 連結・順序判定 ----
// symbols: [{bytes, sequenceIndex, sequenceSize, sequenceId}]
// 1) QR標準の連結ヘッダ(Structured Append)があればそれで並べる(分割数2→コード2、3→コード3)
// 2) 連結ヘッダが無い場合は、仕様書の項目定義に合致する並びを総当たりで探す
function permutations(arr, k) {
  const out = [];
  const rec = (cur, rest) => {
    if (cur.length === k) { out.push(cur); return; }
    rest.forEach((x, i) => rec(cur.concat(x), rest.filter((_, j) => j !== i)));
  };
  rec([], arr);
  return out;
}

function mergeSymbols(input) {
  const notes = [];
  const result = { code2: null, code3: null, notes, usedIdx: new Set() };

  // 同一内容の重複検出を除去
  const seen = new Set();
  const symbols = [];
  const origIdx = [];
  input.forEach((s, i) => {
    const key = symKey(s);
    if (seen.has(key)) return;
    seen.add(key);
    symbols.push(s);
    origIdx.push(i);
  });

  const make = (idxList, method, kei) => {
    const bytes = concatBytes(idxList.map(i => symbols[i].bytes));
    return { bytes, text: decodeBytes(bytes), method, order: idxList.map(i => origIdx[i]), kei: !!kei };
  };

  const groups = new Map();
  const singles = [];
  symbols.forEach((s, i) => {
    if (s.sequenceSize > 1) {
      const k = s.sequenceSize + "|" + s.sequenceId;
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k).push(i);
    } else {
      singles.push(i);
    }
  });

  const used = new Set();
  for (const [, idxs] of groups) {
    const size = symbols[idxs[0]].sequenceSize;
    const bySeq = new Map();
    idxs.forEach(i => bySeq.set(symbols[i].sequenceIndex, i));
    const ordered = [];
    for (let n = 0; n < size; n++) if (bySeq.has(n)) ordered.push(bySeq.get(n));
    if (ordered.length !== size) {
      notes.push("連結コード(" + size + "分割)のうち " + ordered.length + " 個しか検出できていません。画質・大きさを確認してください。");
      continue;
    }
    const key = size === 2 ? "code2" : size === 3 ? "code3" : null;
    if (!key) { notes.push("想定外の分割数(" + size + ")の連結コードを検出しました。"); continue; }
    if (result[key]) { notes.push("二次元コード" + size + "と思われる連結コードが複数あります。最初のものを使用します。"); continue; }
    result[key] = make(ordered, "連結ヘッダ");
    ordered.forEach(i => used.add(i));
  }

  // 軽自動車: 各コードは分割なしの1個。先頭の「K/22/」「K/32/」で判別する
  singles.forEach(i => {
    const txt = decodeBytes(symbols[i].bytes);
    const key = txt.startsWith("K/22/") ? "code2" : txt.startsWith("K/32/") ? "code3" : null;
    if (!key) return;
    if (result[key]) { notes.push("軽自動車の" + (key === "code2" ? "コード2" : "コード3") + "が複数あります。最初のものを使用します。"); return; }
    result[key] = make([i], "軽自動車(分割なし)", true);
    used.add(i);
  });

  // 連結ヘッダが無いコードは、項目定義との照合で順序を推定
  const pool = singles.filter(i => !used.has(i));
  const need2 = !result.code2, need3 = !result.code3;
  if ((need2 || need3) && pool.length > 0 && pool.length <= 8) {
    const valid = (list, parser) => permutations(pool, list).filter(p =>
      parser(decodeBytes(concatBytes(p.map(i => symbols[i].bytes)))).errors.length === 0);
    const c2 = need2 ? valid(2, parseCode2) : [];
    const c3 = need3 ? valid(3, parseCode3) : [];
    const opts2 = c2.length ? c2 : [null];
    const opts3 = c3.length ? c3 : [null];
    let pick = null, count = 0;
    for (const a of opts2) for (const b of opts3) {
      if (a && b && a.some(i => b.includes(i))) continue;
      if (!a && !b) continue;
      count++;
      if (!pick) pick = [a, b];
    }
    if (pick) {
      if (pick[0]) { result.code2 = make(pick[0], "項目定義との照合で順序を推定"); pick[0].forEach(i => used.add(i)); }
      if (pick[1]) { result.code3 = make(pick[1], "項目定義との照合で順序を推定"); pick[1].forEach(i => used.add(i)); }
      if (count > 1) notes.push("順序の候補が複数あり、最初の候補を採用しました。生データと実物を見比べて確認してください。");
    } else if (pool.length) {
      notes.push("連結情報のないコードが " + pool.length + " 個あり、仕様書の並びに一致する組み合わせを見つけられませんでした。");
    }
  }

  used.forEach(i => result.usedIdx.add(origIdx[i]));
  const unused = symbols.length - used.size;
  if (unused > 0 && (result.code2 || result.code3)) notes.push("使用しなかったQRコードが " + unused + " 個あります(車検証以外のコードの可能性)。");

  if (result.code2) result.code2.parsed = (result.code2.kei ? parseKeiCode2 : parseCode2)(result.code2.text);
  if (result.code3) result.code3.parsed = (result.code3.kei ? parseKeiCode3 : parseCode3)(result.code3.text);
  return result;
}

// ---- 値の整形 ----
const nfkc = s => s.normalize("NFKC").replace(/[\s　]+/g, " ").trim();

function wareki(y, m, d) {
  const t = y * 10000 + m * 100 + (d || 1);
  let era, n;
  if (t >= 20190501) { era = "令和"; n = y - 2018; }
  else if (t >= 19890108) { era = "平成"; n = y - 1988; }
  else if (t >= 19261225) { era = "昭和"; n = y - 1925; }
  else return "";
  return era + (n === 1 ? "元" : n) + "年" + m + "月" + (d ? d + "日" : "");
}

function fullYear(yy, nowYear) {
  let y = 2000 + yy;
  if (y > nowYear + 5) y -= 100;
  return y;
}

// YYMMDD / YYMM → {value, hint}
function dateField(raw, withDay, unsetHint, nowYear) {
  const unset = withDay ? "999999" : "9999";
  if (raw === unset) return { value: "", hint: unsetHint };
  if (/^0+$/.test(raw)) return { value: "", hint: unsetHint + "(値 " + raw + ")" };
  const re = withDay ? /^(\d{2})(\d{2})(\d{2})$/ : /^(\d{2})(\d{2})$/;
  const m = raw.match(re);
  if (!m) return { value: raw.trim(), hint: "形式を解釈できませんでした" };
  const y = fullYear(Number(m[1]), nowYear), mo = Number(m[2]), d = withDay ? Number(m[3]) : 0;
  if (mo < 1 || mo > 12 || (withDay && (d < 1 || d > 31))) return { value: raw, hint: "日付として不正な値です" };
  const pad = n => String(n).padStart(2, "0");
  return {
    value: y + "-" + pad(mo) + (withDay ? "-" + pad(d) : ""),
    hint: wareki(y, mo, d)
  };
}

const isBlankCode = s => /^-\s*$/.test(s);

// 画面に出す項目リストを作る。value=フォームに転記する値, hint=補足
function buildFields(r, nowYear) {
  nowYear = nowYear || new Date().getFullYear();
  const groups = [];

  const g2 = { title: "二次元コード2(登録番号・車台番号・原動機型式)", items: [] };
  if (r.code2) {
    const f = r.code2.parsed.fields;
    const office = nfkc(f.reg.slice(0, 4)), cls = nfkc(f.reg.slice(4, 7)),
          kana = nfkc(f.reg.slice(7, 8)), serial = nfkc(f.reg.slice(8, 12));
    const sh = f.chassis.match(/^\[(.{2})\]/);
    g2.items.push(
      { key: "reg_full", label: "自動車登録番号", value: [office, cls, kana, serial].filter(Boolean).join(" "), hint: "" },
      { key: "reg_office", label: "登録番号:標板文字(運輸支局等)", value: office },
      { key: "reg_class", label: "登録番号:分類番号", value: cls },
      { key: "reg_kana", label: "登録番号:かな", value: kana },
      { key: "reg_serial", label: "登録番号:一連番号", value: serial },
      { key: "plate", label: "標板区分コード", value: f.plate, hint: plateLabel(f.plate) },
      { key: "chassis", label: "車台番号", value: f.chassis, hint: sh ? "職権打刻(職権打刻コード " + sh[1] + ")" : "" },
      { key: "engine", label: "原動機型式", value: f.engine, hint: modelNote(f.engine) },
      { key: "form_type", label: "帳票種別", value: f.formType }
    );
  }
  groups.push(g2);

  const g3 = { title: "二次元コード3(型式・初度登録・諸元)", items: [] };
  if (r.code3) {
    const f = r.code3.parsed.fields;
    const exp = dateField(f.expiry, true, "未設定/不明(電子車検証の券面では固定値)", nowYear);
    const reg = dateField(f.firstReg, false, "未設定", nowYear);
    const std = dateField(f.standardDate, true, "未設定", nowYear);
    const axleNames = ["前前", "前後", "後前", "後後"];
    const axleItems = f.axle.map((a, i) => ({
      key: "axle_" + i, label: "軸重(" + axleNames[i] + ")", unit: "kg",
      value: isBlankCode(a) ? "" : String(Number(a) * 10),
      hint: isBlankCode(a) ? "ゼロ(設定なし)" : "コード値 " + a + " × 10kg"
    }));
    const code = (v, map) => ({ value: v.trim(), hint: map[v.trim()] || (v.trim() ? "コード表にない値" : "") });
    const num = v => (isBlankCode(v) ? "" : v.trim());
    g3.items.push(
      { key: "stamp", label: "車台番号打刻位置", value: isBlankCode(f.stamp) ? "" : f.stamp, hint: isBlankCode(f.stamp) ? "コードなし" : "" },
      { key: "type_no", label: "型式指定番号・類別区分番号", value: f.typeNo, hint: f.typeNo ? "" : "設定なし(一般車)" },
      ...(f.typeNo.length === 9 ? [
        { key: "type_designation", label: "型式指定番号(先頭5桁)", value: f.typeNo.slice(0, 5), hint: "結合値を5桁+4桁に分割(参考)" },
        { key: "category_no", label: "類別区分番号(後ろ4桁)", value: f.typeNo.slice(5), hint: "結合値を5桁+4桁に分割(参考)" }
      ] : []),
      { key: "expiry", label: "有効期間の満了する日", value: exp.value, hint: exp.hint },
      { key: "first_reg", label: "初度登録年月", value: reg.value, hint: reg.hint },
      { key: "model", label: "型式", value: f.model, hint: modelNote(f.model) },
      ...axleItems,
      Object.assign({ key: "noise", label: "騒音規制" }, code(f.noise, NOISE)),
      { key: "near_noise", label: "近接排気騒音規制値", value: num(f.nearNoise), hint: isBlankCode(f.nearNoise) ? "値なし" : "" },
      Object.assign({ key: "drive", label: "駆動方式" }, code(f.drive, DRIVE)),
      Object.assign({ key: "opa", label: "オパシメータ測定車" }, code(f.opa, OPA)),
      { key: "nox_mode", label: "NOx・PM測定モード", value: f.noxMode.trim(),
        hint: /^[A-Z]$/.test(f.noxMode) ? "排出ガス測定モードあり" : (f.noxMode === "-" ? "設定されない" : "") },
      { key: "nox", label: "NOx値", value: num(f.nox), hint: isBlankCode(f.nox) ? "値なし" : "" },
      { key: "pm", label: "PM値", value: num(f.pm), hint: isBlankCode(f.pm) ? "値なし" : "" },
      ...(f.kei ? [] : [{ key: "std_date", label: "保安基準適用年月日", value: std.value, hint: std.hint }]),
      Object.assign({ key: "fuel", label: "燃料の種類コード" }, code(f.fuel, FUEL))
    );
  }
  groups.push(g3);
  return groups;
}

const markBlanks = s => s.replace(/　/g, "△").replace(/ /g, "▲");

// 検出済みQRの進捗。連結ヘッダ付きは「何分割のうち何個」、無いものは個数だけ数える
function progressInfo(list) {
  const groups = new Map();
  let plain = 0;
  list.forEach(s => {
    if (s.sequenceSize > 1) {
      const k = s.sequenceSize + "|" + s.sequenceId;
      if (!groups.has(k)) groups.set(k, { size: s.sequenceSize, idx: new Set() });
      groups.get(k).idx.add(s.sequenceIndex);
    } else {
      plain++;
    }
  });
  return { groups: [...groups.values()].map(g => ({ size: g.size, have: g.idx.size })), plain };
}

// QRごとの表示ラベル(例: コード2-1)。key = symKey(symbol)
function labelMap(list, merged) {
  const m = new Map();
  [["コード2", merged.code2], ["コード3", merged.code3]].forEach(([name, c]) => {
    if (c) c.order.forEach((idx, n) => m.set(symKey(list[idx]), name + "-" + (n + 1)));
  });
  return m;
}

// ================= ロングラン補償申込フォーム組み込み用 =================
// index.php の「車検証のQRコードから入力」ボタンで読み取り画面を開き、結果を確認してから既存の入力欄へ転記する。
const VERSION = "1.1.0";
// このスクリプト自身の置き場所(vendor/ のファイルを同じ場所から読み込む)
const SCRIPT_BASE = (function () {
  try { return new URL(".", document.currentScript.src).href; } catch (e) { return ""; }
})();

// 転記先の入力欄(index.php の id)
const FIELD = { regno: "f_regno", chassis: "f_chassis", era: "f_era", year: "f_year", month: "f_month", hv: "f_hv", displacement: "f_displacement", carname: "f_carname", usage: "f_usage", cls: "f_class" };

const CSS = `
#sqModal{position:fixed;inset:0;z-index:9999;display:flex;justify-content:center;align-items:stretch;background:rgba(14,28,44,.74);font-family:"Yu Gothic UI","Meiryo",sans-serif;color:#26303a;line-height:1.6}
#sqModal[hidden]{display:none}
#sqModal [hidden]{display:none !important}
#sqModal *{box-sizing:border-box}
#sqModal .sq-sheet{width:100%;max-width:560px;height:100%;max-height:100vh;max-height:100dvh;display:flex;flex-direction:column;background:#f7f9fa}
@media(min-width:700px){#sqModal{align-items:center;padding:24px}#sqModal .sq-sheet{height:auto;max-height:calc(100vh - 48px);max-height:calc(100dvh - 48px);border-radius:10px;overflow:hidden;box-shadow:0 10px 30px rgba(0,0,0,.3)}}
#sqModal .sq-head{display:flex;align-items:center;justify-content:space-between;gap:12px;color:#fff;background:linear-gradient(135deg,#1B6BB5 0%,#124D82 100%);padding:6px 6px 6px 18px;padding-top:max(6px,env(safe-area-inset-top))}
#sqModal .sq-head h2{margin:0;font-size:16px;font-weight:600;color:#fff}
#sqModal .sq-x{width:48px;height:48px;padding:0;margin:0;border:0;border-radius:6px;background:transparent;color:#fff;font-size:28px;line-height:1;cursor:pointer;box-shadow:none;display:flex;align-items:center;justify-content:center}
#sqModal .sq-body{flex:1;overflow:auto;padding:14px 16px;-webkit-overflow-scrolling:touch}
#sqModal .sq-camwrap{position:relative;line-height:0;border-radius:8px;overflow:hidden;background:#000;margin:0 auto;width:min(100%,calc(46vh*var(--ar,1.78)));width:min(100%,calc(46dvh*var(--ar,1.78)))}
#sqModal .sq-camwrap video{display:block;width:100%;height:auto}
#sqModal .sq-camwrap canvas{position:absolute;inset:0;width:100%;height:100%;pointer-events:none}
#sqModal .sq-camtools{display:flex;gap:8px;align-items:center;margin-top:8px}
#sqModal .sq-zoom{display:flex;align-items:center;gap:8px;flex:1;margin:0;font-size:12px;font-weight:500;color:#5c6874}
#sqModal .sq-zoom input{flex:1;min-width:0;width:auto;padding:0;border:0;background:none;box-shadow:none}
#sqModal .sq-status{margin:12px 0 0;padding:10px 12px;border-radius:6px;font-size:13.5px;background:#e9eff5;color:#124D82;overflow-wrap:anywhere}
#sqModal .sq-status.ok{background:#e3f3e8;color:#1b6b38}
#sqModal .sq-status.warn{background:#fff8e6;color:#6b4e0a}
#sqModal .sq-status.err{background:#fdeaea;color:#8b1e1e}
#sqModal .sq-badges{display:flex;flex-wrap:wrap;gap:6px;margin-top:8px}
#sqModal .sq-badges:empty{display:none}
#sqModal .sq-badge{padding:3px 10px;border-radius:999px;font-size:12px;font-weight:700;background:#e9eff5;color:#124D82}
#sqModal .sq-badge.ok{background:#e3f3e8;color:#1b6b38}
#sqModal .sq-badge.warn{background:#fff3d6;color:#6b4e0a}
#sqModal .sq-badge.ng{background:#fdeaea;color:#8b1e1e}
#sqModal .sq-notes{margin:8px 0 0;padding-left:18px;font-size:12px;color:#6b4e0a}
#sqModal .sq-notes:empty{display:none}
#sqModal .sq-alt{display:grid;gap:8px;margin-top:12px}
#sqModal .sq-btn{display:flex;align-items:center;justify-content:center;min-height:48px;margin:0;padding:10px 14px;border:0;border-radius:6px;font:inherit;font-size:14px;font-weight:600;text-align:center;cursor:pointer;box-shadow:none;color:#124D82;background:#e3eaf2}
#sqModal .sq-btn.main{color:#fff;background:linear-gradient(135deg,#1B6BB5,#124D82)}
#sqModal .sq-btn.sm{width:auto;min-height:40px;font-size:13px;flex:none;padding:6px 14px}
#sqModal .sq-btn:disabled{opacity:.5;cursor:not-allowed}
#sqModal .sq-btn:focus-visible,#sqModal .sq-x:focus-visible,#sqModal summary:focus-visible{outline:3px solid #1B6BB5;outline-offset:2px}
#sqModal .sq-foot{display:grid;grid-template-columns:1fr 1.4fr;gap:10px;padding:10px 16px;padding-bottom:max(10px,env(safe-area-inset-bottom));background:#fff;border-top:1px solid #d5dce3}
#sqModal .sq-sr{position:absolute;width:1px;height:1px;margin:-1px;padding:0;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0}
#sqModal details{margin-top:12px}
#sqModal summary{cursor:pointer;font-size:13px;color:#124D82;padding:4px 0}
#sqModal .sq-diag pre{margin:6px 0 0;padding:10px;max-height:240px;overflow:auto;background:#fff;border:1px solid #d5dce3;border-radius:6px;font:12px/1.5 ui-monospace,Consolas,monospace;white-space:pre-wrap;overflow-wrap:anywhere;color:#26303a}
#sqModal #sqPreview{display:block;width:100%;height:auto;margin-top:6px;border:1px solid #d5dce3;border-radius:6px}
#sqModal .sq-rows{display:grid;gap:10px}
#sqModal .sq-row{background:#fff;border:1px solid #d5dce3;border-radius:8px;padding:10px 12px}
#sqModal .sq-row dt{margin:0;font-size:11.5px;font-weight:500;color:#5c6874}
#sqModal .sq-row dd{margin:2px 0 0;font-size:18px;font-weight:700;overflow-wrap:anywhere}
#sqModal .sq-row dd.none{font-size:13.5px;font-weight:500;color:#8a95a0}
#sqModal .sq-row .cur{margin-top:2px;font-size:11.5px;font-weight:500;color:#9a5b00}
#sqModal .sq-sub{margin:14px 0 6px;font-size:12px;font-weight:700;color:#124D82}
#sqModal .sq-ref{display:flex;justify-content:space-between;gap:12px;font-size:13px;padding:3px 0;border-bottom:1px dashed #e0e5ea}
#sqModal .sq-ref span:last-child{font-weight:600;overflow-wrap:anywhere;text-align:right}
#sqModal .sq-resnote{margin:12px 0 0;font-size:12px;color:#5c6874}
input.sq-filled,select.sq-filled{background:#eef8f0;border-color:#6fb585}
.sq-done{color:#1e7a3f}
`;

// ---- 値の変換(単体テスト用に _t で公開) ----
// 初度登録年月(西暦・月) → フォームの元号選択(令和/平成)。昭和以前は選択肢が無いので null
function eraOf(y, m) {
  const t = y * 100 + m;
  if (t >= 201905) return { era: "令和", n: y - 2018 };
  if (t >= 198901) return { era: "平成", n: y - 1988 };
  return null;
}

// 原動機型式 → HV車。ハイフンで区切られた原動機(エンジン+モーターなど)の記載が2つ以上あれば「はい」
//   例) R06A-WA05A → はい(スズキのマイルドハイブリッドなど) / FB20 → いいえ
//   型式なし・不明(*KUMITATE, *FUMEI, *SHISAKU)や空欄は判定しない(null = 入力欄を変更しない)
function hvFromEngine(engine) {
  const e = (engine || "").trim();
  if (!e || e.startsWith("*")) return null;
  const parts = e.replace(/\*[KS]$/, "").split("-").map(x => x.trim()).filter(x => x !== "");   // 改造車(*K)・試作(*S)の印は除く
  if (parts.length === 0) return null;
  const yes = parts.length >= 2;
  return { value: yes ? "はい" : "いいえ", label: (yes ? "はい" : "いいえ") + "(原動機型式: " + e + ")", count: parts.length };
}

// ---- 型式表(OBD検査対象車型式一覧) → 車名(通称名)・用途・車両区分の候補 ----
// 表は型式をキーに [型式, 通称名, メーカー, 種別, 輸入] を持つ。メーカー名は確認画面での一時表示だけに使い、
// フォームの入力欄にも送信データにも入れない。表にない型式は何も補わない(手入力)。
function buildModelIndex(data) {
  if (!data || !Array.isArray(data.rows)) return null;
  const exact = new Map(), suffix = new Map();
  data.rows.forEach(r => {
    exact.set(r[0], r);
    const k = r[0].slice(r[0].indexOf("-") + 1);
    if (!suffix.has(k)) suffix.set(k, []);
    suffix.get(k).push(r);
  });
  return { exact, suffix, makers: data.makers, kinds: data.kinds, asof: data.asof, version: data.version };
}

function usageOfKind(kind) { return /乗用$/.test(kind) ? "乗用" : /貨物$/.test(kind) ? "貨物" : null; }

// QRの型式 → 候補。完全一致が優先。無ければ「型式の前半(排出ガス規制の区分 例 DBA-/3BA-)を除いた部分」が一致する行から推定する
//   (同じ後半なら同じ車種のことが多い。ただし推定なので画面に明示する)。行どうしで食い違う項目は補わない。
function lookupModel(index, model) {
  if (!index) return null;
  const m = String(model || "").normalize("NFKC").trim().toUpperCase();
  if (!m) return null;
  let rows, match;
  if (index.exact.has(m)) { rows = [index.exact.get(m)]; match = "exact"; }
  else {
    const k = m.slice(m.indexOf("-") + 1);
    rows = index.suffix.get(k);
    if (!rows) return { match: "none", model: m };
    match = "suffix";
  }
  const same = f => rows.every(r => f(r) === f(rows[0])) ? f(rows[0]) : null;
  const usageSet = new Set(rows.map(r => usageOfKind(index.kinds[r[3]])));
  const usage = usageSet.size === 1 ? [...usageSet][0] : null;
  const imp = same(r => r[4]);
  const makerIdx = same(r => r[2]);
  return {
    match, model: m,
    nickname: same(r => r[1]) || "",
    maker: makerIdx === null ? "" : index.makers[makerIdx],
    usage,
    cls: usage === "乗用" && imp !== null ? (imp ? "外車" : "乗用") : null
  };
}

let modelsP = null;
function loadModels() {
  if (!modelsP) {
    modelsP = fetch(SCRIPT_BASE + "data/models.json?v=" + VERSION).then(r => { if (!r.ok) throw new Error("HTTP " + r.status); return r.json(); })
      .then(buildModelIndex).catch(() => { modelsP = null; return null; });
  }
  return modelsP;
}

// 結合済みQR(コード2・3)から、フォームへ転記する値を作る
// 軽自動車の排気量(660cc固定)。
// 判定: 二次元コード2が「K/22/」で始まる(軽自動車検査協会の様式。仕様書のシステムID "K")。普通車は国交省の様式で「2/」で始まる。
// 自動入力しない場合: 電気自動車(燃料コード05。排気量なし) / 初度検査が1990年2月より前(規格が660ccになる前の550cc・360cc)。
function keiDisplacement(merged, code2Ok, v, notes) {
  if (!(merged.code2 && merged.code2.kei && code2Ok)) return null;
  if (v.fuel && v.fuel.value === "05") { notes.push("電気自動車のため、排気量は自動入力しません。"); return null; }
  const fr = v.first_reg && v.first_reg.value;   // "YYYY-MM"
  if (fr && fr < "1990-02") { notes.push("初度検査が1990年1月以前の軽自動車は、排気量が660ccではない場合があるため、排気量は自動入力しません。"); return null; }
  return { value: 660, label: "660cc(軽自動車のため固定値)", fuelKnown: !!(v.fuel && v.fuel.value), regKnown: !!fr };
}

function toFormValues(merged, nowYear, models) {
  const out = { regno: null, chassis: null, firstReg: null, hv: null, displacement: null, carname: null, usage: null, cls: null, refs: [], notes: [] };
  const good = c => c && c.parsed.errors.length === 0;
  const v = {};
  buildFields({ code2: good(merged.code2) ? merged.code2 : null, code3: good(merged.code3) ? merged.code3 : null }, nowYear)
    .forEach(g => g.items.forEach(i => { v[i.key] = i; }));
  if (merged.code2 && !good(merged.code2)) out.notes.push("コード2は結合できましたが、項目の形式が想定と合わないため使用していません。");
  if (merged.code3 && !good(merged.code3)) out.notes.push("コード3は結合できましたが、項目の形式が想定と合わないため使用していません。");

  if (v.reg_full && v.reg_full.value.trim()) out.regno = v.reg_full.value.trim();
  if (v.chassis && v.chassis.value) out.chassis = v.chassis.value;
  if (merged.code2 && merged.code2.kei) out.refs.push(["車種の区分", "軽自動車(軽自動車検査協会の仕様)"]);
  if (v.engine && v.engine.value) out.refs.push(["原動機型式", v.engine.value]);

  if (v.first_reg && v.first_reg.value) {
    const m = v.first_reg.value.match(/^(\d{4})-(\d{2})$/);
    const e = m && eraOf(Number(m[1]), Number(m[2]));
    if (e) out.firstReg = { era: e.era, year: e.n, month: Number(m[2]), label: e.era + e.n + "年" + Number(m[2]) + "月" };
    else out.notes.push("初度登録年月(" + v.first_reg.value + ")は、フォームの元号(令和・平成)に当てはまらないため自動入力しません。");
  }
  out.hv = hvFromEngine(v.engine && v.engine.value);
  out.displacement = keiDisplacement(merged, good(merged.code2), v, out.notes);
  if (v.model && v.model.value) out.refs.push(["型式", v.model.value]);
  if (v.model && v.model.value && merged.code3 && good(merged.code3)) {
    const hit = lookupModel(models, v.model.value);
    if (!models) out.notes.push("型式一覧を読み込めなかったため、車名・用途は自動入力しません。");
    else if (hit.match === "none") out.notes.push("型式(" + hit.model + ")は型式一覧(OBD検査対象車型式一覧 " + (models.asof || "") + "時点)に載っていないため、車名・用途は自動入力しません。");
    else {
      if (hit.match === "suffix") out.notes.push("型式一覧に同じ型式がなかったため、型式の後半が同じ車から推定しています(前半は排出ガス規制の区分)。違う場合は直してください。");
      if (hit.nickname) out.carname = { value: hit.nickname, label: hit.nickname + (hit.match === "suffix" ? "(推定)" : "") };
      else out.notes.push("型式一覧に通称名の記載がないため、車名は自動入力しません。");
      if (hit.usage) out.usage = { value: hit.usage, label: hit.usage + (hit.match === "suffix" ? "(推定)" : "") };
      else out.notes.push("用途を一つに決められないため(乗合など)、用途は自動入力しません。");
      if (hit.cls) out.cls = { value: hit.cls, label: hit.cls + "(" + (hit.cls === "外車" ? "輸入車のため" : "国産車のため") + (hit.match === "suffix" ? "・推定" : "") + ")" };
      if (hit.maker) out.refs.push(["メーカー(参考表示のみ。転記も保持もしません)", hit.maker]);
    }
  }
  if (v.fuel && v.fuel.hint) out.refs.push(["燃料の種類", v.fuel.hint]);
  return out;
}

// ---- フォームへの転記 ----
function markFilled(el) {
  el.classList.add("sq-filled");
  el.addEventListener("input", () => el.classList.remove("sq-filled"), { once: true });
}

function setField(id, value) {
  const el = document.getElementById(id);
  if (!el) return false;
  el.value = String(value);
  if (el.tagName === "SELECT" && el.value !== String(value)) return false;   // 選択肢に無い値
  el.dispatchEvent(new Event("input", { bubbles: true }));
  el.dispatchEvent(new Event("change", { bubbles: true }));
  markFilled(el);
  return true;
}

function currentFirstReg() {
  const y = (document.getElementById(FIELD.year) || {}).value, m = (document.getElementById(FIELD.month) || {}).value;
  const e = (document.getElementById(FIELD.era) || {}).value;
  return y && m ? e + y + "年" + m + "月" : "";
}

// ---- 状態 ----
const $ = id => document.getElementById(id);
let built = false;
let trigger = null;
let store = [], storeKeys = new Set(), lastEval = null;
let source = null, busy = false, currentVals = null;
const live = { stream: null, active: false, timer: null, track: null, torchOn: false };

function setStatus(msg, cls) {
  const s = $("sqStatus");
  s.textContent = msg;
  s.className = "sq-status" + (cls ? " " + cls : "");
}

function badge(text, cls) {
  const b = document.createElement("span");
  b.className = "sq-badge" + (cls ? " " + cls : "");
  b.textContent = text;
  return b;
}

function buzz(ms) { try { if (navigator.vibrate) navigator.vibrate(ms); } catch (e) { /* 非対応 */ } }

function resetStore() { store = []; storeKeys = new Set(); lastEval = null; }

function addSymbols(list) {
  let added = 0;
  for (const s of list) {
    const k = symKey(s);
    if (storeKeys.has(k)) continue;
    storeKeys.add(k);
    store.push(s);
    added++;
  }
  return added;
}

function evaluate() {
  const merged = mergeSymbols(store);
  const bad = c => c && c.parsed.errors.length > 0;
  const complete = !!(merged.code2 && merged.code3 && !bad(merged.code2) && !bad(merged.code3));
  const usable = !!((merged.code2 && !bad(merged.code2)) || (merged.code3 && !bad(merged.code3)));
  lastEval = { merged, complete, usable, labels: labelMap(store, merged), progress: progressInfo(store) };
  return lastEval;
}

// ---- 読み取りエンジン(自サーバーの vendor/ から読み込み。外部通信なし) ----
function loadScript(src) {
  return new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = src;
    s.onload = resolve;
    s.onerror = () => reject(new Error("読み込めませんでした: " + src));
    document.head.append(s);
  });
}

let engineP = null;
function initEngine() {
  if (!engineP) {
    engineP = (async () => {
      if (typeof ZXingWASM === "undefined") await loadScript(SCRIPT_BASE + "vendor/zxing-reader.iife.js?v=" + VERSION);
      const res = await fetch(SCRIPT_BASE + "vendor/zxing_reader.wasm?v=" + VERSION);
      if (!res.ok) throw new Error("読み取りエンジンを取得できません(HTTP " + res.status + ")");
      const wasmBinary = new Uint8Array(await res.arrayBuffer());
      ZXingWASM.prepareZXingModule({ overrides: { wasmBinary }, fireImmediately: true });
      await ZXingWASM.readBarcodes(
        { data: new Uint8ClampedArray(16 * 16 * 4).fill(255), width: 16, height: 16 },
        { formats: ["QRCode"] }
      );
    })();
    engineP.catch(() => { engineP = null; });
  }
  return engineP;
}

function engineMessage(e) {
  return "読み取りエンジンを起動できませんでした。(" + ((e && e.message) || e) + ")";
}

async function detectImage(img, opts) {
  await initEngine();
  const rs = await ZXingWASM.readBarcodes(img, Object.assign({
    formats: ["QRCode"], maxNumberOfSymbols: 12, tryHarder: true, tryRotate: true, tryDownscale: true
  }, opts || {}));
  return rs.filter(r => r.isValid).map(r => ({
    bytes: r.bytes, sequenceIndex: r.sequenceIndex, sequenceSize: r.sequenceSize,
    sequenceId: r.sequenceId, position: r.position
  }));
}

function drawBoxes(ctx, syms, labels, lw) {
  ctx.lineWidth = lw;
  ctx.font = "bold " + Math.round(lw * 5) + "px sans-serif";
  ctx.lineJoin = "round";
  for (const s of syms) {
    const p = s.position;
    if (!p) continue;
    const label = labels.get(symKey(s));
    ctx.strokeStyle = ctx.fillStyle = label ? "#1fb457" : "#f0900a";
    ctx.beginPath();
    ctx.moveTo(p.topLeft.x, p.topLeft.y);
    ctx.lineTo(p.topRight.x, p.topRight.y);
    ctx.lineTo(p.bottomRight.x, p.bottomRight.y);
    ctx.lineTo(p.bottomLeft.x, p.bottomLeft.y);
    ctx.closePath();
    ctx.stroke();
    if (label) {
      const x = Math.min(p.topLeft.x, p.bottomLeft.x), y = Math.min(p.topLeft.y, p.topRight.y);
      ctx.lineWidth = lw * 1.6; ctx.strokeStyle = "#000";
      ctx.strokeText(label, x, Math.max(lw * 5, y - lw * 2));
      ctx.fillText(label, x, Math.max(lw * 5, y - lw * 2));
      ctx.lineWidth = lw;
    }
  }
}

// ---- 撮影画像・PDF ----
let pdfjsP = null;
function loadPdfJs() {
  if (window.pdfjsLib) return Promise.resolve();
  if (!pdfjsP) {
    pdfjsP = loadScript(SCRIPT_BASE + "vendor/pdf.min.js?v=" + VERSION).then(() => {
      window.pdfjsLib.GlobalWorkerOptions.workerSrc = SCRIPT_BASE + "vendor/pdf.worker.min.js?v=" + VERSION;
    }).catch(e => { pdfjsP = null; throw new Error("PDFの読み込み部品を取得できませんでした。"); });
  }
  return pdfjsP;
}

async function loadBitmap(file) {
  try { return await createImageBitmap(file); } catch (e) {
    return await new Promise((resolve, reject) => {
      const im = new Image();
      im.onload = () => resolve(im);
      im.onerror = () => reject(new Error("画像を読み込めませんでした。"));
      im.src = URL.createObjectURL(file);
    });
  }
}

async function buildAttempts() {
  if (source.kind === "pdf") {
    const list = [];
    const n = Math.min(source.pdf.numPages, 3);
    for (let p = 1; p <= n; p++) {
      const page = await source.pdf.getPage(p);
      const v1 = page.getViewport({ scale: 1 });
      const cap = Math.sqrt(14e6 / (v1.width * v1.height));
      [...new Set([4, 6].map(s => Math.min(s, cap).toFixed(2)))].map(Number)
        .forEach(s => list.push({ kind: "pdf", page: p, scale: s }));
    }
    return list;
  }
  return [
    { kind: "image", max: 4000 },
    { kind: "image", max: 2200 },
    { kind: "image", max: 4000, opts: { binarizer: "GlobalHistogram" } },
    { kind: "image", max: 2200, opts: { binarizer: "FixedThreshold" } }
  ];
}

async function renderAttempt(a, bmp, cv, cx) {
  if (a.kind === "pdf") {
    const page = await source.pdf.getPage(a.page);
    const vp = page.getViewport({ scale: a.scale });
    cv.width = Math.floor(vp.width);
    cv.height = Math.floor(vp.height);
    cx.fillStyle = "#fff";
    cx.fillRect(0, 0, cv.width, cv.height);
    await page.render({ canvasContext: cx, viewport: vp }).promise;
  } else {
    const w = bmp.width || bmp.naturalWidth, h = bmp.height || bmp.naturalHeight;
    const s = Math.min(1, a.max / Math.max(w, h));
    cv.width = Math.max(1, Math.round(w * s));
    cv.height = Math.max(1, Math.round(h * s));
    cx.fillStyle = "#fff";
    cx.fillRect(0, 0, cv.width, cv.height);
    cx.imageSmoothingEnabled = true;
    cx.imageSmoothingQuality = "high";
    cx.drawImage(bmp, 0, 0, cv.width, cv.height);
  }
}

function setBusy(on) {
  busy = on;
  $("sqShot").disabled = on;
  $("sqFile").disabled = on;
  $("sqReset").disabled = on;
}

async function runScan() {
  if (busy || !source) return;
  setBusy(true);
  const pv = $("sqPreview"), pctx = pv.getContext("2d", { willReadFrequently: true });
  let bmp = null;
  try {
    await initEngine();
    if (source.kind === "image") bmp = await loadBitmap(source.file);
    const attempts = await buildAttempts();
    let best = null;
    for (let i = 0; i < attempts.length; i++) {
      setStatus("QRコードを検索中… (" + (i + 1) + "/" + attempts.length + ")");
      await new Promise(r => setTimeout(r, 0));
      await renderAttempt(attempts[i], bmp, pv, pctx);
      const syms = await detectImage(pctx.getImageData(0, 0, pv.width, pv.height), attempts[i].opts);
      addSymbols(syms);
      if (!best || syms.length > best.syms.length) best = { attempt: attempts[i], syms };
      if (evaluate().complete) break;
    }
    const ev = evaluate();
    if (best && best.syms.length) {
      await renderAttempt(best.attempt, bmp, pv, pctx);
      drawBoxes(pctx, best.syms, ev.labels, Math.max(4, pv.width / 300));
      $("sqPreviewBox").hidden = false;
    } else {
      $("sqPreviewBox").hidden = true;
    }
    afterScan();
  } catch (e) {
    console.error(e);
    setStatus(/エンジン|WebAssembly/.test((e && e.message) || "") ? engineMessage(e) : "読み取り中にエラーが発生しました: " + ((e && e.message) || e), "err");
  } finally {
    if (bmp && bmp.close) bmp.close();
    setBusy(false);
  }
}

// ---- ライブカメラ ----
const grab = document.createElement("canvas");
const gctx = grab.getContext("2d", { willReadFrequently: true });

function liveSupported() {
  if (!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia)) return false;
  if (!window.isSecureContext) return false;
  try {
    const pp = document.permissionsPolicy || document.featurePolicy;
    if (pp && pp.allowsFeature && !pp.allowsFeature("camera")) return false;
  } catch (e) { /* 判定できない環境は使える前提 */ }
  return true;
}

function cameraErrorMessage(e) {
  const name = (e && e.name) || "";
  let base;
  if (name === "NotAllowedError" || name === "SecurityError") base = "カメラの使用が許可されていません。ブラウザの設定でこのページのカメラを許可してください。";
  else if (name === "NotFoundError" || name === "OverconstrainedError") base = "使用できるカメラが見つかりません。";
  else if (name === "NotReadableError") base = "カメラを開けません。他のアプリが使用中の可能性があります。";
  else base = "カメラを起動できませんでした。(" + (name || ((e && e.message) || "error")) + ")";
  return base + "下の「撮影して読み取り」も使えます。";
}

async function setupTrackControls() {
  const track = live.track;
  const caps = (track.getCapabilities && track.getCapabilities()) || {};
  try {
    if (caps.focusMode && caps.focusMode.includes("continuous")) await track.applyConstraints({ advanced: [{ focusMode: "continuous" }] });
  } catch (e) { /* 非対応 */ }
  $("sqTorch").hidden = !caps.torch;
  live.torchOn = false;
  $("sqTorch").textContent = "ライト";
  const zoom = $("sqZoom");
  if (caps.zoom && caps.zoom.max > caps.zoom.min) {
    zoom.min = caps.zoom.min;
    zoom.max = Math.min(caps.zoom.max, caps.zoom.min * 4);
    zoom.step = caps.zoom.step || 0.1;
    zoom.value = (track.getSettings && track.getSettings().zoom) || caps.zoom.min;
    $("sqZoomWrap").hidden = false;
  } else {
    $("sqZoomWrap").hidden = true;
  }
}

async function startLive() {
  if (live.active || busy) return;
  try { await initEngine(); } catch (e) { setStatus(engineMessage(e), "err"); return; }
  if (lastEval && lastEval.complete) resetStore();
  setStatus("カメラを起動しています…");
  try {
    live.stream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: { facingMode: { ideal: "environment" }, width: { ideal: 1920 }, height: { ideal: 1080 } }
    });
  } catch (e) {
    setStatus(cameraErrorMessage(e), "err");
    return;
  }
  const video = $("sqVideo");
  video.srcObject = live.stream;
  try { await video.play(); } catch (e) { /* autoplay属性で再生される */ }
  live.track = live.stream.getVideoTracks()[0];
  await setupTrackControls();
  $("sqCam").hidden = false;
  live.active = true;
  setStatus("車検証のQRコードが画面に入るようにかざしてください(普通車は計5個、軽自動車は計2個)。読み取れたものは自動で蓄積します。");
  renderProgress(evaluate());
  liveLoop();
}

async function liveLoop() {
  if (!live.active) return;
  const t0 = performance.now();
  const video = $("sqVideo"), overlay = $("sqOverlay");
  if (video.readyState >= 2 && video.videoWidth) {
    const vw = video.videoWidth, vh = video.videoHeight;
    const sc = Math.min(1, 1920 / Math.max(vw, vh));
    const w = Math.round(vw * sc), h = Math.round(vh * sc);
    if (grab.width !== w || grab.height !== h) {
      grab.width = overlay.width = w;
      grab.height = overlay.height = h;
      $("sqCam").querySelector(".sq-camwrap").style.setProperty("--ar", String(vw / vh));
    }
    gctx.drawImage(video, 0, 0, w, h);
    let syms = [];
    try { syms = await detectImage(gctx.getImageData(0, 0, w, h)); } catch (e) { console.error(e); }
    if (!live.active) return;
    stats.frames++; stats.w = w; stats.h = h;
    if (syms.length) { stats.hitFrames++; stats.maxSyms = Math.max(stats.maxSyms, syms.length); }
    const added = syms.length ? addSymbols(syms) : 0;
    const ev = added ? evaluate() : (lastEval || evaluate());
    const octx = overlay.getContext("2d");
    octx.clearRect(0, 0, w, h);
    drawBoxes(octx, syms, ev.labels, Math.max(3, w / 300));
    if (added) {
      buzz(25);
      renderProgress(ev);
      if (ev.complete) { buzz(80); showResult(ev); return; }
    }
  }
  live.timer = setTimeout(liveLoop, Math.max(0, 80 - (performance.now() - t0)));
}

function stopLive() {
  live.active = false;
  clearTimeout(live.timer);
  if (live.stream) live.stream.getTracks().forEach(t => t.stop());
  live.stream = null;
  live.track = null;
  const v = $("sqVideo");
  if (v) v.srcObject = null;
  const cam = $("sqCam");
  if (cam) cam.hidden = true;
}

// ---- 診断情報(読み取れない原因の切り分け用。車両情報を含むため、共有先に注意) ----
const stats = { frames: 0, hitFrames: 0, w: 0, h: 0, maxSyms: 0, source: "" };
function symWidth(s) {
  try { const p = s.position; return Math.round(Math.hypot(p.topRight.x - p.topLeft.x, p.topRight.y - p.topLeft.y)); } catch (e) { return null; }
}
function diagText(ev) {
  const L = [];
  L.push("v" + VERSION + " / " + (location.protocol === "https:" ? "https" : location.protocol.replace(":", "")) + " / " + navigator.userAgent);
  L.push("ライブ: " + stats.frames + "フレーム中 " + stats.hitFrames + " で検出 / 画面サイズ " + stats.w + "x" + stats.h + " / 1フレーム最大 " + stats.maxSyms + " 個");
  L.push("蓄積したQR: " + store.length + " 個");
  store.forEach((s, i) => {
    const seq = s.sequenceSize > 1 ? ("連結 " + (s.sequenceIndex + 1) + "/" + s.sequenceSize + " id=" + s.sequenceId) : "連結情報なし";
    const hex = Array.from(s.bytes.slice(0, 6)).map(b => b.toString(16).padStart(2, "0")).join(" ");
    L.push("#" + (i + 1) + " " + seq + " / " + s.bytes.length + "バイト / 一辺 約" + (symWidth(s) || "?") + "px / 先頭 " + hex);
    L.push("   内容: " + markBlanks(decodeBytes(s.bytes)));
  });
  const m = ev.merged;
  [["コード2", m.code2], ["コード3", m.code3]].forEach(([n, c]) => {
    if (c) L.push(n + ": " + c.method + (c.parsed.errors.length ? " / 形式エラー: " + c.parsed.errors.join(" | ") : " / 形式OK"));
    else L.push(n + ": 結合できず");
  });
  m.notes.forEach(t => L.push("注記: " + t));
  return L.join("\n");
}

// ---- 表示 ----
function renderProgress(ev) {
  const dbox = $("sqDiagBox");
  if (dbox) { dbox.hidden = !store.length; if (store.length) $("sqDiag").textContent = diagText(ev); }
  const box = $("sqBadges");
  box.replaceChildren();
  const m = ev.merged;
  $("sqConfirm").disabled = !ev.usable;
  if (!store.length) return;
  const one = (name, size, merged) => {
    if (merged) return badge(name + " ✓", "ok");
    const g = ev.progress.groups.find(x => x.size === size);
    return g ? badge(name + " " + g.have + "/" + size, "warn") : badge(name + " 未検出", "ng");
  };
  box.append(one("コード2", 2, m.code2), one("コード3", 3, m.code3));
  const usedPlain = [m.code2, m.code3].reduce((n, c) => n + (c && c.method !== "連結ヘッダ" ? c.order.length : 0), 0);
  if (ev.progress.plain > usedPlain) box.append(badge("連結情報なしのQR " + ev.progress.plain + "個", "warn"));
  const ul = $("sqNotes");
  ul.replaceChildren();
  m.notes.forEach(t => { const li = document.createElement("li"); li.textContent = t; ul.append(li); });
}

function missingText(ev) {
  const m = ev.merged, parts = [];
  [["コード2", 2, m.code2], ["コード3", 3, m.code3]].forEach(([name, size, c]) => {
    if (c) { if (c.parsed.errors.length) parts.push(name + "は項目の形式が想定と合いません"); return; }
    const g = ev.progress.groups.find(x => x.size === size);
    parts.push(g ? name + "はあと" + (size - g.have) + "個" : name + "は未検出");
  });
  if (ev.progress.plain > 0 && !(m.code2 || m.code3)) parts.push("連結情報のないQRを" + ev.progress.plain + "個検出済み");
  return parts.join("、");
}

// 撮影・ファイル読み取りの後
function afterScan() {
  const ev = evaluate();
  renderProgress(ev);
  if (ev.complete) { showResult(ev); return; }
  if (!store.length) {
    setStatus("QRコードを検出できませんでした。近づく、ピントを合わせる、光の反射を避けるなどして、もう一度お試しください。", "err");
  } else {
    setStatus("一部のみ読み取れました(" + missingText(ev) + ")。足りないコードが写るように撮影すると追加できます。読み取れた分だけで進めることもできます。", "warn");
  }
}

async function showResult(ev) {
  stopLive();
  const models = await loadModels();
  const vals = toFormValues(ev.merged, new Date().getFullYear(), models);
  currentVals = vals;
  const box = $("sqResult");
  box.replaceChildren();

  const rows = document.createElement("dl");
  rows.className = "sq-rows";
  rows.style.margin = "12px 0 0";
  const addRow = (label, value, cur, cmp) => {
    const row = document.createElement("div");
    row.className = "sq-row";
    const dt = document.createElement("dt"); dt.textContent = label;
    const dd = document.createElement("dd");
    if (value) dd.textContent = value; else { dd.textContent = "未取得(自動入力しません)"; dd.className = "none"; }
    row.append(dt, dd);
    if (value && cur && cur !== (cmp || value)) {
      const c = document.createElement("div");
      c.className = "cur";
      c.textContent = "現在の入力: " + cur + "(上書きされます)";
      row.append(c);
    }
    rows.append(row);
  };
  const val = id => ((document.getElementById(id) || {}).value || "").trim();
  addRow("登録番号", vals.regno, val(FIELD.regno));
  addRow("車台番号", vals.chassis, val(FIELD.chassis));
  addRow("初度登録年月", vals.firstReg && vals.firstReg.label, currentFirstReg());
  addRow("HV車", vals.hv && vals.hv.label, vals.hv ? val(FIELD.hv) : "", vals.hv && vals.hv.value);
  if (vals.displacement) addRow("排気量(cc)", vals.displacement.label, val(FIELD.displacement), String(vals.displacement.value));
  if (vals.carname) addRow("車名(通称名)", vals.carname.label, val(FIELD.carname), vals.carname.value);
  if (vals.usage) addRow("用途", vals.usage.label, val(FIELD.usage), vals.usage.value);
  if (vals.cls) addRow("車両区分", vals.cls.label, val(FIELD.cls), vals.cls.value);
  box.append(rows);

  if (vals.refs.length) {
    const h = document.createElement("div");
    h.className = "sq-sub";
    h.textContent = "参考(転記しません)";
    box.append(h);
    vals.refs.forEach(([k, x]) => {
      const r = document.createElement("div");
      r.className = "sq-ref";
      const a = document.createElement("span"), b = document.createElement("span");
      a.textContent = k; b.textContent = x;
      r.append(a, b);
      box.append(r);
    });
  }
  const p = document.createElement("p");
  p.className = "sq-resnote";
  const manual = (vals.carname ? [] : ["車名"]).concat(["走行距離"], vals.displacement ? [] : ["排気量"]).join("・");
  p.textContent = manual + "は車検証のQRコードに含まれないため、手入力してください。" +
    (vals.displacement ? "排気量は、軽自動車のため660ccを入力します(実際の排気量と異なる場合は修正してください)。" : "") +
    ((vals.carname || vals.usage || vals.cls) ? "車名・用途・車両区分は、型式一覧から補う候補です。違う場合は直してください。" : "") +
    (vals.hv ? "HV車は、原動機型式にハイフン区切りで2つ以上の記載があるかで判定しています。" : "");
  box.append(p);
  if (vals.notes.length) {
    const ul = document.createElement("ul");
    ul.className = "sq-notes";
    vals.notes.forEach(t => { const li = document.createElement("li"); li.textContent = t; ul.append(li); });
    box.append(ul);
  }

  const any = !!(vals.regno || vals.chassis || vals.firstReg || vals.hv || vals.displacement || vals.carname || vals.usage || vals.cls);
  $("sqApply").disabled = !any;
  setPhase("result");
  setStatus(ev.complete ? "読み取りが完了しました。内容を確認して、フォームに入力してください。" : "読み取れた分を表示しています。内容を確認してください。", ev.complete ? "ok" : "warn");
  $("sqBody").scrollTop = 0;
}

// phase: "scan"(読み取り中) / "result"(結果確認)
function setPhase(phase) {
  const r = phase === "result";
  $("sqResult").hidden = !r;
  $("sqAlt").hidden = r;
  $("sqBadges").hidden = r;
  $("sqPreviewBox").hidden = r || $("sqPreviewBox").hidden;
  $("sqReset").hidden = r;
  $("sqConfirm").hidden = r;
  $("sqBack").hidden = !r;
  $("sqApply").hidden = !r;
  if (r) { $("sqNotes").replaceChildren(); }
}

function apply() {
  const v = currentVals;
  if (!v) return;
  const filled = [];
  if (v.regno && setField(FIELD.regno, v.regno)) filled.push("登録番号");
  if (v.chassis && setField(FIELD.chassis, v.chassis)) filled.push("車台番号");
  if (v.firstReg) {
    const a = setField(FIELD.era, v.firstReg.era), b = setField(FIELD.year, v.firstReg.year), c = setField(FIELD.month, v.firstReg.month);
    if (a && b && c) filled.push("初度登録年月");
  }
  if (v.hv && setField(FIELD.hv, v.hv.value)) filled.push("HV車");
  if (v.displacement && setField(FIELD.displacement, v.displacement.value)) filled.push("排気量(660cc)");
  if (v.carname && setField(FIELD.carname, v.carname.value)) filled.push("車名");
  if (v.usage) {
    const cur = document.getElementById(FIELD.usage);
    if (cur && cur.value === v.usage.value) filled.push("用途");          // 同じ値なら触らない(補償期間の選択を保つ)
    else if (setField(FIELD.usage, v.usage.value)) filled.push("用途");   // 変更時は補償期間の選択肢が作り直される
  }
  if (v.cls && setField(FIELD.cls, v.cls.value)) filled.push("車両区分");
  closeModal(false);
  const n = document.getElementById("sqNote");
  if (n) {
    n.textContent = "車検証から入力しました: " + filled.join("・") + "。内容を確認し、" + (v.carname ? "" : "車名・") + "走行距離" + (v.displacement ? "" : "・排気量") + "などを入力してください。";
    n.classList.add("sq-done");
  }
  const target = document.getElementById(FIELD.regno);
  if (target) { try { target.scrollIntoView({ behavior: "smooth", block: "center" }); } catch (e) { /* noop */ } }
}

// ---- 画面の組み立て・開閉 ----
function buildModal() {
  const st = document.createElement("style");
  st.textContent = CSS;
  document.head.append(st);

  const wrap = document.createElement("div");
  wrap.id = "sqModal";
  wrap.hidden = true;
  wrap.setAttribute("role", "dialog");
  wrap.setAttribute("aria-modal", "true");
  wrap.setAttribute("aria-labelledby", "sqTitle");
  wrap.innerHTML =
    '<div class="sq-sheet">' +
      '<div class="sq-head"><h2 id="sqTitle">車検証のQRコードを読み取る</h2>' +
        '<button type="button" class="sq-x" id="sqClose" aria-label="閉じる">×</button></div>' +
      '<div class="sq-body" id="sqBody">' +
        '<div id="sqCam" hidden>' +
          '<div class="sq-camwrap"><video id="sqVideo" playsinline muted autoplay></video><canvas id="sqOverlay"></canvas></div>' +
          '<div class="sq-camtools"><button type="button" class="sq-btn sm" id="sqTorch" hidden>ライト</button>' +
            '<label class="sq-zoom" id="sqZoomWrap" hidden>ズーム<input type="range" id="sqZoom" min="1" max="2" step="0.1" value="1"></label></div>' +
        '</div>' +
        '<p id="sqStatus" class="sq-status" role="status" aria-live="polite"></p>' +
        '<div id="sqBadges" class="sq-badges"></div>' +
        '<ul id="sqNotes" class="sq-notes"></ul>' +
        '<div id="sqResult" hidden></div>' +
        '<div id="sqAlt" class="sq-alt">' +
          '<label class="sq-btn" for="sqShot">撮影して読み取り</label>' +
          '<input class="sq-sr" type="file" id="sqShot" accept="image/*" capture="environment">' +
          '<label class="sq-btn" for="sqFile">PDF・画像ファイルから読み取り</label>' +
          '<input class="sq-sr" type="file" id="sqFile" accept="application/pdf,.pdf,image/*">' +
        '</div>' +
        '<details id="sqDiagBox" class="sq-diag" hidden><summary>診断情報(うまく読み取れないとき用)</summary>' +
          '<button type="button" class="sq-btn sm" id="sqDiagCopy" style="margin-top:6px">診断情報をコピー</button><pre id="sqDiag"></pre></details>' +
        '<details id="sqPreviewBox" hidden><summary>読み取った画像を確認(緑=使用、橙=未使用)</summary><canvas id="sqPreview"></canvas></details>' +
      '</div>' +
      '<div class="sq-foot">' +
        '<button type="button" class="sq-btn" id="sqReset">最初からやり直す</button>' +
        '<button type="button" class="sq-btn main" id="sqConfirm" disabled>読み取り内容を確認</button>' +
        '<button type="button" class="sq-btn" id="sqBack" hidden>戻って追加で読み取る</button>' +
        '<button type="button" class="sq-btn main" id="sqApply" hidden>フォームに入力する</button>' +
      '</div>' +
    '</div>';
  document.body.append(wrap);

  $("sqClose").addEventListener("click", () => closeModal(true));
  $("sqDiagCopy").addEventListener("click", async () => {
    const pre = $("sqDiag"), btn = $("sqDiagCopy");
    try { await navigator.clipboard.writeText(pre.textContent); btn.textContent = "コピーしました"; }
    catch (e) {
      const r = document.createRange(); r.selectNodeContents(pre);
      const sel = window.getSelection(); sel.removeAllRanges(); sel.addRange(r);
      btn.textContent = "選択しました(長押しでコピー)";
    }
    setTimeout(() => { btn.textContent = "診断情報をコピー"; }, 2500);
  });
  $("sqApply").addEventListener("click", apply);
  $("sqConfirm").addEventListener("click", () => { if (lastEval && lastEval.usable) showResult(lastEval); });
  $("sqBack").addEventListener("click", () => {
    setPhase("scan");
    renderProgress(evaluate());
    setStatus(lastEval.complete ? "読み取り済みです。別の車両を読む場合は「最初からやり直す」を押してください。" : "足りないコードを読み取ってください。", lastEval.complete ? "ok" : "");
    if (!lastEval.complete && liveSupported()) startLive();
  });
  $("sqReset").addEventListener("click", () => { resetAll(); if (liveSupported()) startLive(); });

  $("sqShot").addEventListener("change", async e => {
    const file = e.target.files[0];
    e.target.value = "";
    if (!file || busy) return;
    stopLive();
    if (lastEval && lastEval.complete) resetStore();    // 完了済みなら別の車両として最初から
    source = { kind: "image", file };
    await runScan();
  });

  $("sqFile").addEventListener("change", async e => {
    const file = e.target.files[0];
    e.target.value = "";
    if (!file || busy) return;
    stopLive();
    resetStore();
    $("sqPreviewBox").hidden = true;
    try {
      if (file.type === "application/pdf" || file.name.toLowerCase().endsWith(".pdf")) {
        setStatus("PDFを読み込んでいます…");
        await loadPdfJs();
        const pdf = await window.pdfjsLib.getDocument({ data: new Uint8Array(await file.arrayBuffer()) }).promise;
        if (pdf.numPages < 1) throw new Error("PDFにページがありません。");
        source = { kind: "pdf", pdf };
      } else if (file.type.startsWith("image/")) {
        source = { kind: "image", file };
      } else {
        setStatus("PDFまたは画像ファイルを選択してください。", "err");
        return;
      }
      await runScan();
    } catch (err) {
      console.error(err);
      setStatus("ファイルを処理できませんでした: " + ((err && err.message) || err), "err");
    }
  });

  $("sqTorch").addEventListener("click", async () => {
    if (!live.track) return;
    try {
      live.torchOn = !live.torchOn;
      await live.track.applyConstraints({ advanced: [{ torch: live.torchOn }] });
      $("sqTorch").textContent = live.torchOn ? "ライトを消す" : "ライト";
    } catch (e) { live.torchOn = false; $("sqTorch").hidden = true; }
  });
  $("sqZoom").addEventListener("input", async e => {
    if (!live.track) return;
    try { await live.track.applyConstraints({ advanced: [{ zoom: Number(e.target.value) }] }); } catch (err) { /* 非対応 */ }
  });

  document.addEventListener("keydown", e => { if (e.key === "Escape" && !$("sqModal").hidden) closeModal(true); });
  document.addEventListener("visibilitychange", () => {
    if (document.hidden && live.active) {
      stopLive();
      setStatus("カメラを停止しました。「最初からやり直す」で再開できます。", "warn");
    }
  });
  window.addEventListener("pagehide", stopLive);
  built = true;
}

function resetAll() {
  stopLive();
  resetStore();
  source = null;
  currentVals = null;
  $("sqResult").replaceChildren();
  setPhase("scan");
  $("sqPreviewBox").hidden = true;
  $("sqDiagBox").hidden = true;
  stats.frames = 0; stats.hitFrames = 0; stats.maxSyms = 0;
  $("sqBadges").replaceChildren();
  $("sqNotes").replaceChildren();
  $("sqConfirm").disabled = true;
  setStatus("読み取りを開始します。");
}

function openModal() {
  if (!built) buildModal();
  trigger = document.activeElement;
  $("sqModal").hidden = false;
  document.body.style.overflow = "hidden";
  resetAll();
  $("sqClose").focus();
  initEngine().catch(e => setStatus(engineMessage(e), "err"));
  loadModels();
  if (liveSupported()) {
    startLive();
  } else {
    setStatus(window.isSecureContext
      ? "このブラウザではライブ読み取りを使えません。「撮影して読み取り」を使ってください。"
      : "ライブ読み取りはHTTPSで開いたときだけ使えます。「撮影して読み取り」を使ってください。", "warn");
  }
}

function closeModal(returnFocus) {
  if (!built) return;
  stopLive();
  currentVals = null;
  $("sqResult").replaceChildren();   // メーカー名など一時表示の内容を残さない
  $("sqModal").hidden = true;
  document.body.style.overflow = "";
  if (returnFocus && trigger && trigger.focus) { try { trigger.focus(); } catch (e) { /* noop */ } }
}

// ---- 起動 ----
const btn = document.getElementById("btnScanQr");
if (btn) btn.addEventListener("click", openModal);
else console.warn("[ShakenQR] #btnScanQr が見つかりません");

window.ShakenQR = { version: VERSION, open: openModal, close: () => closeModal(true), _t: { eraOf, hvFromEngine, toFormValues, buildModelIndex, lookupModel } };

})();
