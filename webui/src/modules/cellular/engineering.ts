export const AT_QUERIES = [
  ['AT', '检查通信'], ['ATI', '设备标识'], ['AT+CSQ', '接收信号'], ['AT+CESQ', '扩展信号'],
  ['AT+CEREG?', 'LTE 注册'], ['AT+C5GREG?', '5G 注册'], ['AT+COPS?', '当前运营商'],
  ['AT+CPIN?', 'SIM 状态'], ['AT+QTEMP', '基带温度'], ['AT+CEER', '最近失败码'],
  ['AT+CFUN?', '射频功能状态'], ['AT+CGMM', '模组型号'], ['AT+CGMR', '基带版本'],
] as const;
export const POWER_PRESETS = [100, 90, 60, 30, 15, 9] as const;
export type PowerRadio = '2g' | '5g';
export type SimStatus = { ok?: boolean; state?: string; pin1?: number | null; puk1?: number | null; error?: string };
export const WIFI_FLAGS = {ap_enabled:'启用主 Wi-Fi', broadcast:'广播网络名称', isolate:'客户端隔离', wmm:'WMM 多媒体优先级'} as const;
export type WifiFlag = keyof typeof WIFI_FLAGS;
export type Policy = {nr?:number|null; roaming?:number|null};
export type EngineeringInfo = {
  ok?: boolean;
  error?: string;
  scan?: boolean; wan_auto?:boolean;
  wifi?: Array<{ radio: PowerRadio; percent: number } & Partial<Record<WifiFlag,boolean>>>;
  thermal?: Array<{ sensor: string; milli_c: number }>;
};
export type MimoInfo = { ok?: boolean; lte?: boolean | null; nr?: boolean | null; error?: string };
export type ScanRat = 'NR' | 'LTE' | 'both';
export type ScanScope = 'network' | 'all';
export type ScanReply = {
  ok?: boolean; state?: string; error?: string; code?: number;
  cells?: Array<{ rat: string; band: number; arfcn: number; pci: number; cell: string; rsrp?: number | null; rsrq?: number | null; sinr?: number | null }>;
};
export type AtResult = { ok?: boolean; incomplete?:boolean; modem_ok?: boolean; command?: string; reply?: string; error?: string };

// QTEMP reports Celsius, not millidegrees. Empty slots and the -128 sentinel have no reading.
// The third field is the thermal mitigation level of that zone; 0 means not throttled.
export function modemTemperatures(reply: string) {
  const readings = new Map<string, { celsius: number; cooling: number | null }>();
  for (const line of reply.split(/\r?\n/)) {
    const match = /^\+QTEMP:\s*"([^"]*)"\s*,\s*"(-?\d+(?:\.\d+)?)"\s*,\s*"([^"]*)"\s*$/.exec(line.trim());
    if (!match) continue;
    const sensor = match[1].trim(), celsius = Number(match[2]);
    const cooling = /^\d{1,2}$/.test(match[3].trim()) ? Number(match[3]) : null;
    if (sensor && Number.isFinite(celsius) && celsius !== -128) readings.set(sensor, { celsius, cooling });
  }
  return Array.from(readings, ([sensor, value]) => ({ sensor, ...value }));
}

export const scanActive = (state?: string) => ['queued', 'running', 'stopping'].includes(state || '');
export const scanStates: Record<string, string> = {
  idle: '尚未开始', queued: '正在启动', running: '正在扫描', stopping: '正在等待基带停止',
  complete: '扫描完成', cancelled: '已取消', timeout: '扫描超时，基带已中止',
  stop_unconfirmed: '未能确认扫描终止', rejected: '基带拒绝扫描', failed: '扫描失败',
  busy: '基带仍在执行其他操作', ril_init: '无法连接基带',
};
export const simLabels: Record<string, string> = { absent: '未检测到 SIM', ready: '就绪', pin: '等待 PIN', puk: '等待 PUK', other: '未就绪' };

const errors: Record<string, string> = {
  password_required: '请先为设备管理账户设置密码。',
  busy: '基带或设备正在处理其他操作，请稍后重试。',
  sim_rejected:'SIM 卡未接受这次操作。请核对密码和剩余次数，不要连续尝试。',
  sim_changed:'SIM 状态或剩余尝试次数已改变，请按最新状态操作。',
  sim_debug:'厂商调试日志已启用，无法安全提交 SIM 密码。',
  sim_read:'未能读取 SIM 卡状态。',
  network_pending:'网络配置已有未提交修改，请先处理后再试。',
  policy_changed:'基带策略已改变或未能读回，请刷新。',
  policy_write:'基带拒绝了这项策略。',
  beam_read:'基带未返回波束和接收链测量。',
  timeout: '设备没有及时应答，请刷新状态。',
  input: '请选择受支持的命令或档位。',
  at_format:'请输入以 AT 开头的单行命令，最多 509 字节。',
  at_unavailable:'未连上基带 AT 接口。',
  at_unconfirmed:'未收到完整回应，命令可能已执行。请先核对设备状态。',
  at_no_response: '基带未返回 AT 回应。',
  unsupported: '当前设备后端未提供此接口。',
  mimo_unsupported: '基带读不出此制式的 4×4 设置，未执行修改。',
  mimo_write: '基带拒绝修改 4×4 设置。',
  readback: '写入后未能确认配置，请先刷新，不要连续重试。',
  wifi_pending: '无线已有未提交的修改，请先在原设置页处理。',
  wifi_changed: '无线配置在别处已改变，请读取最新档位。',
  wifi_unsupported: '未读到匹配的 MT7990 驱动配置。',
  wifi_write: '保存 Wi-Fi 功率档失败。',
  scan_running: '已有一项扫描在进行。',
  scan_call: '有通话或来电，请在通话结束后扫描。',
  scan_start: '无法启动扫描任务。',
  scan_stop: '设备未接受停止请求。',
  confirm: '请求缺少确认，未执行。',
  ril_init: '无法连接基带接口。',
  nw_read: '基带未返回网络信息。',
  plmn_write: '基带拒绝了选网请求。',
  plmn_rejected: '所选网络拒绝注册。可以恢复自动选网。',
  smsc_read: '未能读取短信中心号码。',
  smsc_changed: '短信中心号码已在别处修改，请刷新后再改。',
  smsc_write: '基带拒绝修改短信中心号码。',
  ussd_send: '基带未接受这次 USSD 请求。',
  ussd_timeout: '运营商 15 秒内没有回复。VoLTE 下部分运营商不支持 USSD。',
  apn_unsupported: '未找到蜂窝拨号接口（network.wan，ql_datacall）。',
  apn_changed: 'APN 已在别处修改，请刷新后再改。',
  apn_write: '保存 APN 失败。',
  ss_rejected: '运营商拒绝了这项补充业务，可能未开通，或需通过运营商客服设置。',
  ss_unavailable: '基带没有可用的补充业务通道：当前没有 CS 注册，VoLTE/VoNR 下需要运营商的 XCAP（Ut）服务，此卡或网络未提供。可改用运营商客服或短信办理。',
};
export function engineeringError(error: unknown) {
  const key = error instanceof Error ? error.message : typeof error === 'string' ? error : '';
  return errors[key] || key || '设备未返回结果';
}
