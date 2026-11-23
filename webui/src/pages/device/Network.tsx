import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Button, Progress, Space, Tag, Toast, Typography } from '@douyinfe/semi-ui';
import {
  IconArrowDown,
  IconArrowUp,
  IconChevronRight,
  IconLayers,
  IconLock,
  IconRefresh,
  IconSignal,
} from '@douyinfe/semi-icons';
import { useBeams, BeamDetails, beamLabel, beamPower } from '@/modules/cellular/BeamDetails';
import { AutoRefresh, Kv, Metric, PageCard, SectionHeader } from '@/ui/widgets';
import { QualityBar, RingGauge, Sparkline } from '@/ui/charts';
import { SIGNAL_RSRP_RANGE } from '@/modem/parse';
import { ubus } from '@/services/deviceUbus';
import { TAG_COLOR, toneClass, toneColor, ratTagColor } from '@/ui/tokens';
import type { Cell } from '@/modules/cellular/types';
import { describeCarriers, hasDataService, lockMatch, servingCarriers, servingTa, type CarrierLink, type Overview } from '@/modules/cellular/telemetry';
import { rsrpPercent, rsrqTone, scoreLabel, scoreTone, sinrTone } from '@/modules/cellular/grade';
import { useCellularStream } from '@/modules/cellular/stream';
import LockCellModal from '@/modules/cellular/LockCellModal';
import {
  nitzLabel, operatorLabel, RAT_NAMES, REG_STATES, tddLabel, useSdkAccess, type NetworkExtra,
} from '@/modules/cellular/sdk';

type SessionQos = { ok?: boolean; error?: string; kind?: '5QI' | 'QCI' | ''; sessions?: Array<{
  cid: number; apn: string; role: 'ims' | 'data'; classes: number[];
}> };

const OPERATORS: Record<string, string> = {
  '46000': '中国移动',
  '46002': '中国移动',
  '46007': '中国移动',
  '46001': '中国联通',
  '46006': '中国联通',
  '46003': '中国电信',
  '46011': '中国电信',
};

const HISTORY_POINTS = 60;

/** 频段名必须按制式区分：LTE 用 B + 数字，NR 用 n + 数字。 */
const bandName = (value: number, rat?: string) => {
  if (!Number.isFinite(value) || value <= 0) return '—';
  return rat === 'NR' ? `n${value}` : `B${value}`;
};

const kbps = (value?: number) => {
  if (!value) return '—';
  return value >= 1000 ? `${(value / 1000).toFixed(1)} Mbps` : `${value} kbps`;
};

const bytes = (value?: number) => {
  if (!value) return '—';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let size = value;
  let unit = 0;
  while (size >= 1024 && unit < units.length - 1) {
    size /= 1024;
    unit += 1;
  }
  return `${size.toFixed(unit > 1 ? 2 : 0)} ${units[unit]}`;
};

const Network: React.FC = () => {
  const [data, setData] = useState<Overview | null>(null);
  const [beamSample,requestBeams]=useState(0);
  const beams=useBeams(beamSample);
  const [loading, setLoading] = useState(false);
  const [auto, setAuto] = useState({ enabled: true, interval: 5 });
  const [rsrpHistory, setRsrpHistory] = useState<number[]>([]);
  const [sinrHistory, setSinrHistory] = useState<number[]>([]);
  const [speed, setSpeed] = useState({ down: 0, up: 0 });
  const [speedHistory, setSpeedHistory] = useState<Array<{ down: number; up: number }>>([]);
  const [traffic, setTraffic] = useState<{ rx?: number; tx?: number; iface?: string; speed?: string }>({});
  const [qos, setQos] = useState<SessionQos | null>(null);
  const [lockTarget, setLockTarget] = useState<Cell | null>(null);
  const reading = useRef(false);
  const trafficReading = useRef(false);
  const qosReading = useRef(false);
  const lastQosAt = useRef(0);
  const ratRef = useRef('');
  const access = useSdkAccess();
  const [extra, setExtra] = useState<NetworkExtra | null>(null);
  const extraReading = useRef(false);
  const lastExtraAt = useRef(0);
  const sdkReady = useRef(false);
  sdkReady.current = access?.sdk === true;
  const [pageVisible, setPageVisible] = useState(() => !document.hidden);
  const { snapshot, status: liveStatus } = useCellularStream(auto.enabled && pageVisible);
  const lastSample = useRef<{ rx: number; tx: number; at: number; name: string } | null>(null);

  const sampleTraffic = useCallback(async () => {
    if (trafficReading.current) return;
    trafficReading.current = true;
    try {
      const dumped = await ubus<{ interface?: Array<{ interface: string; device?: string; l3_device?: string; proto?: string; up: boolean }> }>(
        'network.interface',
        'dump',
      );
      const cellular =
        dumped.interface?.find((item) => item.proto === 'ql_datacall' && item.interface === 'wan') ||
        dumped.interface?.find((item) => item.proto === 'ql_datacall') ||
        dumped.interface?.find((item) => /ccmni/i.test(item.device || '')) ||
        dumped.interface?.find((item) => item.interface === 'modem5g');
      const name = cellular?.l3_device || cellular?.device;
      if (!name) { setTraffic({}); lastSample.current = null; return; }
      const status = await ubus<{ statistics?: { rx_bytes?: number; tx_bytes?: number }; speed?: string }>(
        'network.device',
        'status',
        { name },
      );
      const rx = status.statistics?.rx_bytes;
      const tx = status.statistics?.tx_bytes;
      if (rx == null || tx == null) { setTraffic({ iface: name }); lastSample.current = null; return; }
      setTraffic({ rx, tx, iface: name, speed: status.speed });

      const now = Date.now();
      const previous = lastSample.current;
      if (previous?.name === name && now > previous.at && rx >= previous.rx && tx >= previous.tx) {
        const seconds = (now - previous.at) / 1000;
        // 计数器是字节，界面单位是 Mbps（十进制兆比特）
        const down = Math.max(0, ((rx - previous.rx) * 8) / seconds / 1e6);
        const up = Math.max(0, ((tx - previous.tx) * 8) / seconds / 1e6);
        setSpeed({ down, up });
        setSpeedHistory((list) => [...list, { down, up }].slice(-HISTORY_POINTS));
      }
      lastSample.current = { rx, tx, at: now, name };
    } finally { trafficReading.current = false; }
  }, []);

  const accept = useCallback((next: Overview) => {
    setData(next);
    ratRef.current = next.register?.rat || '';
    const rsrp = next.nr?.rsrp ?? next.lte?.rsrp;
    const sinr10 = next.nr?.sinr10 ?? next.lte?.sinr10;
    if (rsrp != null) setRsrpHistory((list) => [...list, rsrp].slice(-HISTORY_POINTS));
    if (sinr10 != null) setSinrHistory((list) => [...list, sinr10 / 10].slice(-HISTORY_POINTS));
  }, []);

  const readRadio = useCallback(async (silent = true) => {
    if (reading.current) return;
    reading.current = true;
    if (!silent) setLoading(true);
    try {
      const next = await ubus<Overview>('dlink-cellular', 'overview');
      if (next.ok !== true) throw new Error(next.error === 'busy' ? '基带忙，稍后再读' : '未读到基带遥测');
      accept(next);
    } catch (error) {
      if (!silent) Toast.error(error instanceof Error ? error.message : '读取失败');
    } finally {
      reading.current = false;
      if (!silent) setLoading(false);
    }
  }, [accept]);

  // 会话 QoS 单独一条 ubus 请求：dlink-cellular 用的是非阻塞锁，必须等 overview 返回后再查。
  // QCI 很少变化，没必要跟着 5 秒刷新一直查，否则自己也会变成锁竞争源。
  const readQos = useCallback(async (force = false) => {
    if (qosReading.current || !ratRef.current) return;
    if (!force && Date.now() - lastQosAt.current < 30000) return;
    qosReading.current = true;
    lastQosAt.current = Date.now();
    try {
      const result = await ubus<SessionQos>('dlink-cellular', 'qos', { rat: ratRef.current, contexts: false });
      setQos(result.ok === true ? result : null);
    } catch {
      setQos(null);
    } finally {
      qosReading.current = false;
    }
  }, []);

  // 运营商名、授时、TDD 帧结构几乎不变，一分钟读一次，排在 QoS 之后避免与其他查询抢基带锁。
  const readExtra = useCallback(async (force = false) => {
    if (!sdkReady.current || extraReading.current) return;
    if (!force && Date.now() - lastExtraAt.current < 60000) return;
    extraReading.current = true;
    lastExtraAt.current = Date.now();
    try {
      const result = await ubus<NetworkExtra>('dlink-cellular', 'sdk_network');
      if (result.ok === true) setExtra(result);
    } catch {
      // 旧后端或基带忙时保留上一次的读数
    } finally {
      extraReading.current = false;
    }
  }, []);

  const load = useCallback(() => {
    void readRadio(false).then(()=>readQos(true)).then(()=>readExtra(true)).then(()=>requestBeams(t=>t+1));
    void sampleTraffic().catch(() => {});
  }, [readRadio, readQos, readExtra, sampleTraffic]);

  useEffect(load, [load]);
  useEffect(() => {
    const onVis = () => setPageVisible(!document.hidden);
    document.addEventListener('visibilitychange', onVis);
    return () => document.removeEventListener('visibilitychange', onVis);
  }, []);

  useEffect(() => {
    if (snapshot) accept(snapshot);
  }, [snapshot, accept]);

  const pushing = liveStatus === 'live';
  useEffect(() => {
    if (!auto.enabled || !pageVisible) return undefined;
    const id = window.setInterval(() => {
      void (pushing ? Promise.resolve() : readRadio()).then(()=>readQos()).then(()=>readExtra()).then(()=>requestBeams(t=>t+1));
      void sampleTraffic().catch(() => {});
    }, auto.interval * 1000);
    return () => window.clearInterval(id);
  }, [auto, pageVisible, pushing, readRadio, readQos, readExtra, sampleTraffic]);

  useEffect(() => {
    if (access?.sdk) void readExtra(true);
  }, [access?.sdk, readExtra]);

  const reg = data?.register;
  // 制式是 QoS 查询的入参：首屏可能先于 overview 到达，拿到驻留制式后立刻补查一次。
  const qosRat = reg?.rat || '';
  useEffect(() => {
    if (qosRat) void readQos(true);
  }, [qosRat, readQos]);
  const attached = hasDataService(reg);
  const signal = data?.nr || data?.lte;
  const sinr = signal?.sinr10 != null ? signal.sinr10 / 10 : null;
  const cells = data?.cells;
  // 基带给出的运营商名优先；只在它与当前驻留 PLMN 一致时采用，避免显示切网前的旧名称。
  const sdkOperator = extra?.operator && (!extra.operator.plmn || extra.operator.plmn === reg?.plmn)
    ? operatorLabel(extra.operator) : '';
  const operator = sdkOperator || (reg?.plmn ? OPERATORS[reg.plmn] || reg.plmn : '未知运营商');
  const voiceReg = extra?.voice?.state != null
    ? [REG_STATES[extra.voice.state] ?? '未知', extra.voice.rat != null ? RAT_NAMES[extra.voice.rat] : ''].filter(Boolean).join(' · ')
    : '—';
  // EN-DC 是 LTE 锚点上的双连接，SA 驻留时没有意义。
  const endc = reg?.rat === '5G SA' ? '不适用（SA）'
    : extra?.endc ? (extra.endc.restricted ? '受限' : extra.endc.available ? '主小区支持' : '不支持') : '—';
  const tdd = extra?.tdd?.length ? extra.tdd.map(tddLabel).join('；') : '';
  const score = rsrpPercent(signal?.rsrp);
  const signalTone = scoreTone(score);
  const qualityLabel = scoreLabel(score);

  const peakDown = speedHistory.reduce((max, p) => Math.max(max, p.down), 0);
  const peakUp = speedHistory.reduce((max, p) => Math.max(max, p.up), 0);

  const carriers = data?.carriers || [];
  const nrPrimary=carriers.find(c=>c.rat==='NR'&&c.primary);
  const primaryBeam=beams.data?.beams.find(b=>b.cc==='NR PCC');
  const extraCCs=Array.from(new Set([...(beams.data?.beams||[]),...(beams.data?.rx||[])].map(b=>b.cc)))
    .filter(cc=>cc!=='NR PCC'||!nrPrimary);
  const serving = servingCarriers(data);
  const primaryCarrier = serving[0];
  const ta = servingTa(data, primaryCarrier);
  const primaryBand = primaryCarrier ? bandName(primaryCarrier.band, primaryCarrier.rat) : '—';
  const carrierSummary = describeCarriers(carriers);
  const metrics = (values?: CarrierLink | null) =>
    (values?.mcs != null ? [values.layers + ' 层', 'MCS ' + values.mcs, values.modulation].filter(Boolean).join(' · ') : values ? values.layers + ' 层' : '—');

  // 会话 QoS 直接展示数据承载的 5QI/QCI，不再让用户跳到拨号页去看。
  const qosSessions = (qos?.ok ? qos.sessions || [] : []).filter((session) => session.classes.length);
  const qosDataSessions = qosSessions.filter((session) => session.role === 'data');
  const qosShown = qosDataSessions.length ? qosDataSessions : qosSessions;
  const qosClasses = Array.from(new Set(qosShown.flatMap((session) => session.classes)));
  const qosValue = qos?.kind && qosClasses.length ? `${qos.kind} ${qosClasses.join(' / ')}` : '—';
  const qosDetail = qosShown.length > 1
    ? qosShown.map((session) => `${session.apn || '默认 APN'} ${qos?.kind || ''} ${session.classes.join(' / ')}`.trim()).join(' · ')
    : '';

  return (
    <div className="page-stack">
      {/* 顶部实时控制栏 */}
      <div className="page-toolbar">
        <div className="page-toolbar-left">
          <span className={`live-badge live-badge--${liveStatus}`} role="status">
            <span className="live-badge-dot" aria-hidden="true" />
            {!auto.enabled ? '手动刷新' : pushing ? '实时推送中' : liveStatus === 'connecting' ? '正在连接推送' : '轮询模式'}
          </span>
          {carriers.length > 0 ? (
            <span className="toolbar-pill">
              <IconLayers size="small" />
              {carrierSummary} · 主频段 {primaryBand}
            </span>
          ) : null}
        </div>
        <div className="page-toolbar-right">
          <AutoRefresh
            enabled={auto.enabled}
            interval={auto.interval}
            onChange={(enabled, interval) => setAuto({ enabled, interval })}
          />
          <Button size="small" icon={<IconRefresh />} loading={loading} onClick={() => load()}>
            刷新
          </Button>
        </div>
      </div>

      {/* Tier 1: 核心状态 KPI 概览条 */}
      <div className="kpi-strip">
        <Metric
          tile
          size="md"
          icon={<IconSignal size="small" />}
          label="驻留网络"
          value={attached ? reg?.rat || '已驻留' : reg ? '未驻留' : '读取中'}
          badge={
            <Tag size="small" color={TAG_COLOR[attached ? 'success' : 'danger']}>
              {attached ? '已驻留' : '未驻留'}
            </Tag>
          }
          hint={`${operator} · 主频段 ${primaryBand}${reg?.plmn ? ` · ${reg.plmn}` : ''}`}
          className="kpi-card"
        />
        <Metric
          tile
          size="md"
          label="信号强度"
          value={signal?.rsrp ?? '—'}
          unit={signal?.rsrp != null ? 'dBm' : undefined}
          tone={signalTone}
          badge={
            <Tag size="small" color={TAG_COLOR[signalTone]}>
              {qualityLabel}
            </Tag>
          }
          hint={`SINR ${sinr != null ? `${sinr} dB` : '—'} · RSRQ ${signal?.rsrq != null ? `${signal.rsrq} dB` : '—'}`}
          className="kpi-card"
        />
        <Metric
          tile
          size="md"
          icon={<IconArrowDown size="small" />}
          label="实时下行"
          value={speed.down.toFixed(2)}
          unit="Mbps"
          tone="down"
          hint={speedHistory.length ? `峰值 ${peakDown.toFixed(2)} Mbps · 近 ${speedHistory.length} 次采样` : '等待采样'}
          className="kpi-card kpi-card--down"
        />
        <Metric
          tile
          size="md"
          icon={<IconArrowUp size="small" />}
          label="实时上行"
          value={speed.up.toFixed(2)}
          unit="Mbps"
          tone="up"
          hint={speedHistory.length ? `峰值 ${peakUp.toFixed(2)} Mbps · 近 ${speedHistory.length} 次采样` : '等待采样'}
          className="kpi-card kpi-card--up"
        />
      </div>

      {/* Tier 2: 信号驾驶舱 + 实时速率趋势 */}
      <div className="bento-primary">
        <PageCard
          variant="hero"
          title="信号质量与驻留参数"
          hint="当前服务小区射频遥测与签约信息"
          extra={
            <Space spacing={6}>
              {primaryBand !== '—' ? <Tag color={TAG_COLOR.accent}>{primaryBand}</Tag> : null}
              {primaryCarrier?.pci != null ? <Tag color={TAG_COLOR.neutral}>PCI {primaryCarrier.pci}</Tag> : null}
            </Space>
          }
        >
          <div className="signal-cockpit">
            <div className="signal-cockpit-gauge">
              <RingGauge percent={score} label="信号评分" size={92} tone={signalTone} />
              <div className="signal-cockpit-meta">
                <div className={`signal-cockpit-status ${toneClass(signalTone)}`}>{qualityLabel}</div>
                <div className="signal-cockpit-sub">
                  RSRP {SIGNAL_RSRP_RANGE[0]} ~ {SIGNAL_RSRP_RANGE[1]} dBm
                </div>
              </div>
            </div>

            <div className="signal-cockpit-bars">
              <QualityBar
                label="RSRP 接收功率"
                value={signal?.rsrp ?? null}
                domain={SIGNAL_RSRP_RANGE}
                unit=" dBm"
                tone={signalTone}
              />
              <QualityBar label="SINR 信噪比" value={sinr} domain={[-5, 25]} unit=" dB" tone={sinrTone(sinr)} />
              <QualityBar
                label="RSRQ 接收质量"
                value={signal?.rsrq ?? null}
                domain={[-20, -3]}
                unit=" dB"
                tone={rsrqTone(signal?.rsrq)}
              />
            </div>
          </div>

          <div className="chart-surface">
            <Sparkline
              height={96}
              minRange={6}
              independentScale
              empty="等待基带信号上报…"
              series={[
                {
                  label: 'RSRP',
                  tone: 'down',
                  values: rsrpHistory,
                  format: (v) => `${Math.round(v)} dBm`,
                },
                {
                  label: 'SINR',
                  tone: 'up',
                  values: sinrHistory,
                  dashed: true,
                  format: (v) => `${v.toFixed(1)} dB`,
                },
              ]}
            />
          </div>

          <div className="card-divider" />

          <Kv
            columns={4}
            dense
            items={[
              { label: '运营商', value: operator },
              { label: 'PLMN', value: reg?.plmn || '—' },
              { label: 'PCI', value: primaryCarrier?.pci ?? '—' },
              { label: '频点 ARFCN', value: primaryCarrier?.arfcn ?? '—' },
              { label: 'TAC', value: reg?.tac ?? '—' },
              { label: '小区 ID', value: reg?.cell || '—' },
              { label: '签约下行', value: kbps(data?.ambr?.net_dl) },
              { label: '签约上行', value: kbps(data?.ambr?.net_ul) },
              { label: 'RSSI', value: signal?.rssi != null ? `${signal.rssi} dBm` : '—' },
              { label: '定时提前量 TA', value: ta != null
                ? <span title="基带原始值，不能直接换算为米">{ta}</span>
                : !reg ? '—' : attached ? '未上报' : '未驻留' },
              { label: '拒绝原因', value: reg?.reject || '—' },
              { label: '会话 QoS', value: qosValue },
              ...(data?.cqi?.nr != null ? [{ label: 'NR CQI', value: data.cqi.nr }] : []),
              ...(data?.cqi?.lte != null ? [{ label: 'LTE CQI', value: data.cqi.lte }] : []),
              ...(extra ? [
                { label: '网络授时', value: nitzLabel(extra.nitz) || '未上报' },
                { label: '语音域注册', value: voiceReg },
                { label: '服务域', value: extra.srv_domain === 1 ? 'CS + PS' : extra.srv_domain === 0 ? '仅 PS（数据）' : '—' },
                { label: 'EN-DC 双连接', value: endc },
              ] : []),
            ]}
          />
          {qosDetail ? <p className="hint-line hint-line--tight">按活动承载：{qosDetail}</p> : null}
          {tdd ? <p className="hint-line hint-line--tight">5G TDD 帧结构：{tdd}</p> : null}
        </PageCard>

        <PageCard
          title="吞吐趋势与流量"
          hint="按接口字节增量实时计算"
          extra={traffic.iface ? <Tag color={TAG_COLOR.neutral}>{traffic.iface}</Tag> : null}
          bodyClassName="throughput-card-body"
        >
          <div className="chart-surface chart-surface--grow">
            <Sparkline
              fill
              height={168}
              minRange={0.5}
              empty="等待速率采样…"
              format={(v) => `${v.toFixed(2)} Mbps`}
              series={[
                { label: '下行', tone: 'down', values: speedHistory.map((p) => p.down) },
                { label: '上行', tone: 'up', values: speedHistory.map((p) => p.up), dashed: true },
              ]}
            />
          </div>

          <div className="card-divider" />

          <Kv
            columns={2}
            dense
            items={[
              { label: '累计接收', value: bytes(traffic.rx) },
              { label: '累计发送', value: bytes(traffic.tx) },
              { label: '承载接口', value: traffic.iface || '—' },
              { label: '链路速率', value: traffic.speed || '—' },
            ]}
          />
        </PageCard>
      </div>

      <section className="page-section">
        <SectionHeader title="服务载波" desc={!carriers.length && extraCCs.length ? '基带仅上报波束与接收链，未上报载波参数' : carrierSummary} />
        <div className="carrier-grid">
          {carriers.map((item, index) => (
            <div className={`carrier-card${item.primary ? ' carrier-card--primary' : ''}`} key={`${item.rat}-${item.arfcn}-${item.pci}-${index}`}>
              <div className="carrier-card-head">
                <div className="carrier-band-group">
                  <span className="carrier-band-code">{bandName(item.band, item.rat)}</span>
                  <div className="carrier-band-meta">
                    <span className="carrier-role">{item.primary ? '主载波 PCC' : '辅载波 SCC'}</span>
                    <span className="carrier-specs">PCI {item.pci}{item.bw ? ` · ${item.bw} MHz` : ''}</span>
                  </div>
                </div>
                <span className="service-actions">
                  {!item.primary && Number.isInteger(item.arfcn) && item.arfcn >= (item.rat === 'LTE' ? 0 : 1) ? (
                    <Button size="small" aria-label={`将 ${item.rat} ${item.arfcn} / PCI ${item.pci} 设为主小区`} icon={<IconLock size="small" aria-hidden="true" />} onClick={() => setLockTarget(
                      cells?.find((c) => c.rat === item.rat && c.arfcn === item.arfcn && c.pci === item.pci)
                        ?? { rat: item.rat, arfcn: item.arfcn, pci: item.pci, cell: '0', tac: 0, rsrp: Number.NaN })}>
                      设为主小区
                    </Button>
                  ) : null}
                  <Tag size="small" color={ratTagColor(item.rat)}>{item.rat}</Tag>
                </span>
              </div>
              <Kv dense columns={2} items={[
                { label: '频点 ARFCN', value: item.arfcn || (item.rat === 'LTE' && item.arfcn === 0 ? 0 : '—') },
                { label: '载波状态', value: item.primary ? '主载波' : item.state === 2 ? '已激活' : item.state === 1 ? '未激活' : '未上报' },
                { label: '下行层数 / 调制', value: metrics(item.dl) },
                { label: '上行层数 / 调制', value: metrics(item.ul) },
                { label: '基带下行吞吐', value: item.dl?.kbytes_s != null ? kbps(item.dl.kbytes_s * 8) : '—' },
                { label: '蜂窝上行 PUSCH', value: item.ul?.pusch_dbm != null ? `${item.ul.pusch_dbm} dBm` : '—' },
                ...(item===nrPrimary ? [
                  {label:'最佳波束',value:beamLabel(primaryBeam?.id)},
                  {label:'波束 RSRP',value:beamPower(primaryBeam?.power)},
                ] : []),
              ]} />
              {item===nrPrimary && <BeamDetails data={beams.data} cc="NR PCC" error={beams.error}/>}
            </div>
          ))}
          {!carriers.length && !extraCCs.length ? <div className="empty-surface">基带未上报服务载波</div> : null}
          {extraCCs.map(cc=>{
            const b=beams.data?.beams.find(row=>row.cc===cc);
            return <div className="carrier-card carrier-measurement" key={cc}>
              <div className="carrier-card-head"><strong>{cc==='NR PCC'?'主载波 PCC':cc || '未标识载波'}</strong>
                <Tag size="small" color={ratTagColor('NR')}>NR</Tag></div>
              <Kv dense items={[{label:'最佳波束',value:beamLabel(b?.id)},{label:'波束 RSRP',value:beamPower(b?.power)}]} />
              <BeamDetails data={beams.data} cc={cc} />
            </div>;
          })}
        </div>
      </section>

      <PageCard
        title="邻区监测"
        hint={`共 ${cells?.length ?? 0} 个测量小区 · 点击任意一行可快速锁定`}
        extra={
          <span className="neighbor-hint-badge">
            <IconLock size="small" />
            点击行锁定小区
          </span>
        }
      >
        <div className="neighbor-head">
          <span>制式</span>
          <span>频点</span>
          <span>PCI</span>
          <span>RSRP</span>
          <span>RSRQ</span>
          <span>SINR</span>
          <span>小区 ID</span>
          <span className="neighbor-head-bar">信号强度</span>
          <span className="neighbor-head-act" />
        </div>
        <div className="neighbor-list">
          {(cells || []).map((item, index) => {
            const pct = rsrpPercent(item.rsrp);
            const tone = scoreTone(pct);
            const onServingCell = lockMatch(item, serving) === 'matched';
            const cellSinr = item.sinr10 != null ? item.sinr10 / 10 : null;
            return (
              <div
                className={`neighbor-row${onServingCell ? ' is-serving' : ''}`}
                key={`${item.rat}-${item.arfcn}-${item.pci}-${index}`}
                role="button"
                tabIndex={0}
                aria-label={`锁定 ${item.rat} ${item.arfcn} PCI ${item.pci}`}
                onClick={() => setLockTarget(item)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' || event.key === ' ') {
                    event.preventDefault();
                    setLockTarget(item);
                  }
                }}
              >
                <span className={`neighbor-rat neighbor-rat--${item.rat.toLowerCase()}`}>{item.rat}</span>
                <span className="neighbor-freq">{item.arfcn}</span>
                <span className="neighbor-pci">{item.pci}</span>
                <span className={`neighbor-rsrp ${toneClass(tone)}`}>
                  {item.rsrp ?? '—'}
                  {item.rsrp != null && <i>dBm</i>}
                </span>
                <span className={`neighbor-quality ${toneClass(rsrqTone(item.rsrq))}`}>
                  {item.rsrq != null ? `${item.rsrq} dB` : '—'}
                </span>
                <span className={`neighbor-quality ${toneClass(sinrTone(cellSinr))}`}>
                  {cellSinr != null ? `${cellSinr} dB` : '—'}
                </span>
                <span className="neighbor-cell">
                  {item.cell && item.cell !== '0' ? (
                    <>
                      {onServingCell ? <em className="neighbor-serving-mark">主小区</em> : null}
                      <b>{item.cell}</b>
                    </>
                  ) : (
                    <i className="neighbor-cell-empty">未上报</i>
                  )}
                </span>
                <span className="neighbor-bar">
                  <Progress
                    percent={pct ?? 0}
                    stroke={toneColor(tone)}
                    showInfo={false}
                    aria-label={`PCI ${item.pci} 信号强度`}
                  />
                  <b className={toneClass(tone)}>{pct ?? '—'}%</b>
                </span>
                <span className="neighbor-action" aria-hidden="true">
                  <IconChevronRight size="small" />
                </span>
              </div>
            );
          })}
        </div>
        {!cells?.length ? (
          <div className="empty-inline">
            <Typography.Text type="tertiary">当前没有读取到邻区测量数据</Typography.Text>
          </div>
        ) : null}
      </PageCard>

      <LockCellModal
        cell={lockTarget}
        serving={lockTarget ? lockMatch(lockTarget, serving) === 'matched' : false}
        onClose={() => setLockTarget(null)}
        onDone={() => {
          setLockTarget(null);
          void load();
        }}
      />
    </div>
  );
};

export default Network;
