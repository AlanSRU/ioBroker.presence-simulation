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
  /** When the last action of each state is scheduled, so the next window keeps the order. */
  lastAt = /* @__PURE__ */ new Map();
  /** Whether the trigger state currently means "away" (undefined until first read). */
  triggerAway;
  /** Set while the history instance cannot be read, so the failure is logged once. */
  historyFailing = false;
  /** Increases on every start and stop; a run's async steps stop when it no longer matches. */
  run = 0;
  constructor(options = {}) {
    super({ ...options, name: "presence-simulation" });
    this.on("ready", this.onReady.bind(this));
    this.on("stateChange", this.onStateChange.bind(this));
    this.on("unload", this.onUnload.bind(this));
  }
  async onReady() {
    var _a, _b;
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
    if (this.settings.triggerId) {
      if (!this.settings.triggerValue) {
        this.log.warn("A start state is set but no value for it: the simulation will not start automatically.");
      }
      this.subscribeForeignStates(this.settings.triggerId);
      const trig = await this.getForeignStateAsync(this.settings.triggerId);
      this.triggerAway = (0, import_config.matchesTrigger)(trig == null ? void 0 : trig.val, this.settings.triggerValue);
    }
    if (this.unloaded) {
      return;
    }
    const active = await this.getStateAsync("active");
    if ((active == null ? void 0 : active.val) === true) {
      const startedBy = (_a = await this.getStateAsync("info.startedBy")) == null ? void 0 : _a.val;
      if (startedBy === "trigger" && this.settings.triggerId && !this.triggerAway) {
        this.log.info(
          `${this.settings.triggerId} no longer means away: stopping the simulation started before the restart`
        );
        await this.stopSimulation("home again while stopped");
      } else {
        this.log.info("Simulation was active before the restart: resuming");
        await this.startSimulation(true, startedBy === "trigger" ? "trigger" : "manual");
      }
    } else {
      await this.setStatus("Idle");
    }
    const heldOff = ((_b = await this.getStateAsync("info.heldOff")) == null ? void 0 : _b.val) === true;
    if (heldOff && !this.triggerAway) {
      await this.setState("info.heldOff", false, true);
    } else if (!this.running && this.triggerAway && !heldOff) {
      this.log.info(`${this.settings.triggerId} means away: starting the simulation`);
      await this.startSimulation(false, "trigger");
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
    await this.extendObject("info.startedBy", {
      type: "state",
      common: {
        ...text(
          "Started by (trigger or manual)",
          "Gestartet durch (Ausl\xF6ser oder manuell)",
          "\u0417\u0430\u043F\u0443\u0449\u0435\u043D\u043E (\u0442\u0440\u0438\u0433\u0433\u0435\u0440\u043E\u043C \u0438\u043B\u0438 \u0432\u0440\u0443\u0447\u043D\u0443\u044E)",
          "Iniciado por (gatilho ou manual)",
          "Gestart door (trigger of handmatig)",
          "D\xE9marr\xE9 par (d\xE9clencheur ou manuel)",
          "Avviato da (trigger o manuale)",
          "Iniciado por (disparador o manual)",
          "Uruchomione przez (wyzwalacz lub r\u0119cznie)",
          "\u0417\u0430\u043F\u0443\u0449\u0435\u043D\u043E (\u0442\u0440\u0438\u0433\u0435\u0440\u043E\u043C \u0430\u0431\u043E \u0432\u0440\u0443\u0447\u043D\u0443)",
          "\u542F\u52A8\u65B9\u5F0F\uFF08\u89E6\u53D1\u5668\u6216\u624B\u52A8\uFF09"
        ),
        states: { trigger: "trigger", manual: "manual" }
      },
      native: {}
    });
    await this.extendObject("info.heldOff", {
      type: "state",
      common: {
        name: {
          en: "Switched off while away (waits until home and away again)",
          de: "W\xE4hrend der Abwesenheit ausgeschaltet (wartet bis zur n\xE4chsten Abwesenheit)",
          ru: "\u0412\u044B\u043A\u043B\u044E\u0447\u0435\u043D\u043E \u0432\u043E \u0432\u0440\u0435\u043C\u044F \u043E\u0442\u0441\u0443\u0442\u0441\u0442\u0432\u0438\u044F (\u0436\u0434\u0451\u0442 \u0441\u043B\u0435\u0434\u0443\u044E\u0449\u0435\u0433\u043E \u0443\u0445\u043E\u0434\u0430)",
          pt: "Desligado durante a aus\xEAncia (aguarda a pr\xF3xima aus\xEAncia)",
          nl: "Uitgeschakeld tijdens afwezigheid (wacht op de volgende afwezigheid)",
          fr: "Arr\xEAt\xE9 pendant l'absence (attend la prochaine absence)",
          it: "Spento durante l'assenza (attende la prossima assenza)",
          es: "Apagado durante la ausencia (espera a la pr\xF3xima ausencia)",
          pl: "Wy\u0142\u0105czone podczas nieobecno\u015Bci (czeka na nast\u0119pn\u0105 nieobecno\u015B\u0107)",
          uk: "\u0412\u0438\u043C\u043A\u043D\u0435\u043D\u043E \u043F\u0456\u0434 \u0447\u0430\u0441 \u0432\u0456\u0434\u0441\u0443\u0442\u043D\u043E\u0441\u0442\u0456 (\u0447\u0435\u043A\u0430\u0454 \u043D\u0430\u0441\u0442\u0443\u043F\u043D\u043E\u0433\u043E \u0432\u0456\u0434'\u0457\u0437\u0434\u0443)",
          "zh-cn": "\u79BB\u5BB6\u65F6\u5DF2\u5173\u95ED\uFF08\u7B49\u5F85\u4E0B\u6B21\u79BB\u5BB6\uFF09"
        },
        type: "boolean",
        role: "indicator",
        read: true,
        write: false,
        def: false
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
        await this.setState("info.heldOff", false, true);
        if (this.running) {
          await this.setState("active", true, true);
        } else {
          await this.startSimulation(false, "manual");
        }
      } else {
        if (this.triggerAway) {
          await this.setState("info.heldOff", true, true);
        }
        await this.stopSimulation("switched off");
      }
      return;
    }
    const ownedByUser = id.startsWith("0_userdata.") || id.startsWith("javascript.");
    if (id === this.settings.triggerId && (state.ack || ownedByUser)) {
      const away = (0, import_config.matchesTrigger)(state.val, this.settings.triggerValue);
      if (away === this.triggerAway) {
        return;
      }
      this.triggerAway = away;
      if (!away) {
        await this.setState("info.heldOff", false, true);
      }
      if (away && !this.running) {
        this.log.info(`${id} changed to "${String(state.val)}": starting the simulation`);
        await this.startSimulation(false, "trigger");
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
   * @param by - what started it; a trigger-started run is stopped on resume if the trigger no longer means away
   */
  async startSimulation(resume, by) {
    if (this.running || this.unloaded) {
      return;
    }
    if (!this.settings.historyInstance || !this.settings.states.length) {
      await this.setState("active", false, true);
      return;
    }
    this.running = true;
    const run = ++this.run;
    await this.setState("active", true, true);
    await this.setState("info.startedBy", by, true);
    const saved = await this.getStateAsync("info.savedStates");
    if (!resume || !(saved == null ? void 0 : saved.val)) {
      const snapshot = {};
      for (const s of this.settings.states) {
        const st = await this.getForeignStateAsync(s.id);
        if (st && (0, import_schedule.isReplayable)(st.val)) {
          snapshot[s.id] = st.val;
        }
      }
      if (this.unloaded || run !== this.run) {
        return;
      }
      await this.setState("info.savedStates", JSON.stringify(snapshot), true);
    }
    if (this.unloaded || run !== this.run) {
      return;
    }
    const recordedNow = Date.now() - this.settings.deltaMs;
    this.replaying.clear();
    this.lastAt.clear();
    for (const s of this.settings.states) {
      const before = await this.history(s.id, { end: recordedNow, count: 1, returnNewestEntries: true });
      const val = (0, import_schedule.valueAt)(before, recordedNow);
      if (val !== void 0 && run === this.run) {
        this.replaying.set(s.id, val);
        this.lastAt.set(s.id, Date.now());
        await this.write(s.id, val, "initial state");
      }
      if (this.unloaded || run !== this.run) {
        return;
      }
    }
    this.cursor = recordedNow;
    await this.planAhead(run);
    this.log.info(
      `Simulation started: replaying ${this.settings.states.length} state(s) from ${this.settings.deltaMs / 864e5} day(s) ago`
    );
  }
  /**
   * Reads the next window of history, schedules it, and re-arms itself.
   *
   * @param run - the run this belongs to; a stop or restart in the meantime ends it
   */
  async planAhead(run) {
    if (run !== this.run || this.unloaded) {
      return;
    }
    const now = Date.now();
    const windowStart = this.cursor;
    const windowEnd = now - this.settings.deltaMs + LOOKAHEAD_MS;
    if (windowEnd > windowStart) {
      for (const s of this.settings.states) {
        const entries = await this.history(s.id, { start: windowStart, end: windowEnd });
        if (run !== this.run || this.unloaded) {
          return;
        }
        let actions = (0, import_schedule.planWindow)(s.id, entries, windowStart, windowEnd, this.replaying.get(s.id), {
          deltaMs: this.settings.deltaMs,
          jitterMs: this.settings.jitterMs,
          now,
          after: this.lastAt.get(s.id)
        });
        if (actions.length > MAX_ACTIONS_PER_WINDOW) {
          this.log.warn(
            `${s.id} changed ${actions.length} times in 15 minutes of history: replaying the first ${MAX_ACTIONS_PER_WINDOW}`
          );
          actions = actions.slice(0, MAX_ACTIONS_PER_WINDOW);
        }
        if (actions.length) {
          const last = actions[actions.length - 1];
          this.replaying.set(s.id, last.val);
          this.lastAt.set(s.id, last.at);
        }
        for (const a of actions) {
          this.schedule(a);
        }
      }
      this.cursor = windowEnd;
    }
    await this.updateStatus();
    if (run !== this.run || this.unloaded) {
      return;
    }
    this.refillTimer = this.setTimeout(() => {
      this.refillTimer = void 0;
      void this.planAhead(run);
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
    this.run++;
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
              await this.write(id, val, "restored", false);
            }
          }
        } catch {
          this.log.warn("The saved states could not be read, so nothing was restored");
        }
      }
      this.log.info(`Simulation stopped (${reason})`);
    }
    await this.setState("info.savedStates", "", true);
    await this.setState("info.startedBy", "", true);
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
   * @param onlyWhileRunning - false for restoring after a stop
   */
  async write(id, val, why, onlyWhileRunning = true) {
    var _a, _b;
    if (this.unloaded || onlyWhileRunning && !this.running) {
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
        this.historyProblem(`History for ${id} could not be read: ${res.error}`);
        return [];
      }
      if (this.historyFailing) {
        this.historyFailing = false;
        this.log.info(`${this.settings.historyInstance} can be read again`);
      }
      return ((_a = res == null ? void 0 : res.result) != null ? _a : []).filter((e) => typeof (e == null ? void 0 : e.ts) === "number" && (0, import_schedule.isReplayable)(e.val)).map((e) => ({ ts: e.ts, val: e.val }));
    } catch (e) {
      this.historyProblem(
        `History for ${id} could not be read from ${this.settings.historyInstance}: ${e.message}`
      );
      return [];
    }
  }
  /**
   * Logs a history read failure once; repeats go to debug until a read succeeds again.
   *
   * @param text - the message
   */
  historyProblem(text) {
    if (this.historyFailing) {
      this.log.debug(text);
    } else {
      this.historyFailing = true;
      this.log.warn(text);
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
    this.lastAt.clear();
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
