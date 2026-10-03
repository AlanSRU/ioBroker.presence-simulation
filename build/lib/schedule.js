"use strict";
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);
var schedule_exports = {};
__export(schedule_exports, {
  MIN_GAP_MS: () => MIN_GAP_MS,
  isReplayable: () => isReplayable,
  planWindow: () => planWindow,
  valueAt: () => valueAt
});
module.exports = __toCommonJS(schedule_exports);
const MIN_GAP_MS = 1e3;
function isReplayable(val) {
  return typeof val === "boolean" || typeof val === "string" || typeof val === "number" && Number.isFinite(val);
}
function valueAt(entries, t) {
  let best;
  for (const e of entries) {
    if (e.ts <= t && isReplayable(e.val) && (!best || e.ts > best.ts)) {
      best = e;
    }
  }
  return best == null ? void 0 : best.val;
}
function planWindow(id, entries, windowStart, windowEnd, lastValue, opts) {
  var _a, _b;
  const random = (_a = opts.random) != null ? _a : Math.random;
  const notBefore = (_b = opts.notBefore) != null ? _b : opts.now;
  const sorted = entries.filter((e) => e.ts > windowStart && e.ts <= windowEnd && isReplayable(e.val)).sort((a, b) => a.ts - b.ts);
  const actions = [];
  let previousVal = lastValue;
  let previousAt = -Infinity;
  for (const e of sorted) {
    if (e.val === previousVal) {
      continue;
    }
    const shift = opts.jitterMs > 0 ? Math.round((random() * 2 - 1) * opts.jitterMs) : 0;
    const at = Math.max(e.ts + opts.deltaMs + shift, notBefore, previousAt + MIN_GAP_MS);
    actions.push({ id, at, val: e.val, recordedAt: e.ts });
    previousVal = e.val;
    previousAt = at;
  }
  return actions;
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  MIN_GAP_MS,
  isReplayable,
  planWindow,
  valueAt
});
//# sourceMappingURL=schedule.js.map
