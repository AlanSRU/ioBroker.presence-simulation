"use strict";
var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));
var utils = __toESM(require("@iobroker/adapter-core"));
var import_config = require("./lib/config");
var import_format = require("./lib/format");
var import_schedule = require("./lib/schedule");
const LOOKAHEAD_MS = 15 * 60 * 1e3;
const REFILL_MS = 10 * 60 * 1e3;
const MAX_ACTIONS_PER_WINDOW = 120;
const HISTORY_TIMEOUT_MS = 15e3;
class PresenceSimulation extends utils.Adapter {
  settings;
  running = false;
  unloaded = false;
  timers = /* @__PURE__ */ new Set();
  refillTimer;
  /** Recorded-time position up to which history has been planned. */
  cursor = 0;
  /** The value each state is currently replaying (to drop repeats across windows). */
  replaying = /* @__PURE__ */ new Map();
  pending = [];
  constructor(options = {}) {
    super({ ...options, name: "presence-simulation" });
    this.on("ready", this.onReady.bind(this));
    this.on("stateChange", this.onStateChange.bind(this));
    this.on("unload", this.onUnload.bind(this));
  }
  async onReady() {
    this.settings = (0, import_config.readSettings)(this.config);
    await this.createObjects();
    if (this.unloaded) {
      return;
    }
    this.subscribeStates("active");
    if (!this.settings.historyInstance) {
      await this.setStatus("No history instance selected in the settings");
      this.log.warn("No history instance selected: choose one in the instance settings.");
      return;
    }
    if (!this.settings.states.length) {
      await this.setStatus("No states selected in the settings");
      this.log.warn("No states to simulate: add them in the instance settings.");
      return;
    }
    await this.checkHistoryLogging();
    const active = await this.getStateAsync("active");
    if ((active == null ? void 0 : active.val) === true) {
      this.log.info("Simulation was active before the restart: resuming");
      await this.startSimulation(true);
    } else {
      await this.setStatus("Idle");
    }
    if (this.settings.triggerId) {
      this.subscribeForeignStates(this.settings.triggerId);
      const trig = await this.getForeignStateAsync(this.settings.triggerId);
      if (!this.running && trig && (0, import_config.matchesTrigger)(trig.val, this.settings.triggerValue)) {
        this.log.info(`${this.settings.triggerId} is "${String(trig.val)}": starting the simulation`);
        await this.startSimulation(false);
      }
    }
  }
  /** Creates or updates the adapter's own objects (extendObject keeps metadata current on upgrades). */
  async createObjects() {
    await this.extendObject("active", {
      type: "state",
      common: {
        name: {
          en: "Simulation active",
          de: "Simulation aktiv",
          ru: "\u0421\u0438\u043C\u0443\u043B\u044F\u0446\u0438\u044F \u0430\u043A\u0442\u0438\u0432\u043D\u0430",
          pt: "Simula\xE7\xE3o ativa",
          nl: "Simulatie actief",
          fr: "Simulation active",
          it: "Simulazione attiva",
          es: "Simulaci\xF3n activa",
          pl: "Symulacja aktywna",
          uk: "\u0421\u0438\u043C\u0443\u043B\u044F\u0446\u0456\u044F \u0430\u043A\u0442\u0438\u0432\u043D\u0430",
          "zh-cn": "\u6A21\u62DF\u5DF2\u542F\u7528"
        },
        type: "boolean",
        role: "switch.enable",
        read: true,
        write: true,
        def: false
      },
      native: {}
    });
    await this.extendObject("info", {
      type: "channel",
      common: {
        name: {
          en: "Information",
          de: "Informationen",
          ru: "\u0418\u043D\u0444\u043E\u0440\u043C\u0430\u0446\u0438\u044F",
          pt: "Informa\xE7\xE3o",
          nl: "Informatie",
          fr: "Informations",
          it: "Informazioni",
          es: "Informaci\xF3n",
          pl: "Informacje",
          uk: "\u0406\u043D\u0444\u043E\u0440\u043C\u0430\u0446\u0456\u044F",
          "zh-cn": "\u4FE1\u606F"
        }
      },
      native: {}
    });
    const text = (en, de, ru, pt, nl, fr, it, es, pl, uk, zh) => ({
      name: { en, de, ru, pt, nl, fr, it, es, pl, uk, "zh-cn": zh },
      type: "string",
      role: "text",
      read: true,
      write: false,
      def: ""
    });
    await this.extendObject("info.status", {
      type: "state",
      common: text(
        "Status",
        "Status",
        "\u0421\u0442\u0430\u0442\u0443\u0441",
        "Estado",
        "Status",
        "Statut",
        "Stato",
        "Estado",
        "Status",
        "\u0421\u0442\u0430\u0442\u0443\u0441",
        "\u72B6\u6001"
      ),
      native: {}
    });
    await this.extendObject("info.lastAction", {
      type: "state",
      common: text(
        "Last action",
        "Letzte Aktion",
        "\u041F\u043E\u0441\u043B\u0435\u0434\u043D\u0435\u0435 \u0434\u0435\u0439\u0441\u0442\u0432\u0438\u0435",
        "\xDAltima a\xE7\xE3o",
        "Laatste actie",
        "Derni\xE8re action",
        "Ultima azione",
        "\xDAltima acci\xF3n",
        "Ostatnia akcja",
        "\u041E\u0441\u0442\u0430\u043D\u043D\u044F \u0434\u0456\u044F",
        "\u4E0A\u4E00\u4E2A\u52A8\u4F5C"
      ),
      native: {}
    });
    await this.extendObject("info.nextAction", {
      type: "state",
      common: text(
        "Next action",
        "N\xE4chste Aktion",
        "\u0421\u043B\u0435\u0434\u0443\u044E\u0449\u0435\u0435 \u0434\u0435\u0439\u0441\u0442\u0432\u0438\u0435",
        "Pr\xF3xima a\xE7\xE3o",
        "Volgende actie",
        "Prochaine action",
        "Prossima azione",
        "Pr\xF3xima acci\xF3n",
        "Nast\u0119pna akcja",
        "\u041D\u0430\u0441\u0442\u0443\u043F\u043D\u0430 \u0434\u0456\u044F",
        "\u4E0B\u4E00\u4E2A\u52A8\u4F5C"
      ),
      native: {}
    });
    await this.extendObject("info.savedStates", {
      type: "state",
      common: {
        ...text(
          "States saved at start",
          "Beim Start gespeicherte Zust\xE4nde",
          "\u0421\u043E\u0441\u0442\u043E\u044F\u043D\u0438\u044F, \u0441\u043E\u0445\u0440\u0430\u043D\u0451\u043D\u043D\u044B\u0435 \u043F\u0440\u0438 \u0437\u0430\u043F\u0443\u0441\u043A\u0435",
          "Estados guardados no in\xEDcio",
          "Bij start opgeslagen toestanden",
          "\xC9tats enregistr\xE9s au d\xE9marrage",
          "Stati salvati all'avvio",
          "Estados guardados al inicio",
          "Stany zapisane przy starcie",
          "\u0421\u0442\u0430\u043D\u0438, \u0437\u0431\u0435\u0440\u0435\u0436\u0435\u043D\u0456 \u043F\u0456\u0434 \u0447\u0430\u0441 \u0437\u0430\u043F\u0443\u0441\u043A\u0443",
          "\u542F\u52A8\u65F6\u4FDD\u5B58\u7684\u72B6\u6001"
        ),
        role: "json"
      },
      native: {}
    });
  }
  async onStateChange(id, state) {
    if (!state || this.unloaded) {
      return;
    }
    if (id === `${this.namespace}.active`) {
      if (state.ack) {
        return;
      }
      if (state.val === true) {
        await this.startSimulation(false);
      } else {
        await this.stopSimulation("switched off");
      }
      return;
    }
    if (id === this.settings.triggerId && state.ack) {
      const away = (0, import_config.matchesTrigger)(state.val, this.settings.triggerValue);
      if (away && !this.running) {
        this.log.info(`${id} changed to "${String(state.val)}": starting the simulation`);
        await this.startSimulation(false);
      } else if (!away && this.running) {
        this.log.info(`${id} changed to "${String(state.val)}": stopping the simulation`);
        await this.stopSimulation("trigger");
      }
    }
  }
  /**
   * Starts (or resumes) the replay.
   *
   * @param resume - true after an adapter restart: keep the states saved at the original start
   */
  async startSimulation(resume) {
    if (this.running || this.unloaded) {
      return;
    }
    if (!this.settings.historyInstance || !this.settings.states.length) {
      await this.setState("active", false, true);
      return;
    }
    this.running = true;
    await this.setState("active", true, true);
    const saved = await this.getStateAsync("info.savedStates");
    if (!resume || !(saved == null ? void 0 : saved.val)) {
      const snapshot = {};
      for (const s of this.settings.states) {
        const st = await this.getForeignStateAsync(s.id);
        if (st && (0, import_schedule.isReplayable)(st.val)) {
          snapshot[s.id] = st.val;
        }
      }
      await this.setState("info.savedStates", JSON.stringify(snapshot), true);
    }
    if (this.unloaded || !this.running) {
      return;
    }
    const recordedNow = Date.now() - this.settings.deltaMs;
    this.replaying.clear();
    for (const s of this.settings.states) {
      const before = await this.history(s.id, { end: recordedNow, count: 1, returnNewestEntries: true });
      const val = (0, import_schedule.valueAt)(before, recordedNow);
      if (val !== void 0) {
        this.replaying.set(s.id, val);
        await this.write(s.id, val, "initial state");
      }
      if (this.unloaded || !this.running) {
        return;
      }
    }
    this.cursor = recordedNow;
    await this.planAhead();
    this.log.info(
      `Simulation started: replaying ${this.settings.states.length} state(s) from ${this.settings.deltaMs / 864e5} day(s) ago`
    );
  }
  /** Reads the next window of history, schedules it, and re-arms itself. */
  async planAhead() {
    if (!this.running || this.unloaded) {
      return;
    }
    const now = Date.now();
    const windowStart = this.cursor;
    const windowEnd = now - this.settings.deltaMs + LOOKAHEAD_MS;
    if (windowEnd > windowStart) {
      for (const s of this.settings.states) {
        const entries = await this.history(s.id, { start: windowStart, end: windowEnd });
        if (!this.running || this.unloaded) {
          return;
        }
        let actions = (0, import_schedule.planWindow)(s.id, entries, windowStart, windowEnd, this.replaying.get(s.id), {
          deltaMs: this.settings.deltaMs,
          jitterMs: this.settings.jitterMs,
          now
        });
        if (actions.length > MAX_ACTIONS_PER_WINDOW) {
          this.log.warn(
            `${s.id} changed ${actions.length} times in 15 minutes of history: replaying the first ${MAX_ACTIONS_PER_WINDOW}`
          );
          actions = actions.slice(0, MAX_ACTIONS_PER_WINDOW);
        }
        if (actions.length) {
          this.replaying.set(s.id, actions[actions.length - 1].val);
        }
        for (const a of actions) {
          this.schedule(a);
        }
      }
      this.cursor = windowEnd;
    }
    await this.updateStatus();
    this.refillTimer = this.setTimeout(() => {
      this.refillTimer = void 0;
      void this.planAhead();
    }, REFILL_MS);
  }
  schedule(a) {
    this.pending.push(a);
    const timer = this.setTimeout(
      () => {
        if (timer) {
          this.timers.delete(timer);
        }
        this.pending = this.pending.filter((p) => p !== a);
        void this.write(a.id, a.val, `as on ${(0, import_format.dateTime)(a.recordedAt)}`).then(() => this.updateStatus());
      },
      Math.max(0, a.at - Date.now())
    );
    if (timer) {
      this.timers.add(timer);
    }
  }
  /**
   * Stops the replay and, if configured, restores the states saved at the start.
   *
   * @param reason - for the log
   */
  async stopSimulation(reason) {
    const wasRunning = this.running;
    this.running = false;
    this.clearTimers();
    if (this.unloaded) {
      return;
    }
    const saved = await this.getStateAsync("info.savedStates");
    if (wasRunning || (saved == null ? void 0 : saved.val)) {
      if (this.settings.restore && typeof (saved == null ? void 0 : saved.val) === "string" && saved.val) {
        try {
          const snapshot = JSON.parse(saved.val);
          for (const [id, val] of Object.entries(snapshot)) {
            if (this.settings.states.some((s) => s.id === id)) {
              await this.write(id, val, "restored");
            }
          }
        } catch {
          this.log.warn("The saved states could not be read, so nothing was restored");
        }
      }
      this.log.info(`Simulation stopped (${reason})`);
    }
    await this.setState("info.savedStates", "", true);
    await this.setState("info.nextAction", "", true);
    await this.setState("active", false, true);
    await this.setStatus("Idle");
  }
  /**
   * Writes a foreign state as a command (ack false), skipping it if it already has that value.
   *
   * @param id - state id
   * @param val - value to write
   * @param why - for the log and info.lastAction
   */
  async write(id, val, why) {
    var _a, _b;
    if (this.unloaded) {
      return;
    }
    try {
      const current = await this.getForeignStateAsync(id);
      if ((current == null ? void 0 : current.val) === val) {
        return;
      }
      await this.setForeignStateAsync(id, val, false);
      const name = (_b = (_a = this.settings.states.find((s) => s.id === id)) == null ? void 0 : _a.name) != null ? _b : id;
      this.log.debug(`${name} \u2192 ${String(val)} (${why})`);
      await this.setState("info.lastAction", `${(0, import_format.clock)(Date.now())} ${name} \u2192 ${String(val)} (${why})`, true);
    } catch (e) {
      this.log.warn(`Could not set ${id}: ${e.message}`);
    }
  }
  /**
   * Reads history for one state through the configured history instance.
   *
   * @param id - state id
   * @param options - getHistory options (start/end/count/…)
   */
  async history(id, options) {
    var _a;
    try {
      const res = await this.sendToAsync(
        this.settings.historyInstance,
        "getHistory",
        { id, options: { aggregate: "none", ignoreNull: true, ...options } },
        { timeout: HISTORY_TIMEOUT_MS }
      );
      if (res == null ? void 0 : res.error) {
        this.log.warn(`History for ${id} could not be read: ${res.error}`);
        return [];
      }
      return ((_a = res == null ? void 0 : res.result) != null ? _a : []).filter((e) => typeof (e == null ? void 0 : e.ts) === "number" && (0, import_schedule.isReplayable)(e.val)).map((e) => ({ ts: e.ts, val: e.val }));
    } catch (e) {
      this.log.warn(
        `History for ${id} could not be read from ${this.settings.historyInstance}: ${e.message}`
      );
      return [];
    }
  }
  /** Warns about selected states that the chosen history instance is not recording. */
  async checkHistoryLogging() {
    var _a, _b;
    const missing = [];
    for (const s of this.settings.states) {
      const obj = await this.getForeignObjectAsync(s.id);
      if (!obj) {
        missing.push(`${s.name} (state not found)`);
        continue;
      }
      const custom = (_b = (_a = obj.common) == null ? void 0 : _a.custom) == null ? void 0 : _b[this.settings.historyInstance];
      if (!(custom == null ? void 0 : custom.enabled)) {
        missing.push(s.name);
      }
    }
    if (missing.length) {
      this.log.warn(
        `${this.settings.historyInstance} is not recording: ${missing.join(", ")}. Enable logging for them in the Objects tab, or they cannot be replayed.`
      );
    }
  }
  async updateStatus() {
    var _a, _b;
    if (!this.running) {
      return;
    }
    const next = [...this.pending].sort((a, b) => a.at - b.at)[0];
    const nextText = next ? `${(0, import_format.clock)(next.at)} ${(_b = (_a = this.settings.states.find((s) => s.id === next.id)) == null ? void 0 : _a.name) != null ? _b : next.id} \u2192 ${String(next.val)}` : "";
    await this.setState("info.nextAction", nextText, true);
    await this.setStatus(`Running: replaying ${this.settings.deltaMs / 864e5} day(s) ago`);
  }
  async setStatus(text) {
    if (!this.unloaded) {
      await this.setState("info.status", text, true);
    }
  }
  clearTimers() {
    for (const t of this.timers) {
      this.clearTimeout(t);
    }
    this.timers.clear();
    this.pending = [];
    if (this.refillTimer) {
      this.clearTimeout(this.refillTimer);
      this.refillTimer = void 0;
    }
  }
  onUnload(callback) {
    this.unloaded = true;
    try {
      this.running = false;
      this.clearTimers();
      callback();
    } catch {
      callback();
    }
  }
}
if (require.main !== module) {
  module.exports = (options) => new PresenceSimulation(options);
} else {
  (() => new PresenceSimulation())();
}
//# sourceMappingURL=main.js.map
