import { cellKey } from './types';

export type Signal = { rsrp?: number | null; rsrq?: number | null; sinr10?: number | null; rssi?: number | null };
export type CarrierLink = { layers: number; mcs: number | null; modulation: string | null; kbytes_s: number | null; pusch_dbm?: number | null };
export type Carrier = {
  rat: string; primary: boolean; band: number; arfcn: number; pci: number; bw: string; state: number;
  dl?: CarrierLink | null; ul?: CarrierLink | null;
};
export type Overview = {
  ok?: boolean;
  error?: string;
  register?: { state: number; registered?: boolean; rat: string; plmn: string; tac: number; cell: string; reject: number } | null;
  lte?: Signal | null;
  nr?: Signal | null;
  cells?: import('./types').Cell[] | null;
  carriers?: Carrier[] | null;
  cqi?: { nr?: number | null; lte?: number | null } | null;
  ambr?: { net_dl?: number; net_ul?: number; ims_dl?: number; ims_ul?: number } | null;
};

export const hasDataService = (reg?: Overview['register']) =>
  reg?.registered ?? ([2, 6, 9, 10].includes(reg?.state ?? 0));

export function servingCarriers(overview?: Overview | null) {
  const reg = overview?.register;
  if (!hasDataService(reg)) return [];
  return (overview?.carriers || []).filter((item) =>
    item.primary === true && Number.isSafeInteger(item.arfcn) && item.arfcn >= (item.rat === 'LTE' ? 0 : 1) &&
    Number.isSafeInteger(item.pci) && item.pci >= 0 &&
    (item.rat === 'NR' ? item.pci <= 1007 && item.arfcn <= 3279165 : item.rat === 'LTE' && item.pci <= 503 && item.arfcn <= 262143) &&
    (reg?.rat === '5G NSA' || (reg?.rat === '5G SA' && item.rat === 'NR') || (reg?.rat === 'LTE' && item.rat === 'LTE')));
}

/** Match this snapshot's primary measurement, never a neighbour with the same PCI. */
export function servingTa(overview: Overview | null, primary?: Carrier): number | null {
  const reg = overview?.register;
  if (!hasDataService(reg)) return null;
  const rat = primary?.rat ?? (reg?.rat === '5G SA' ? 'NR' : reg?.rat === 'LTE' ? 'LTE' : null);
  const cell = overview?.cells?.find(item => item.rat === rat); // SDK entry 0 for this RAT
  if (!cell || (primary && cellKey(cell) !== cellKey(primary))) return null;
  const knownId = (id?: string) => !!id && id !== '0';
  const comparableIds = reg?.rat !== '5G NSA' && knownId(reg?.cell) && knownId(cell.cell);
  if ((!primary && !comparableIds) || (comparableIds && cell.cell !== reg?.cell)) return null;
  const ta = cell.ta;
  return typeof ta === 'number' && Number.isInteger(ta) && ta >= 0 && ta < 0x7fffffff ? ta : null;
}

export type CellIdentity = Pick<Carrier, 'rat' | 'arfcn' | 'pci'>;
export function lockMatch(lock: CellIdentity, serving: CellIdentity[]) {
  if (serving.some((cell) => cellKey(cell) === cellKey(lock))) return 'matched';
  return serving.some((cell) => cell.rat === lock.rat) ? 'different' : 'unknown';
}

export function describeCarriers(carriers: Carrier[]) {
  const active = carriers.filter((c) => c.primary || c.state === 2);
  const groups = ['NR', 'LTE'].map((rat) => ({
    rat, count: active.filter((c) => c.rat === rat).length,
  })).filter((g) => g.count > 0);
  if (!groups.length) return '载波未上报';
  if (groups.length === 2) return groups.map((c) => `${c.rat} ${c.count}CC`).join(' + ') + ' · 双连接';
  return active.length === 1 ? '单载波' : `${groups[0].rat} ${active.length}CC · 载波聚合`;
}
