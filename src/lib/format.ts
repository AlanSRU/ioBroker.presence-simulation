/**
 * Locale-independent time formatting for logs and info states (the server's locale is not the user's).
 */

const pad = (n: number): string => String(n).padStart(2, '0');

/**
 * "18:14:38" in the server's time zone.
 *
 * @param ms - timestamp
 */
export function clock(ms: number): string {
    const d = new Date(ms);
    return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

/**
 * "2026-09-26 18:14" in the server's time zone.
 *
 * @param ms - timestamp
 */
export function dateTime(ms: number): string {
    const d = new Date(ms);
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
