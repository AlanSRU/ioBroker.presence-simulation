/*
 * Presence Simulation: while active, replays how the configured states (lights, plugs, switches)
 * were used a number of days earlier, read from a history adapter, with a random offset.
 * Writing those foreign states is the purpose of the adapter (like the scenes adapter).
 */

import * as utils from '@iobroker/adapter-core';
import { readSettings, matchesTrigger, type Settings } from './lib/config';
import { clock, dateTime } from './lib/format';
import { planWindow, valueAt, isReplayable, type HistoryEntry, type PlannedAction } from './lib/schedule';

/** How far ahead (recorded time) each history read plans. */
const LOOKAHEAD_MS = 15 * 60 * 1000;
/** How often the next window is read; shorter than LOOKAHEAD_MS so windows overlap the clock. */
const REFILL_MS = 10 * 60 * 1000;
/** Upper bound on actions planned per state per window, against a flapping state flooding the scheduler. */
const MAX_ACTIONS_PER_WINDOW = 120;
const HISTORY_TIMEOUT_MS = 15000;

class PresenceSimulation extends utils.Adapter {
    private settings!: Settings;
    private running = false;
    private unloaded = false;
    private timers = new Set<ioBroker.Timeout>();
    private refillTimer: ioBroker.Timeout | undefined;
    /** Recorded-time position up to which history has been planned. */
    private cursor = 0;
    /** The value each state is currently replaying (to drop repeats across windows). */
    private replaying = new Map<string, ioBroker.StateValue>();
    private pending: PlannedAction[] = [];

    public constructor(options: Partial<utils.AdapterOptions> = {}) {
        super({ ...options, name: 'presence-simulation' });
        this.on('ready', this.onReady.bind(this));
        this.on('stateChange', this.onStateChange.bind(this));
        this.on('unload', this.onUnload.bind(this));
    }

    private async onReady(): Promise<void> {
        this.settings = readSettings(this.config);
        await this.createObjects();
        if (this.unloaded) {
            return;
        }
        this.subscribeStates('active');

        if (!this.settings.historyInstance) {
            await this.setStatus('No history instance selected in the settings');
            this.log.warn('No history instance selected: choose one in the instance settings.');
            return;
        }
        if (!this.settings.states.length) {
            await this.setStatus('No states selected in the settings');
            this.log.warn('No states to simulate: add them in the instance settings.');
            return;
        }
        await this.checkHistoryLogging();

        const active = await this.getStateAsync('active');
        if (active?.val === true) {
            this.log.info('Simulation was active before the restart: resuming');
            await this.startSimulation(true);
        } else {
            await this.setStatus('Idle');
        }

        if (this.settings.triggerId) {
            this.subscribeForeignStates(this.settings.triggerId);
            const trig = await this.getForeignStateAsync(this.settings.triggerId);
            if (!this.running && trig && matchesTrigger(trig.val, this.settings.triggerValue)) {
                this.log.info(`${this.settings.triggerId} is "${String(trig.val)}": starting the simulation`);
                await this.startSimulation(false);
            }
        }
    }

    /** Creates or updates the adapter's own objects (extendObject keeps metadata current on upgrades). */
    private async createObjects(): Promise<void> {
        await this.extendObject('active', {
            type: 'state',
            common: {
                name: {
                    en: 'Simulation active',
                    de: 'Simulation aktiv',
                    ru: 'Симуляция активна',
                    pt: 'Simulação ativa',
                    nl: 'Simulatie actief',
                    fr: 'Simulation active',
                    it: 'Simulazione attiva',
                    es: 'Simulación activa',
                    pl: 'Symulacja aktywna',
                    uk: 'Симуляція активна',
                    'zh-cn': '模拟已启用',
                },
                type: 'boolean',
                role: 'switch.enable',
                read: true,
                write: true,
                def: false,
            },
            native: {},
        });
        await this.extendObject('info', {
            type: 'channel',
            common: {
                name: {
                    en: 'Information',
                    de: 'Informationen',
                    ru: 'Информация',
                    pt: 'Informação',
                    nl: 'Informatie',
                    fr: 'Informations',
                    it: 'Informazioni',
                    es: 'Información',
                    pl: 'Informacje',
                    uk: 'Інформація',
                    'zh-cn': '信息',
                },
            },
            native: {},
        });
        const text = (
            en: string,
            de: string,
            ru: string,
            pt: string,
            nl: string,
            fr: string,
            it: string,
            es: string,
            pl: string,
            uk: string,
            zh: string,
        ): ioBroker.StateCommon => ({
            name: { en, de, ru, pt, nl, fr, it, es, pl, uk, 'zh-cn': zh },
            type: 'string',
            role: 'text',
            read: true,
            write: false,
            def: '',
        });
        await this.extendObject('info.status', {
            type: 'state',
            common: text(
                'Status',
                'Status',
                'Статус',
                'Estado',
                'Status',
                'Statut',
                'Stato',
                'Estado',
                'Status',
                'Статус',
                '状态',
            ),
            native: {},
        });
        await this.extendObject('info.lastAction', {
            type: 'state',
            common: text(
                'Last action',
                'Letzte Aktion',
                'Последнее действие',
                'Última ação',
                'Laatste actie',
                'Dernière action',
                'Ultima azione',
                'Última acción',
                'Ostatnia akcja',
                'Остання дія',
                '上一个动作',
            ),
            native: {},
        });
        await this.extendObject('info.nextAction', {
            type: 'state',
            common: text(
                'Next action',
                'Nächste Aktion',
                'Следующее действие',
                'Próxima ação',
                'Volgende actie',
                'Prochaine action',
                'Prossima azione',
                'Próxima acción',
                'Następna akcja',
                'Наступна дія',
                '下一个动作',
            ),
            native: {},
        });
        await this.extendObject('info.savedStates', {
            type: 'state',
            common: {
                ...text(
                    'States saved at start',
                    'Beim Start gespeicherte Zustände',
                    'Состояния, сохранённые при запуске',
                    'Estados guardados no início',
                    'Bij start opgeslagen toestanden',
                    'États enregistrés au démarrage',
                    "Stati salvati all'avvio",
                    'Estados guardados al inicio',
                    'Stany zapisane przy starcie',
                    'Стани, збережені під час запуску',
                    '启动时保存的状态',
                ),
                role: 'json',
            },
            native: {},
        });
    }

    private async onStateChange(id: string, state: ioBroker.State | null | undefined): Promise<void> {
        if (!state || this.unloaded) {
            return;
        }
        // Own control state: act on commands (ack false) only.
        if (id === `${this.namespace}.active`) {
            if (state.ack) {
                return;
            }
            if (state.val === true) {
                await this.startSimulation(false);
            } else {
                await this.stopSimulation('switched off');
            }
            return;
        }
        // Foreign trigger: act on confirmed values (ack true) only.
        if (id === this.settings.triggerId && state.ack) {
            const away = matchesTrigger(state.val, this.settings.triggerValue);
            if (away && !this.running) {
                this.log.info(`${id} changed to "${String(state.val)}": starting the simulation`);
                await this.startSimulation(false);
            } else if (!away && this.running) {
                this.log.info(`${id} changed to "${String(state.val)}": stopping the simulation`);
                await this.stopSimulation('trigger');
            }
        }
    }

    /**
     * Starts (or resumes) the replay.
     *
     * @param resume - true after an adapter restart: keep the states saved at the original start
     */
    private async startSimulation(resume: boolean): Promise<void> {
        if (this.running || this.unloaded) {
            return;
        }
        if (!this.settings.historyInstance || !this.settings.states.length) {
            await this.setState('active', false, true);
            return;
        }
        this.running = true;
        await this.setState('active', true, true);

        const saved = await this.getStateAsync('info.savedStates');
        if (!resume || !saved?.val) {
            const snapshot: Record<string, ioBroker.StateValue> = {};
            for (const s of this.settings.states) {
                const st = await this.getForeignStateAsync(s.id);
                if (st && isReplayable(st.val)) {
                    snapshot[s.id] = st.val;
                }
            }
            await this.setState('info.savedStates', JSON.stringify(snapshot), true);
        }
        if (this.unloaded || !this.running) {
            return;
        }

        // Put every state where it was at the same moment `days` ago, then plan ahead.
        const recordedNow = Date.now() - this.settings.deltaMs;
        this.replaying.clear();
        for (const s of this.settings.states) {
            const before = await this.history(s.id, { end: recordedNow, count: 1, returnNewestEntries: true });
            const val = valueAt(before, recordedNow);
            if (val !== undefined) {
                this.replaying.set(s.id, val);
                await this.write(s.id, val, 'initial state');
            }
            if (this.unloaded || !this.running) {
                return;
            }
        }
        this.cursor = recordedNow;
        await this.planAhead();
        this.log.info(
            `Simulation started: replaying ${this.settings.states.length} state(s) from ${this.settings.deltaMs / 86400000} day(s) ago`,
        );
    }

    /** Reads the next window of history, schedules it, and re-arms itself. */
    private async planAhead(): Promise<void> {
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
                let actions = planWindow(s.id, entries, windowStart, windowEnd, this.replaying.get(s.id), {
                    deltaMs: this.settings.deltaMs,
                    jitterMs: this.settings.jitterMs,
                    now,
                });
                if (actions.length > MAX_ACTIONS_PER_WINDOW) {
                    this.log.warn(
                        `${s.id} changed ${actions.length} times in 15 minutes of history: replaying the first ${MAX_ACTIONS_PER_WINDOW}`,
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
        // Re-arm at the end of the run, so a slow history read can never overlap the next one.
        this.refillTimer = this.setTimeout(() => {
            this.refillTimer = undefined;
            void this.planAhead();
        }, REFILL_MS);
    }

    private schedule(a: PlannedAction): void {
        this.pending.push(a);
        const timer = this.setTimeout(
            () => {
                if (timer) {
                    this.timers.delete(timer);
                }
                this.pending = this.pending.filter(p => p !== a);
                void this.write(a.id, a.val, `as on ${dateTime(a.recordedAt)}`).then(() => this.updateStatus());
            },
            Math.max(0, a.at - Date.now()),
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
    private async stopSimulation(reason: string): Promise<void> {
        const wasRunning = this.running;
        this.running = false;
        this.clearTimers();
        if (this.unloaded) {
            return;
        }
        const saved = await this.getStateAsync('info.savedStates');
        if (wasRunning || saved?.val) {
            if (this.settings.restore && typeof saved?.val === 'string' && saved.val) {
                try {
                    const snapshot = JSON.parse(saved.val) as Record<string, ioBroker.StateValue>;
                    for (const [id, val] of Object.entries(snapshot)) {
                        if (this.settings.states.some(s => s.id === id)) {
                            await this.write(id, val, 'restored');
                        }
                    }
                } catch {
                    this.log.warn('The saved states could not be read, so nothing was restored');
                }
            }
            this.log.info(`Simulation stopped (${reason})`);
        }
        await this.setState('info.savedStates', '', true);
        await this.setState('info.nextAction', '', true);
        await this.setState('active', false, true);
        await this.setStatus('Idle');
    }

    /**
     * Writes a foreign state as a command (ack false), skipping it if it already has that value.
     *
     * @param id - state id
     * @param val - value to write
     * @param why - for the log and info.lastAction
     */
    private async write(id: string, val: ioBroker.StateValue, why: string): Promise<void> {
        if (this.unloaded) {
            return;
        }
        try {
            const current = await this.getForeignStateAsync(id);
            if (current?.val === val) {
                return;
            }
            await this.setForeignStateAsync(id, val, false);
            const name = this.settings.states.find(s => s.id === id)?.name ?? id;
            this.log.debug(`${name} → ${String(val)} (${why})`);
            await this.setState('info.lastAction', `${clock(Date.now())} ${name} → ${String(val)} (${why})`, true);
        } catch (e) {
            this.log.warn(`Could not set ${id}: ${(e as Error).message}`);
        }
    }

    /**
     * Reads history for one state through the configured history instance.
     *
     * @param id - state id
     * @param options - getHistory options (start/end/count/…)
     */
    private async history(id: string, options: Record<string, unknown>): Promise<HistoryEntry[]> {
        try {
            const res = (await this.sendToAsync(
                this.settings.historyInstance,
                'getHistory',
                { id, options: { aggregate: 'none', ignoreNull: true, ...options } },
                { timeout: HISTORY_TIMEOUT_MS },
            )) as { result?: { ts: number; val: unknown }[]; error?: string } | undefined;
            if (res?.error) {
                this.log.warn(`History for ${id} could not be read: ${res.error}`);
                return [];
            }
            return (res?.result ?? [])
                .filter(e => typeof e?.ts === 'number' && isReplayable(e.val))
                .map(e => ({ ts: e.ts, val: e.val as ioBroker.StateValue }));
        } catch (e) {
            this.log.warn(
                `History for ${id} could not be read from ${this.settings.historyInstance}: ${(e as Error).message}`,
            );
            return [];
        }
    }

    /** Warns about selected states that the chosen history instance is not recording. */
    private async checkHistoryLogging(): Promise<void> {
        const missing: string[] = [];
        for (const s of this.settings.states) {
            const obj = await this.getForeignObjectAsync(s.id);
            if (!obj) {
                missing.push(`${s.name} (state not found)`);
                continue;
            }
            const custom = obj.common?.custom?.[this.settings.historyInstance] as { enabled?: boolean } | undefined;
            if (!custom?.enabled) {
                missing.push(s.name);
            }
        }
        if (missing.length) {
            this.log.warn(
                `${this.settings.historyInstance} is not recording: ${missing.join(', ')}. Enable logging for them in the Objects tab, or they cannot be replayed.`,
            );
        }
    }

    private async updateStatus(): Promise<void> {
        if (!this.running) {
            return;
        }
        const next = [...this.pending].sort((a, b) => a.at - b.at)[0];
        const nextText = next
            ? `${clock(next.at)} ${this.settings.states.find(s => s.id === next.id)?.name ?? next.id} → ${String(next.val)}`
            : '';
        await this.setState('info.nextAction', nextText, true);
        await this.setStatus(`Running: replaying ${this.settings.deltaMs / 86400000} day(s) ago`);
    }

    private async setStatus(text: string): Promise<void> {
        if (!this.unloaded) {
            await this.setState('info.status', text, true);
        }
    }

    private clearTimers(): void {
        for (const t of this.timers) {
            this.clearTimeout(t);
        }
        this.timers.clear();
        this.pending = [];
        if (this.refillTimer) {
            this.clearTimeout(this.refillTimer);
            this.refillTimer = undefined;
        }
    }

    private onUnload(callback: () => void): void {
        // Set first: any in-flight history read or write checks it before touching state.
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
    // Export the constructor in compact mode
    module.exports = (options: Partial<utils.AdapterOptions> | undefined) => new PresenceSimulation(options);
} else {
    // otherwise start the instance directly
    (() => new PresenceSimulation())();
}
