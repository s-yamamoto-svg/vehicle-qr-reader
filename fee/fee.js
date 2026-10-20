/* お客様向けモデル料金の表示(ロングラン補償申込フォーム組み込み用) v1.0.0
   料金表(fees.json)をこのファイルと同じ場所から読み込み、入力内容に合う行を引いて表示します。
   料金表は「お客様向けモデル料金」(仕切料金は含みません)。表示は目安で、確定は申込内容の確認後です。 */
(function () {
"use strict";
const VERSION = "1.0.0";
const DATA_VERSION = "20261020-1";
const ERA_BASE = { "令和": 2018, "平成": 1988 };   // 令和N年 = 2018+N / 平成N年 = 1988+N
const CLASSES = {
  "乗用": [["乗用", "乗用(国産車)"], ["外車", "外車"]],
  "貨物": [["貨物（その1）", "貨物(その1)"], ["貨物（その2）", "貨物(その2)"]]
};

// ---- 計算部分(画面に依存しない。単体テストできる) ----
function elapsedMonths(regYear, regMonth, startDate) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(startDate || "");
  if (!m || !regYear || !regMonth) return null;
  return (Number(m[1]) - regYear) * 12 + (Number(m[2]) - regMonth);   // 暦月の差(日は見ない)
}
// rows: [id, class, hv, period, mFrom, mTo, kmFrom, kmTo, ccFrom, ccTo, price]
function lookup(rows, q) {
  const hit = rows.filter(r => r[1] === q.cls && r[2] === q.hv && r[3] === q.period &&
    q.months >= r[4] && q.months <= r[5] && q.km >= r[6] && q.km <= r[7] && q.cc >= r[8] && q.cc <= r[9]);
  if (hit.length === 1) return { status: "ok", price: hit[0][10], id: hit[0][0] };
  return { status: hit.length ? "multi" : "none" };
}
const api = { VERSION, elapsedMonths, lookup, ERA_BASE, CLASSES };
if (typeof module !== "undefined" && module.exports) { module.exports = api; return; }
window.FeeCalc = api;

// ---- 画面部分 ----
const BASE = (function () { try { return new URL(".", document.currentScript.src).href; } catch (e) { return ""; } })();
const $ = id => document.getElementById(id);
let data = null, loadError = "", last = null;
const yen = n => Number(n).toLocaleString("ja-JP") + "円";

const CSS = ".fee-box{margin-top:12px;padding:12px 14px;border:1px solid #cfd8e0;border-radius:8px;background:#f3f7fb}" +
  ".fee-head{font-size:12.5px;font-weight:700;color:#124D82}" +
  ".fee-amount{margin:2px 0;font-size:26px;font-weight:700;color:#124D82;line-height:1.3}" +
  ".fee-amount.pending{font-size:14px;font-weight:500;color:#5c6874}" +
  ".fee-amount.ng{font-size:14px;font-weight:600;color:#b3261e}" +
  ".fee-note{font-size:12px;line-height:1.6;color:#5c6874}";

function build() {
  const period = $("f_period"), usage = $("f_usage");
  if (!period || !usage || $("f_class")) return false;
  const st = document.createElement("style"); st.textContent = CSS; document.head.append(st);
  const wrap = document.createElement("div");
  wrap.className = "field full";
  wrap.innerHTML =
    '<label for="f_class">車両区分</label><select id="f_class" name="vehicle_class"></select>' +
    '<div class="fee-box" id="feeBox" aria-live="polite">' +
      '<div class="fee-head">お客様向けモデル料金</div>' +
      '<div class="fee-amount pending" id="feeAmount"></div>' +
      '<div class="fee-note" id="feeDetail"></div>' +
      '<div class="fee-note">表示金額は、お客様へご案内するモデル料金(目安)です。ご契約の金額は、申込内容の確認後に確定します。</div>' +
    '</div>' +
    '<input type="hidden" id="f_fee_price" name="fee_model_price"><input type="hidden" id="f_fee_version" name="fee_table_version">';
  period.closest(".field").after(wrap);
  fillClasses();
  usage.addEventListener("change", () => { fillClasses(); recalc(); });
  const form = $("applicationForm") || document;
  form.addEventListener("input", recalc);
  form.addEventListener("change", recalc);
  return true;
}
function fillClasses() {
  const s = $("f_class"), list = CLASSES[$("f_usage").value] || [];
  s.innerHTML = "";
  const ph = document.createElement("option"); ph.value = ""; ph.textContent = "選択してください"; s.append(ph);
  list.forEach(([v, t]) => { const o = document.createElement("option"); o.value = v; o.textContent = t; s.append(o); });
}
function gather() {
  const val = id => (($(id) || {}).value || "").trim();
  const era = val("f_era"), y = Number(val("f_year")), mo = Number(val("f_month"));
  const missing = [];
  if (!val("f_class")) missing.push("車両区分");
  const regYear = ERA_BASE[era] && y >= 1 ? ERA_BASE[era] + y : null;
  if (!regYear || !(mo >= 1 && mo <= 12)) missing.push("初度登録年月");
  if (!val("f_startdate")) missing.push("保証開始日");
  if (val("f_mileage") === "") missing.push("走行距離");
  if (val("f_displacement") === "") missing.push("排気量");
  return {
    missing, cls: val("f_class"), hv: val("f_hv") === "はい" ? 1 : 0, period: parseInt(val("f_period"), 10),
    km: Number(val("f_mileage")), cc: Number(val("f_displacement")),
    months: elapsedMonths(regYear, mo, val("f_startdate"))
  };
}
function setAmount(text, cls) { const a = $("feeAmount"); a.textContent = text; a.className = "fee-amount" + (cls ? " " + cls : ""); }
function recalc() {
  if (!$("feeAmount")) return;
  last = null; $("f_fee_price").value = ""; $("f_fee_version").value = "";
  $("feeDetail").textContent = "";
  if (loadError) { setAmount("料金表を読み込めませんでした", "ng"); $("feeDetail").textContent = loadError; return; }
  if (!data) { setAmount("料金表を読み込み中です…", "pending"); return; }
  const q = gather();
  if (q.missing.length) { setAmount("入力すると表示されます", "pending"); $("feeDetail").textContent = "未入力: " + q.missing.join("、"); return; }
  if (q.months < 0) { setAmount("保証開始日が初度登録より前です", "ng"); $("feeDetail").textContent = "初度登録年月と保証開始日をご確認ください。"; return; }
  const r = lookup(data.rows, q);
  if (r.status !== "ok") {
    setAmount("料金表に該当がありません", "ng");
    $("feeDetail").textContent = "経過" + q.months + "か月 / " + q.km.toLocaleString("ja-JP") + "km / " + q.cc + "cc の組み合わせは、料金表の対象外です。受付までお問い合わせください。";
    return;
  }
  last = { price: r.price, q };
  setAmount(yen(r.price));
  $("feeDetail").textContent = "条件: 経過" + q.months + "か月 / " + q.km.toLocaleString("ja-JP") + "km / " + q.cc + "cc / HV" + (q.hv ? "あり" : "なし") + " / " + q.period + "ヶ月";
  $("f_fee_price").value = String(r.price);
  $("f_fee_version").value = data.version;
}
// 確認画面用
api.confirmText = function () {
  if (!last) return "";
  return "車両区分：" + $("f_class").selectedOptions[0].textContent + "\nお客様向けモデル料金(目安)：" + yen(last.price) + "\n";
};
api.state = () => ({ loaded: !!data, error: loadError, last });

async function init() {
  if (!build()) return;
  recalc();
  try {
    const res = await fetch(BASE + "fees.json?v=" + DATA_VERSION);
    if (!res.ok) throw new Error("HTTP " + res.status);
    data = await res.json();
    if (!data || !Array.isArray(data.rows)) throw new Error("形式が不正です");
  } catch (e) { loadError = "(" + ((e && e.message) || e) + ")"; }
  recalc();
}
if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init); else init();
})();
