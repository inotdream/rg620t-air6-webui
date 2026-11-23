import { ubus } from '@/services/deviceUbus';
import { hasDataService, servingCarriers, type Overview } from './telemetry';

export type LockKind = 'cell' | 'arfcn';
export type LockReply = { ok?: boolean; error?: string; applied?: boolean; apply_error?: string; recorded?: boolean; verified?: boolean };
type CellTarget = { rat: string; arfcn: number; pci?: number };
export type CampTarget = CellTarget | CellTarget[] | null;
export type CampResult = 'matched' | 'other' | 'none' | 'unknown';

const APPLY_ERRORS: Record<string, string> = {
  apply_call: '通话中，已保留锁定规则，未重启射频。',
  apply_voice_unknown: '未能确认通话状态，未重启射频。',
  apply_airplane: '设备原本处于飞行模式，未重启射频。',
  apply_radio: '未能完成射频重启，请刷新驻留状态。',
  apply_init: '无法控制射频，请等待基带下次重选。',
  apply_read: '读不到射频状态，未重启射频。',
  radio_off: '射频仍处于关闭状态，请从局域网进入「网络模式与选网」关闭飞行模式。',
  radio_unknown: '未能确认射频是否恢复，请从局域网核对飞行模式和驻留状态。',
};
export const applyError = (code?: string) => (code ? APPLY_ERRORS[code] || code : '');

export async function lockRequest(method: string, params: Record<string, unknown>) {
  const reply = await ubus<LockReply>('dlink-cellular', method, { ...params, confirm: true });
  if (reply.ok !== true) throw new Error(reply.error || 'readback');
  return reply;
}

export function requestCellLock(target: CellTarget, kind: LockKind, apply: boolean, extended: boolean) {
  if (kind === 'cell' && !Number.isSafeInteger(target.pci)) throw new Error('锁定主小区需要填写 PCI。');
  if (!extended && (kind !== 'cell' || apply)) throw new Error('此操作需要配套的锁定后端。');
  return lockRequest('cell_set', {
    rat: target.rat, arfcn: String(target.arfcn),
    // Without a PCI, even an old RPC that ignores kind cannot turn an ARFCN lock into a PCI lock.
    ...(kind === 'cell' ? { pci: String(target.pci) } : {}),
    ...(extended ? { kind, apply } : {}),
  });
}

export function campResult(overview: Overview, target: CampTarget, kind: LockKind): CampResult {
  if (overview.ok !== true || !overview.register) return 'unknown';
  if (!hasDataService(overview.register)) return 'none';
  if (!target) return 'matched';
  const serving = servingCarriers(overview);
  if (!serving.length) return 'unknown';
  const allowed = Array.isArray(target) ? target : [target];
  return serving.some(s => allowed.some(t => s.rat === t.rat && s.arfcn === t.arfcn &&
    (kind === 'arfcn' || s.pci === t.pci))) ? 'matched' : 'other';
}

export async function waitForCamp(target: CampTarget, kind: LockKind, onTick: (seconds: number) => void) {
  const start = Date.now(), deadline = start + 45_000;
  let last: CampResult = 'unknown';
  while (Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, Math.min(3000, deadline - Date.now())));
    onTick(Math.round((Date.now() - start) / 1000));
    try { last = campResult(await ubus<Overview>('dlink-cellular', 'overview'), target, kind); }
    catch { last = 'unknown'; }
    if (last === 'matched') break;
  }
  return last;
}

export function campText(result: CampResult, target: CampTarget, kind: LockKind) {
  if (result === 'unknown') return '暂时读不到实际驻留，请刷新核对';
  if (result === 'none') return '未观察到重新注册；若持续无服务，请检查覆盖或解除锁定';
  if (!target) return '已重新注册网络';
  if (Array.isArray(target)) return result === 'matched' ? '实际主小区在提交的白名单内' : '已注册，但实际主小区不在提交的白名单内';
  if (kind === 'arfcn') return result === 'matched' ? '已驻留到目标频点' : '已注册，但实际主小区不在目标频点';
  return result === 'matched' ? '已驻留到目标主小区' : '已注册，但实际主小区不是目标';
}
