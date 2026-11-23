import { useEffect, useState } from 'react';
import { ubus } from '@/services/deviceUbus';
import type { Tone } from '@/ui/tokens';

export type OperatorName = { long?: string | null; short?: string | null; plmn?: string | null };
export type SimIdentity = { state: string; iccid?: string | null; imsi?: string | null; plmn?: string | null; number?: string | null };
export type Identity = {
  ok?: boolean; error?: string;
  imei?: string | null; software?: string | null; firmware?: string | null; modem?: string | null;
  airplane?: boolean | null; sim?: SimIdentity | null;
};
export type TddPattern = { period: number; dl_slots: number; ul_slots: number; dl_symbols: number; ul_symbols: number };
export type NetworkExtra = {
  ok?: boolean; error?: string;
  operator?: OperatorName | null; nitz?: string | null; tdd?: TddPattern[] | null;
  endc?: { available: boolean; restricted: boolean } | null;
  srv_domain?: number | null; voice?: { state?: number | null; rat?: number | null } | null;
};
export type RadioState = {
  ok?: boolean; error?: string; nwmode?: number | null; airplane?: boolean | null;
  selection?: { mode: 'auto' | 'manual'; plmn?: string | null } | null;
};
export type ScanNetwork = { name: OperatorName; status?: number | null; rat?: number | null };
export type PlmnScan = { ok?: boolean; state?: string; error?: string; networks?: ScanNetwork[] };
export type Apn = {
  ok?: boolean; error?: string; apn?: string; username?: string; password_set?: boolean;
  auth?: number; iptype?: number; revision?: string;
};
export type CallForward = { ok?: boolean; error?: string; reason?: number; enabled?: boolean; number?: string | null; time?: number | null };

/** Older backends lack the helpers; hide their controls instead of showing errors. */
export function useSdkAccess() {
  const [access, setAccess] = useState<{ sdk: boolean; services: boolean } | null>(null);
  useEffect(() => {
    let alive = true;
    ubus<{ sdk?: boolean; services?: boolean }>('dlink-cellular', 'access')
      .then((r) => alive && setAccess({ sdk: r.sdk === true, services: r.services === true }))
      .catch(() => alive && setAccess({ sdk: false, services: false }));
    return () => { alive = false; };
  }, []);
  return access;
}

export const operatorLabel = (op?: OperatorName | null) => op?.long || op?.short || op?.plmn || '';

export const NW_MODES = [
  { value: 21, label: '3G + 4G + 5G 自动' },
  { value: 19, label: '4G + 5G 自动' },
  { value: 15, label: '仅 5G SA' },
  { value: 3, label: '仅 4G LTE' },
] as const;
export const nwModeLabel = (v?: number | null) =>
  v == null ? '未读到' : NW_MODES.find((m) => m.value === v)?.label ?? `其他模式（${v}）`;

export const RAT_NAMES: Record<number, string> = { 2: 'GSM', 4: 'LTE', 15: 'UMTS', 18: '5G SA', 19: '5G NSA' };
/** ql_nw_set_plmn_info act: 7 LTE, 12 SA, 13 EN-DC. */
export const RAT_TO_ACT: Record<number, number> = { 4: 7, 18: 12, 19: 13 };

export const NETWORK_STATUS: Record<number, { label: string; tone: Tone }> = {
  1: { label: '当前驻留', tone: 'success' },
  2: { label: '首选', tone: 'accent' },
  3: { label: '归属网络', tone: 'accent' },
  4: { label: '可用', tone: 'neutral' },
  5: { label: '禁止接入', tone: 'danger' },
};

export const REG_STATES: Record<number, string> = {
  0: '未注册', 1: '仅紧急呼叫', 2: '已注册', 3: '正在搜索', 4: '注册被拒', 5: '未知',
  6: '已注册（漫游）', 7: '仅短信', 8: '漫游仅短信', 9: '已注册', 10: '已注册（漫游）',
};

export const SCAN_STATES: Record<string, string> = {
  idle: '尚未搜索', running: '正在搜索运营商，通常需要 1–3 分钟', complete: '搜索完成',
  timeout: '搜索超时，基带未返回结果', cancelled: '搜索被基带中止', failed: '搜索失败',
  stop_unconfirmed: '未能确认搜索是否结束，请稍后刷新',
};

const TDD_PERIOD_MS = ['0.5', '0.625', '1', '1.25', '2', '2.5', '3', '4', '5', '10'];
export const tddLabel = (p: TddPattern) =>
  `${TDD_PERIOD_MS[p.period] ?? '?'} ms 周期 · ${p.dl_slots} 下行 / ${p.ul_slots} 上行时隙 · 特殊时隙 ${p.dl_symbols}:${p.ul_symbols}`;

/** NITZ arrives as universal time plus the zone offset, e.g. "26/11/23,03:48:22 +480".
 * This firmware reports minutes; the SDK header describes quarter hours, which never divide by 15. */
export function nitzLabel(raw?: string | null) {
  const m = raw?.match(/^(\d{2})\/(\d{2})\/(\d{2}),(\d{2}):(\d{2}):(\d{2})\s*([+-])(\d{1,4})/);
  if (!m) return null;
  const [, yy, mo, dd, hh, mi, ss, sign, tz] = m;
  const units = Number(tz);
  const minutes = (units > 56 || units % 15 === 0 ? units : units * 15) * (sign === '-' ? -1 : 1);
  if (Math.abs(minutes) > 14 * 60) return null;
  const utc = Date.UTC(2000 + Number(yy), Number(mo) - 1, Number(dd), Number(hh), Number(mi), Number(ss));
  if (!Number.isFinite(utc)) return null;
  const local = new Date(utc + minutes * 60000);
  const pad = (n: number) => String(n).padStart(2, '0');
  const zone = `UTC${minutes < 0 ? '−' : '+'}${Math.floor(Math.abs(minutes) / 60)}${Math.abs(minutes) % 60 ? `:${pad(Math.abs(minutes) % 60)}` : ''}`;
  return `${local.getUTCFullYear()}-${pad(local.getUTCMonth() + 1)}-${pad(local.getUTCDate())} ${pad(local.getUTCHours())}:${pad(local.getUTCMinutes())} · ${zone}`;
}

/** USSD replies that are not UTF-8 come back as hex; most networks then use UCS2. */
export function ussdText(reply?: string | null) {
  if (!reply) return '';
  if (/^(?:[0-9A-F]{4})+$/.test(reply) && reply.length >= 4) {
    let text = '';
    for (let i = 0; i < reply.length; i += 4) text += String.fromCharCode(parseInt(reply.slice(i, i + 4), 16));
    return text;
  }
  return reply;
}

/** Keep identifiers off shoulder-surfed screens until asked. */
export const masked = (value?: string | null, keep = 4) =>
  !value ? '未读到' : value.length <= keep + 3 ? value : `${value.slice(0, 3)}${'•'.repeat(value.length - keep - 3)}${value.slice(-keep)}`;

export const CF_REASONS = [
  { reason: 0, label: '无条件转移', hint: '所有来电都转到这个号码' },
  { reason: 1, label: '遇忙转移', hint: '通话中时转移' },
  { reason: 2, label: '无应答转移', hint: '响铃一段时间未接时转移' },
  { reason: 3, label: '无法接通转移', hint: '关机或无信号时转移' },
] as const;
