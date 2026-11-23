import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Banner, Button, Checkbox, Input, Space, Tag, Toast, Typography } from '@douyinfe/semi-ui';
import { IconLock, IconPlus, IconRefresh, IconUnlock } from '@douyinfe/semi-icons';
import { Field, PageCard, SectionHeader, TwoCol } from '@/ui/widgets';
import { ubus } from '@/services/deviceUbus';
import { Link, useSearchParams } from 'react-router-dom';
import { useCellularStream } from '@/modules/cellular/stream';
import { lockMatch, servingCarriers, type Overview } from '@/modules/cellular/telemetry';
import { TAG_COLOR, ratTagColor } from '@/ui/tokens';
import NetworkSelection from '@/modules/cellular/NetworkSelection';
import LockOptions from '@/modules/cellular/LockOptions';
import { useSdkAccess } from '@/modules/cellular/sdk';
import {
  applyError, campText, lockRequest, requestCellLock, waitForCamp, type CampTarget, type LockKind, type LockReply,
} from '@/modules/cellular/lockApply';
import {
  type Cell,
  type LockCandidate,
  type Rat,
  cellKey,
  cellLabel,
  toCandidate,
} from '@/modules/cellular/types';

type Candidate = Omit<LockCandidate, 'pci'> & { pci?: number };
const keyOf = (c: Candidate) => c.pci == null ? `${c.rat}:${c.arfcn}:any` : cellKey({ ...c, pci: c.pci });
const labelOf = (c: {rat: string; arfcn: number; pci?: number}) => c.pci == null
  ? `${c.rat} ${c.arfcn} · 任意 PCI` : cellLabel({ ...c, pci: c.pci });
type LockCell = { opt: number; rat: string; arfcn: number; pci: number; mode: number };
type Locks = {
  ok?: boolean;
  lock_api?: number;
  cell?: LockCell | null;
  /** 基带不提供白名单回读；这是后端记录的最近一次提交 */
  list?: Array<{ rat: string; arfcn: number; pci: number }> | null;
  current?: { lte: number[]; nr: number[] } | null;
  supported?: { lte: number[]; nr: number[] } | null;
};
const MAX_PER_RAT = 32;
const LIMIT: Record<Rat, { arfcn: number; pci: number }> = {
  NR: { arfcn: 3279165, pci: 1007 },
  LTE: { arfcn: 262143, pci: 503 },
};
const ERRORS: Record<string, string> = {
  timeout: '设备回执超时，规则可能已经写入。请先刷新锁定配置与实际驻留，不要重复提交。',
  input: '输入不合法，检查 ARFCN 与 PCI 的范围。',
  cell_read: '基带读不到当前锁定状态。',
  cell_write: '基带拒绝了单小区锁定请求。',
  readback: '写入后配置回读不一致，请刷新确认当前配置。',
  single_lock: '当前有单小区锁，先解除再提交白名单。',
  cell_list_write: '基带拒绝了白名单请求。',
  cell_duplicate: '白名单里有重复小区。',
  cell_min: '白名单至少要两个小区。',
  busy: '上一条指令还在执行，稍后再试。',
  ril_init: '蜂窝接口初始化失败。',
};

const pickError = (error: unknown) => {
  const text = error instanceof Error ? error.message : '';
  return ERRORS[text] || text || '操作失败';
};

const Chips: React.FC<{
  values: Array<number | string>;
  selected: Array<number | string>;
  prefix?: string;
  onToggle: (value: any) => void;
  empty?: string;
}> = ({ values, selected, prefix = '', onToggle, empty }) => (
  <div className="band-chips">
    {values.map((value) => {
      const isSelected = selected.includes(value);
      return (
        <button
          type="button"
          key={String(value)}
          className={`band-chip${isSelected ? ' active' : ''}`}
          aria-pressed={isSelected}
          onClick={() => onToggle(value)}
        >
          {prefix}
          {value}
        </button>
      );
    })}
    {!values.length ? <Typography.Text type="tertiary">{empty || '没有可选值'}</Typography.Text> : null}
  </div>
);

const Settings: React.FC = () => {
  const access = useSdkAccess();
  const [locks, setLocks] = useState<Locks | null>(null);
  const [overview, setOverview] = useState<Overview | null>(null);
  const { snapshot: live, status: liveStatus } = useCellularStream(true);
  const [query] = useSearchParams();
  const manualEntry = useRef<HTMLDivElement>(null);
  const readingOverview = useRef(false);
  const [nrBands, setNrBands] = useState<number[]>([]);
  const [lteBands, setLteBands] = useState<number[]>([]);
  const [manual, setManual] = useState<{ rat: Rat; arfcn: string; pci: string }>(() => {
    const rat = query.get('rat');
    const arfcn = query.get('arfcn') || '';
    const pci = query.get('pci') || '';
    return (rat === 'NR' || rat === 'LTE') && /^\d{1,7}$/.test(arfcn) && /^\d{1,4}$/.test(pci)
      ? { rat, arfcn, pci } : { rat: 'NR', arfcn: '', pci: '' };
  });
  const [picked, setPicked] = useState<Candidate[]>([]);
  const [choice, setKind] = useState<LockKind>('cell');
  const [applyNow, setApplyNow] = useState(true);
  const extended = locks?.lock_api === 2;
  const kind = extended ? choice : 'cell';
  const apply = extended && applyNow;
  const writing = useRef(false);
  const [busy, setBusy] = useState('');
  const [loading, setLoading] = useState(false);
  const [note, setNote] = useState('');

  const readOverview = useCallback(async () => {
    if (readingOverview.current) return;
    readingOverview.current = true;
    try {
      const next = await ubus<Overview>('dlink-cellular', 'overview');
      setOverview(next.ok === true ? next : null);
    } catch { setOverview(null); }
    finally { readingOverview.current = false; }
  }, []);

  useEffect(() => { if (live) setOverview(live); }, [live]);
  useEffect(() => {
    if (query.has('arfcn')) manualEntry.current?.scrollIntoView({ block: 'center' });
  }, [query]);
  useEffect(() => {
    if (liveStatus === 'live') return;
    const id = window.setInterval(() => { if (!document.hidden) void readOverview(); }, 5000);
    return () => window.clearInterval(id);
  }, [liveStatus, readOverview]);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      // dlink-cellular 后端用非阻塞文件锁，两条请求并发到达会有一条直接返回 busy，必须串行取。
      const lockState = await ubus<Locks>('dlink-cellular', 'locks');
      if (lockState.ok === false) throw new Error('busy');
      setLocks(lockState);
      if (lockState.current?.nr?.length) setNrBands(lockState.current.nr);
      if (lockState.current?.lte?.length) setLteBands(lockState.current.lte);

      await readOverview();
    } finally {
      setLoading(false);
    }
  }, [readOverview]);

  useEffect(() => {
    load().catch((error) => Toast.error(pickError(error)));
  }, [load]);

  const run = async (name: string, task: () => Promise<unknown>, ok: string) => {
    if (writing.current) return;
    writing.current = true;
    setBusy(name);
    setNote('');
    try {
      await task();
      setNote(ok);
      Toast.success(ok);
      await load().catch(() => setNote(ok + '；暂未刷新状态。'));
    } catch (error) {
      const text = pickError(error);
      setNote(text);
      Toast.error(text);
    } finally {
      writing.current = false;
      setBusy('');
    }
  };

  // 锁定只改变基带的选网规则；勾选「立即重新驻留」时后端重启射频，这里再核对实际主小区。
  const lockAction = async (name: string, task: () => Promise<LockReply>, ok: string, target: CampTarget, lockKind: LockKind) => {
    if (writing.current) return;
    writing.current = true;
    setBusy(name);
    setNote('');
    try {
      const reply = await task();
      if (reply.recorded === false) ok += '；未能保存本地白名单记录';
      if (reply.applied) {
        setNote(`${ok}；射频已重启，正在重新驻留…`);
        const result = await waitForCamp(target, lockKind, (s) => setNote(`${ok}；射频已重启，正在重新驻留…已等待 ${s} 秒`));
        const text = `${ok}；${campText(result, target, lockKind)}`;
        setNote(text);
        if (result === 'matched' && reply.recorded !== false) Toast.success(text); else Toast.warning(text);
      } else {
        const warn = applyError(reply.apply_error);
        setNote(warn ? `${ok}；${warn}` : `${ok}；将在基带下次重选小区时生效`);
        if (reply.apply_error === 'radio_off') Toast.error(warn); else if (warn || reply.recorded === false) Toast.warning(warn || ok); else Toast.success(ok);
      }
      await load().catch(() => undefined);
    } catch (error) {
      const text = pickError(error);
      setNote(text);
      Toast.error(text);
    } finally {
      writing.current = false;
      setBusy('');
    }
  };

  const lockCell = locks?.cell;
  const singleLocked = Boolean(lockCell?.opt);
  const whitelist = locks?.list || [];

  const serving = servingCarriers(overview);
  const match = !lockCell?.opt ? 'unknown'
    : lockCell.opt === 2
      ? serving.some((s) => s.rat === lockCell.rat && s.arfcn === lockCell.arfcn) ? 'matched' : serving.length ? 'different' : 'unknown'
      : lockMatch(lockCell, serving);
  const inWhitelist = serving.some((s) => whitelist.some((w) => w.rat === s.rat && w.arfcn === s.arfcn && w.pci === s.pci));
  const lockTitle = lockCell?.opt === 2 ? `${lockCell.rat} 频点 ${lockCell.arfcn} · 任意 PCI`
    : lockCell?.opt ? `${lockCell.rat} ${lockCell.arfcn} / PCI ${lockCell.pci}` : '';
  const reapply = () => {
    if (!extended || !lockCell?.opt) return;
    const lockKind = lockCell.opt === 2 ? 'arfcn' : 'cell';
    void lockAction('reapply', () => requestCellLock(lockCell, lockKind, true, extended),
      `重新应用锁定 ${lockTitle}`, lockCell, lockKind);
  };
  const candidates = useMemo<LockCandidate[]>(
    () => (overview?.cells || []).filter((item: Cell) => item.rat === 'NR' || item.rat === 'LTE').map(toCandidate),
    [overview?.cells],
  );

  const togglePicked = (item: Candidate) => {
    const key = keyOf(item);
    if (picked.some((entry) => keyOf(entry) === key)) {
      setPicked(picked.filter((entry) => keyOf(entry) !== key));
      return;
    }
    if (picked.filter((entry) => entry.rat === item.rat).length >= MAX_PER_RAT) {
      Toast.warning(`${item.rat} 最多选 ${MAX_PER_RAT} 个`);
      return;
    }
    setPicked([...picked, { rat: item.rat, arfcn: item.arfcn, pci: item.pci, rsrp: item.rsrp, cell: item.cell }]);
  };

  const addManual = () => {
    const { rat } = manual;
    const arfcn = Number(manual.arfcn);
    const pci = Number(manual.pci);
    if (!/^\d+$/.test(manual.arfcn.trim()) || !Number.isInteger(arfcn) || arfcn < (rat === 'LTE' ? 0 : 1) || arfcn > LIMIT[rat].arfcn) {
      setNote(`ARFCN 超出 ${rat} 的范围（${rat === 'LTE' ? 0 : 1}-${LIMIT[rat].arfcn}）`);
      return;
    }
    const anyPci = kind === 'arfcn' && manual.pci.trim() === '';
    if (!anyPci && (!/^\d+$/.test(manual.pci.trim()) || !Number.isInteger(pci) || pci < 0 || pci > LIMIT[rat].pci)) {
      setNote(`PCI 超出 ${rat} 的范围（0-${LIMIT[rat].pci}）`);
      return;
    }
    togglePicked({ rat, arfcn, pci: anyPci ? undefined : pci });
    setManual({ ...manual, arfcn: '', pci: '' });
  };

  const toggleBand = (list: number[], setList: (next: number[]) => void, band: number) =>
    setList(list.includes(band) ? list.filter((item) => item !== band) : [...list, band].sort((a, b) => a - b));

  const pickedOne = picked.length === 1 ? picked[0] : null;
  const hasFrequencyOnly = picked.some(item => item.pci == null);
  const canSubmitList = picked.length >= 2 && !singleLocked && !hasFrequencyOnly;

  const clearCellLocks = () =>
    lockAction(
      'clear',
      async () => {
        await lockRequest('cell_clear', {});
        try { return await lockRequest('cell_list_clear', extended ? { apply } : {}); }
        catch (error) { await load().catch(() => undefined); throw new Error('单锁已解除；白名单解除未确认：' + pickError(error)); }
      },
      '已解除小区锁定和白名单',
      null,
      'cell',
    );

  return (
    <div className="page-stack">
      {/* 当前生效锁定状态 */}
      <PageCard
        variant="hero"
        title="锁定配置与实际驻留"
        hint={extended ? '按实际驻留的主小区核对；立即重新驻留会短暂重启射频' : '按实际驻留的主小区核对'}
        extra={
          <Space spacing={8}>
            {singleLocked || whitelist.length ? (
              <Button size="small" type="danger" icon={<IconUnlock />} loading={busy === 'clear'} disabled={!!busy || loading} onClick={clearCellLocks}>
                {apply ? '解除并重新驻留' : '解除锁定'}
              </Button>
            ) : null}
            <Link to="/engineering?to=scan" className="engineering-link">扫小区</Link>
            <Button size="small" icon={<IconRefresh />} loading={loading} onClick={() => void load().catch((error) => Toast.error(pickError(error)))}>
              刷新
            </Button>
          </Space>
        }
      >
        <div className="status-grid">
          <div className={`status-box${singleLocked || whitelist.length ? ' status-box--warn' : ' status-box--ok'}`}>
            <div className="status-box-label">
              {singleLocked || whitelist.length ? <IconLock size="small" /> : <IconUnlock size="small" />}
              {lockCell?.opt === 2 ? '频点锁' : singleLocked ? '主小区锁（PCC）' : whitelist.length ? '小区白名单' : '小区锁定'}
            </div>
            <div className="status-box-value">
              {singleLocked ? (
                <div className="status-lock-info">
                  <Tag color={TAG_COLOR.warning}>{lockTitle}</Tag>
                  <span className="status-box-sub">
                    配置已回读 · {match === 'matched' ? '已驻留目标' : match === 'different' ? '仍驻留其他小区，锁定尚未生效' : '未能确认驻留'}
                  </span>
                  {extended && match === 'different' ? (
                    <Button size="small" theme="solid" loading={busy === 'reapply'} disabled={!!busy} onClick={reapply}>
                      重启射频并重新驻留
                    </Button>
                  ) : null}
                </div>
              ) : whitelist.length ? (
                <div className="status-lock-info">
                  <Tag color={TAG_COLOR.warning}>{whitelist.length} 个小区</Tag>
                  <span className="status-box-sub">
                    最近一次提交（基带不提供回读）· {serving.length ? inWhitelist ? '主小区在白名单内' : '主小区不在白名单内' : '未读到服务小区'}
                  </span>
                  <span className="status-box-sub">{whitelist.map(labelOf).join(' · ')}</span>
                </div>
              ) : (
                <div className="status-lock-info">
                  <Tag color={TAG_COLOR.neutral}>{lockCell ? '未设置单小区锁' : '未读到锁定配置'}</Tag>
                  <span className="status-box-sub">{serving.length ? `主小区 ${serving.map(labelOf).join(' · ')}` : '未读到服务小区'}</span>
                </div>
              )}
            </div>
          </div>

          <div className="status-box">
            <div className="status-box-label">
              已配置 5G NR 频段
              <span className="kv-count">{locks?.current?.nr?.length ?? 0}</span>
            </div>
            <div className="band-chips band-chips--readonly">
              {(locks?.current?.nr || []).map((band) => (
                <span className="band-chip active" key={`nr-${band}`}>
                  n{band}
                </span>
              ))}
              {!locks?.current?.nr?.length ? <Typography.Text type="tertiary">尚未读到</Typography.Text> : null}
            </div>
          </div>

          <div className="status-box">
            <div className="status-box-label">
              已配置 4G LTE 频段
              <span className="kv-count">{locks?.current?.lte?.length ?? 0}</span>
            </div>
            <div className="band-chips band-chips--readonly">
              {(locks?.current?.lte || []).map((band) => (
                <span className="band-chip active" key={`lte-${band}`}>
                  B{band}
                </span>
              ))}
              {!locks?.current?.lte?.length ? <Typography.Text type="tertiary">尚未读到</Typography.Text> : null}
            </div>
          </div>
        </div>

        {note ? (
          <div className="status-note">
            <Typography.Text type="secondary" size="small">
              {note}
            </Typography.Text>
          </div>
        ) : null}
      </PageCard>

      {/* 频段锁定 */}
      <section className="page-section">
        <SectionHeader title="锁频段" desc="点选需要保留的频段；全部取消并应用即恢复自动选择" />
        <TwoCol>
          <PageCard
            title="5G NR 频段"
            hint={nrBands.length ? `已选 ${nrBands.length} 个频段` : '未勾选（应用后恢复自动）'}
            extra={<Tag color={ratTagColor('NR')}>NR</Tag>}
            footer={
              <>
                <Button size="small" onClick={() => setNrBands(locks?.supported?.nr || [])}>
                  全选
                </Button>
                <Button size="small" onClick={() => setNrBands([])}>
                  全不选
                </Button>
                <Button
                  size="small"
                  theme="solid"
                  type="primary"
                  loading={busy === 'nr'}
                  onClick={() =>
                    run(
                      'nr',
                      () =>
                        lockRequest('band_set', {
                          rat: 'NR',
                          bands: nrBands.length ? nrBands.join(',') : 'auto',
                          confirm: true,
                        }),
                      'NR 频段已应用',
                    )
                  }
                >
                  应用 NR 频段
                </Button>
              </>
            }
          >
            <Chips
              values={locks?.supported?.nr || []}
              selected={nrBands}
              prefix="n"
              onToggle={(band) => toggleBand(nrBands, setNrBands, band)}
              empty="没有读到支持的 NR 频段"
            />
          </PageCard>

          <PageCard
            title="4G LTE 频段"
            hint={lteBands.length ? `已选 ${lteBands.length} 个频段` : '未勾选（应用后恢复自动）'}
            extra={<Tag color={ratTagColor('LTE')}>LTE</Tag>}
            footer={
              <>
                <Button size="small" onClick={() => setLteBands(locks?.supported?.lte || [])}>
                  全选
                </Button>
                <Button size="small" onClick={() => setLteBands([])}>
                  全不选
                </Button>
                <Button
                  size="small"
                  theme="solid"
                  type="primary"
                  loading={busy === 'lte'}
                  onClick={() =>
                    run(
                      'lte',
                      () =>
                        lockRequest('band_set', {
                          rat: 'LTE',
                          bands: lteBands.length ? lteBands.join(',') : 'auto',
                          confirm: true,
                        }),
                      'LTE 频段已应用',
                    )
                  }
                >
                  应用 LTE 频段
                </Button>
              </>
            }
          >
            <Chips
              values={locks?.supported?.lte || []}
              selected={lteBands}
              prefix="B"
              onToggle={(band) => toggleBand(lteBands, setLteBands, band)}
              empty="没有读到支持的 LTE 频段"
            />
          </PageCard>
        </TwoCol>
      </section>

      {/* 小区锁定 */}
      <section className="page-section">
        <SectionHeader
          title="小区锁定与白名单"
          desc={extended ? '选一个小区可锁定主小区或只锁频点；选多个可提交白名单' : '选一个小区锁定为主小区，选多个可提交白名单'}
        />
        <PageCard
          title="候选小区"
          hint={
            picked.length === 0
              ? '勾选下方基带测量到的小区，或手动输入频点与 PCI'
              : picked.length === 1 && hasFrequencyOnly && kind === 'cell'
                ? '精确锁定需要 PCI，请选「只锁频点」或移除后补全小区'
              : picked.length === 1
                ? kind === 'arfcn' ? '已选 1 个小区：将锁定它的频点，允许在该频点的小区间切换' : '已选 1 个小区：将锁定为主小区（PCC）'
                : hasFrequencyOnly ? '白名单每项都需要 PCI，请移除「任意 PCI」项并补全后再添加' : `已选 ${picked.length} 个小区，可提交白名单`
          }
          footer={
            <div className="lock-footer-bar">
              {extended ? <LockOptions kind={picked.length <= 1 ? kind : undefined} onKind={setKind}
                apply={applyNow} onApply={setApplyNow} disabled={!!busy} /> : locks && <Typography.Text type="tertiary" size="small">当前后端不支持只锁频点或立即重选。</Typography.Text>}
              <div className="action-row">
                <Button type="danger" loading={busy === 'clear'} disabled={!locks?.ok || !!busy || loading} onClick={clearCellLocks}>
                  解除全部小区锁
                </Button>
                {picked.length > 0 ? <Button onClick={() => setPicked([])}>清空选择</Button> : null}
                <Button
                  theme="solid"
                  type="primary"
                  disabled={!locks?.ok || !pickedOne || (kind === 'cell' && hasFrequencyOnly) || !!busy || loading}
                  loading={busy === 'cell'}
                  onClick={() => {
                    if (!pickedOne) return;
                    void lockAction(
                      'cell',
                      () => requestCellLock(pickedOne, kind, apply, extended),
                      kind === 'arfcn' ? `已锁定频点 ${pickedOne.rat} ${pickedOne.arfcn}` : `已锁定主小区 ${labelOf(pickedOne)}`,
                      pickedOne,
                      kind,
                    );
                  }}
                >
                  {kind === 'arfcn' ? '锁定频点' : '锁定主小区'}
                </Button>
                <Button
                  theme="solid"
                  type="primary"
                  disabled={!locks?.ok || !canSubmitList || !!busy || loading}
                  loading={busy === 'list'}
                  onClick={() =>
                    void lockAction(
                      'list',
                      () => lockRequest('cell_list_set', {
                        cells: picked.map((item) => `${item.rat}:${item.arfcn}:${item.pci}`).join(','),
                        ...(extended ? { apply } : {}),
                      }),
                      `已提交 ${picked.length} 个小区的白名单`,
                      picked,
                      'cell',
                    )
                  }
                >
                  提交白名单{picked.length >= 2 ? `（${picked.length}）` : ''}
                </Button>
              </div>
            </div>
          }
        >
          {singleLocked ? (
            <Banner
              type="warning"
              closeIcon={null}
              description="当前已有单小区锁。直接锁定新小区会覆盖现有设置；如需提交白名单，请先点击「解除锁定」。"
              className="card-banner"
            />
          ) : whitelist.length ? (
            <Banner
              type="warning"
              closeIcon={null}
              description="这里显示最近提交的白名单，不是基带回读。要改为单小区锁，请先解除全部小区锁。"
              className="card-banner"
            />
          ) : null}

          <div className="manual-entry-box" id="manual-cell" ref={manualEntry}>
            <div className="manual-row">
              <Field label="制式">
                <div className="segmented-control" role="radiogroup" aria-label="选择制式">
                  {(['NR', 'LTE'] as Rat[]).map((rat) => (
                    <button
                      type="button"
                      key={rat}
                      className={`segmented-btn${manual.rat === rat ? ' is-active' : ''}`}
                      onClick={() => setManual({ ...manual, rat })}
                    >
                      {rat}
                    </button>
                  ))}
                </div>
              </Field>
              <Field label="ARFCN 频点" hint={`范围 1 ~ ${LIMIT[manual.rat].arfcn}`}>
                <Input
                  value={manual.arfcn}
                  onChange={(value) => setManual({ ...manual, arfcn: value })}
                  placeholder="例如 627264"
                />
              </Field>
              <Field label="PCI" hint={`范围 0 ~ ${LIMIT[manual.rat].pci}`}>
                <Input
                  value={manual.pci}
                  onChange={(value) => setManual({ ...manual, pci: value })}
                  placeholder="例如 391"
                />
              </Field>
              <Button icon={<IconPlus />} onClick={addManual} className="manual-add-btn">
                加入列表
              </Button>
            </div>
          </div>

          <div className="candidate-head">
            <span />
            <span>制式</span>
            <span>频点 ARFCN</span>
            <span>PCI</span>
            <span>RSRP</span>
            <span className="candidate-head-status">状态</span>
          </div>
          <div className="candidate-list">
            {candidates.map((item) => {
              const active = picked.some((entry) => keyOf(entry) === keyOf(item));
              const lockedHere = Boolean(
                locks?.cell?.opt &&
                  locks.cell.rat === item.rat &&
                  locks.cell.arfcn === item.arfcn &&
                  (locks.cell.opt === 2 || locks.cell.pci === item.pci),
              );
              return (
                <label className={`candidate-row${active ? ' active' : ''}`} key={keyOf(item)}>
                  <Checkbox checked={active} onChange={() => togglePicked(item)} />
                  <span className={`neighbor-rat neighbor-rat--${item.rat.toLowerCase()}`}>{item.rat}</span>
                  <span className="candidate-freq">{item.arfcn}</span>
                  <span className="candidate-pci">PCI {item.pci}</span>
                  <span className="candidate-rsrp">{item.rsrp != null ? `${item.rsrp} dBm` : '—'}</span>
                  <span className="candidate-lock">
                    {lockedHere ? (
                      <Tag color={TAG_COLOR.warning} size="small">
                        {lockCell?.opt === 2 ? '锁定频点' : '锁定目标'}
                      </Tag>
                    ) : null}
                    {lockMatch(item, serving) === 'matched' ? (
                      <Tag color={TAG_COLOR.success} size="small">
                        驻留中
                      </Tag>
                    ) : null}
                  </span>
                </label>
              );
            })}
            {!candidates.length ? (
              <div className="empty-inline">
                <Typography.Text type="tertiary">暂无候选小区，请先在「网络状态」页刷新测量。</Typography.Text>
              </div>
            ) : null}
          </div>

          <div className="draft-tray">
            <span className="draft-tray-label">已选待提交</span>
            <div className="draft-chips">
              {picked.map((item) => (
                <span className="draft-chip" key={keyOf(item)}>
                  {labelOf(item)}
                  <button type="button" aria-label={`移除 ${labelOf(item)}`} onClick={() => togglePicked(item)}>
                    ×
                  </button>
                </span>
              ))}
              {!picked.length ? (
                <Typography.Text type="tertiary" size="small">
                  未选择小区
                </Typography.Text>
              ) : null}
            </div>
          </div>

          <Typography.Text type="tertiary" size="small" className="hint-line">
            白名单至少 2 个、每种制式最多 {MAX_PER_RAT} 个；基带不支持白名单回读，提交后可能短暂中断蜂窝数据。与 LuCI 蜂窝页共用本机 dlink-cellular 接口。
          </Typography.Text>
        </PageCard>
      </section>

      {access?.sdk ? <NetworkSelection /> : null}
    </div>
  );
};

export default Settings;
