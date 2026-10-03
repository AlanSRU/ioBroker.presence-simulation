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
var config_exports = {};
__export(config_exports, {
  LIMITS: () => LIMITS,
  clampNumber: () => clampNumber,
  isInstanceId: () => isInstanceId,
  matchesTrigger: () => matchesTrigger,
  readSettings: () => readSettings
});
module.exports = __toCommonJS(config_exports);
const LIMITS = {
  days: { min: 1, max: 28, def: 7 },
  jitterSec: { min: 0, max: 1800, def: 300 }
};
const DAY_MS = 24 * 60 * 60 * 1e3;
function clampNumber(raw, limits) {
  const n = typeof raw === "number" ? raw : typeof raw === "string" && raw.trim() !== "" ? Number(raw) : NaN;
  if (!Number.isFinite(n)) {
    return limits.def;
  }
  return Math.min(limits.max, Math.max(limits.min, Math.round(n)));
}
function isInstanceId(s) {
  return typeof s === "string" && /^[a-z0-9_-]+\.\d+$/.test(s);
}
function readSettings(native) {
  const rows = Array.isArray(native.states) ? native.states : [];
  const seen = /* @__PURE__ */ new Set();
  const states = [];
  for (const row of rows) {
    const id = typeof (row == null ? void 0 : row.id) === "string" ? row.id.trim() : "";
    if (!id || row.enabled === false || seen.has(id)) {
      continue;
    }
    seen.add(id);
    states.push({ id, name: typeof row.name === "string" && row.name.trim() ? row.name.trim() : id });
  }
  return {
    states,
    historyInstance: isInstanceId(native.historyInstance) ? native.historyInstance : "",
    deltaMs: clampNumber(native.days, LIMITS.days) * DAY_MS,
    jitterMs: clampNumber(native.jitter, LIMITS.jitterSec) * 1e3,
    restore: native.restore !== false,
    triggerId: typeof native.triggerId === "string" ? native.triggerId.trim() : "",
    triggerValue: typeof native.triggerValue === "string" ? native.triggerValue.trim() : ""
  };
}
function matchesTrigger(val, wanted) {
  if (wanted === "" || !(typeof val === "string" || typeof val === "number" || typeof val === "boolean")) {
    return false;
  }
  return String(val).trim().toLowerCase() === wanted.toLowerCase();
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  LIMITS,
  clampNumber,
  isInstanceId,
  matchesTrigger,
  readSettings
});
//# sourceMappingURL=config.js.map
