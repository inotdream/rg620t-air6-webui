import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Button, Modal, Select, Tag, Toast, Typography } from '@douyinfe/semi-ui';
import { PageCard, RefreshBtn, SectionHeader, TwoCol } from '@/ui/widgets';
import { ubus } from '@/services/deviceUbus';
import { TAG_COLOR, ratTagColor } from '@/ui/tokens';
import { Toggle } from './DeviceControls';
import { engineeringError } from './engineering';
import {
  NETWORK_STATUS, NW_MODES, nwModeLabel, operatorLabel, RAT_NAMES, RAT_TO_ACT, SCAN_STATES,
  type PlmnScan, type RadioState, type ScanNetwork,
} from './sdk';

type Reply = { ok?: boolean; error?: string; pending?: boolean };

async function write(method: string, params: Record<string, unknown>) {
  const reply = await ubus<Reply>('dlink-cellular', method, { ...params, confirm: true });
  if (reply.ok !== true) throw new Error(reply.error || 'readback');
  return reply;
}

const confirm = (title: string, content: string, okText: string, onOk: () => Promise<void>) =>
  Modal.confirm({
    title, content, okText, cancelText: '取消',
    okButtonProps: { type: 'danger', theme: 'solid', 'aria-label': okText },
    onOk: () => onOk().catch((error) => { Toast.error(engineeringError(error)); }),
  });

export default function NetworkSelection() {
  const [radio, setRadio] = useState<RadioState | null>(null);
  const [scan, setScan] = useState<PlmnScan | null>(null);
  const [mode, setMode] = useState<number | undefined>();
  const [loading, setLoading] = useState(false);
  const [problem, setProblem] = useState('');
  const reading = useRef(false);

  const load = useCallback(async () => {
    if (reading.current) return;
    reading.current = true;
    setLoading(true);
    setProblem('');
    try {
      const next = await ubus<RadioState>('dlink-cellular', 'sdk_radio');
      if (next.ok !== true) throw new Error(next.error || 'nw_read');
      setRadio(next);
      setMode(next.nwmode ?? undefined);
      setScan(await ubus<PlmnScan>('dlink-cellular', 'plmn_scan_status').catch(() => null));
    } catch (error) {
      setProblem(engineeringError(error));
    } finally {
      reading.current = false;
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const scanning = scan?.state === 'running';
  useEffect(() => {
    if (!scanning) return undefined;
    const id = window.setInterval(() => {
      ubus<PlmnScan>('dlink-cellular', 'plmn_scan_status')
        .then((next) => {
          setScan(next);
          if (next.state !== 'running') void load();
        })
        .catch(() => undefined);
    }, 2000);
    return () => window.clearInterval(id);
  }, [scanning, load]);

  const knownMode = NW_MODES.some((m) => m.value === radio?.nwmode);
  const selection = radio?.selection;

  const applyMode = () => {
    if (mode == null || radio?.nwmode == null || mode === radio.nwmode) return;
    confirm(`切换为「${nwModeLabel(mode)}」？`, '基带会重新搜网，蜂窝数据可能中断几十秒；局域网与 Wi-Fi 不受影响。', '切换', async () => {
      await write('nwmode_set', { value: mode, expected: radio.nwmode });
      Toast.success(`已切换为${nwModeLabel(mode)}，基带已读回`);
      await load();
    });
  };

  const toggleAirplane = () => {
    if (typeof radio?.airplane !== 'boolean') return;
    const enable = !radio.airplane;
    confirm(enable ? '开启飞行模式？' : '关闭飞行模式？',
      enable ? '蜂窝射频将关闭，上网、短信和通话都会中断，直到关闭飞行模式。局域网管理不受影响。'
        : '基带将重新开启射频并注册网络，通常 10–30 秒后恢复上网。',
      enable ? '开启' : '关闭', async () => {
        await write('airplane_set', { enabled: enable, expected: radio.airplane });
        Toast.success(enable ? '飞行模式已开启' : '飞行模式已关闭，正在重新注册');
        await load();
      });
  };

  const startScan = () => confirm('搜索附近运营商？', '搜索约需 1–3 分钟。期间蜂窝数据可能中断，短信与其他基带操作需等待搜索结束。', '开始搜索', async () => {
    await write('plmn_scan_start', {});
    setScan({ ok: true, state: 'running', networks: [] });
  });

  const register = (net: ScanNetwork) => {
    const act = net.rat != null ? RAT_TO_ACT[net.rat] : undefined;
    if (!net.name.plmn || !act) return;
    const label = `${operatorLabel(net.name)}（${net.name.plmn} · ${RAT_NAMES[net.rat!]}）`;
    confirm(`手动注册到 ${label}？`, '设备将只驻留这个网络。若它拒绝注册或信号消失，设备会失去服务；可随时点「恢复自动选网」。', '注册', async () => {
      const reply = await write('plmn_set', { mode: 'manual', plmn: net.name.plmn, act });
      Toast.success(reply.pending ? '已提交手动注册，基带仍在处理，请稍后刷新' : `已注册到 ${label}`);
      await load();
    });
  };

  const automatic = () => confirm('恢复自动选网？', '基带将按 SIM 卡的首选列表自动选择运营商，可能短暂重新注册。', '恢复自动', async () => {
    const reply = await write('plmn_set', { mode: 'auto' });
    Toast.success(reply.pending ? '已提交，基带仍在重新注册' : '已恢复自动选网');
    await load();
  });

  return (
    <section className="page-section">
      <SectionHeader title="网络模式与选网" desc="限定使用的制式、临时关闭射频，或手动选择运营商"
        extra={<RefreshBtn label="刷新" loading={loading} onClick={() => void load()} />} />
      {problem && <Typography.Text type="danger" size="small">{problem}</Typography.Text>}
      <TwoCol>
        <PageCard title="网络模式" hint="与工程工具里的 SA/NSA 接入策略叠加生效">
          <div className="engineering-setting">
            <div className="engineering-setting-label">
              <strong>允许的制式</strong>
              <span>当前：{nwModeLabel(radio?.nwmode)}</span>
            </div>
            <Select size="small" aria-label="网络模式" value={mode} disabled={!knownMode || scanning}
              optionList={NW_MODES.map((m) => ({ label: m.label, value: m.value }))}
              onChange={(value) => setMode(Number(value))} />
            <Button size="small" theme="solid" disabled={!knownMode || scanning || mode === radio?.nwmode} onClick={applyMode}>应用</Button>
          </div>
          <Toggle name="飞行模式" value={radio?.airplane} disabled={scanning} onChange={toggleAirplane} />
          {!knownMode && radio?.nwmode != null && (
            <p className="service-note">基带当前处于界面未列出的模式（{radio.nwmode}），为避免误改，此处不提供切换。</p>
          )}
        </PageCard>

        <PageCard
          title="运营商选择"
          hint={selection ? (selection.mode === 'manual' ? `手动注册 ${selection.plmn || ''}` : '自动选网') : '选网方式未读到'}
          extra={selection?.mode === 'manual'
            ? <Button size="small" disabled={scanning} onClick={automatic}>恢复自动选网</Button> : null}
        >
          <div className="service-actions">
            <Button size="small" theme="solid" loading={scanning} disabled={scanning} onClick={startScan}>
              {scanning ? '正在搜索' : '搜索运营商'}
            </Button>
            {scan?.state && scan.state !== 'idle' && (
              <span className="service-note">{SCAN_STATES[scan.state] ?? scan.state}{scan.error ? `（${engineeringError(scan.error)}）` : ''}</span>
            )}
          </div>
          {!!scan?.networks?.length && (
            <ul className="plmn-list">
              {scan.networks.map((net, index) => {
                const status = net.status != null ? NETWORK_STATUS[net.status] : undefined;
                const rat = net.rat != null ? RAT_NAMES[net.rat] : undefined;
                const current = net.status === 1;
                return (
                  <li className="plmn-row" key={`${net.name.plmn}-${net.rat}-${index}`}>
                    <div className="plmn-name">
                      <strong>{operatorLabel(net.name) || '未命名网络'}</strong>
                      <small>{net.name.plmn}{net.name.short && net.name.short !== net.name.long ? ` · ${net.name.short}` : ''}</small>
                    </div>
                    <span className="service-actions">
                      {rat && <Tag size="small" color={ratTagColor(rat.includes('5G') ? 'NR' : rat)}>{rat}</Tag>}
                      {status && <Tag size="small" color={TAG_COLOR[status.tone]}>{status.label}</Tag>}
                    </span>
                    <Button size="small" disabled={scanning || current || net.status === 5 || !(net.rat != null && RAT_TO_ACT[net.rat])}
                      onClick={() => register(net)}>{current ? '已驻留' : '注册'}</Button>
                  </li>
                );
              })}
            </ul>
          )}
          {scan?.state === 'complete' && !scan.networks?.length && <p className="service-note">基带没有返回可用网络。</p>}
        </PageCard>
      </TwoCol>
    </section>
  );
}
