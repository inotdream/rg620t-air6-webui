import React, { useEffect, useRef, useState } from 'react';
import { Banner, Button, Modal, Tag, Toast, Typography } from '@douyinfe/semi-ui';
import { ubus } from '@/services/deviceUbus';
import { type Cell, cellKey, cellLabel } from './types';
import { TAG_COLOR, ratTagColor } from '@/ui/tokens';
import LockOptions from './LockOptions';
import { applyError, campText, lockRequest, requestCellLock, waitForCamp, type LockKind, type LockReply } from './lockApply';

const ERRORS: Record<string, string> = {
  timeout: '设备回执超时，规则可能已经写入。请先刷新锁定配置与实际驻留，不要重复提交。',
  input: '输入不合法，检查 ARFCN 与 PCI 的范围。',
  cell_read: '基带读不到当前锁定状态。',
  cell_write: '基带拒绝了锁定请求。',
  readback: '写入后配置回读不一致，请刷新确认当前配置。',
  busy: '上一条指令还在执行，稍后再试。',
  ril_init: '蜂窝接口初始化失败。',
};

const pickError = (error: unknown) => {
  const text = error instanceof Error ? error.message : '';
  return ERRORS[text] || text || '操作失败';
};

type Config = { extended: boolean; opt: number; rat: string; arfcn: number; pci: number; mode: number };
type Props = { cell: Cell; serving?: boolean; onClose: () => void; onDone: () => void };
type Phase = { step: 'idle' } | { step: 'watching'; seconds: number } | { step: 'result'; tone: 'success' | 'warning' | 'danger'; text: string };

async function readConfig(): Promise<Config> {
  const r = await ubus<{ok?: boolean; lock_api?: number; cell?: Omit<Config, 'extended'> | null; error?: string}>('dlink-cellular', 'locks');
  const c = r.cell;
  if (!r.ok || !c || ![0,1,2].includes(c.opt) ||
    (c.opt !== 0 && (!c.rat || !Number.isInteger(c.arfcn) || c.arfcn < (c.rat === 'LTE' ? 0 : 1) ||
      (c.opt === 1 && (!Number.isInteger(c.pci) || c.pci < 0))))) throw Error(r.error || 'cell_read');
  return { ...c, extended: r.lock_api === 2 };
}
const sameConfig = (a: Config, b: Config) => a.extended === b.extended && a.opt === b.opt &&
  (!a.opt || (a.mode === b.mode && a.rat === b.rat && a.arfcn === b.arfcn && (a.opt === 2 || a.pci === b.pci)));

const TargetDialog: React.FC<Props> = ({ cell, serving, onClose, onDone }) => {
  const [config,setConfig] = useState<Config | null>(null);
  const [note,setNote] = useState('');
  const [busy,setBusy] = useState(false);
  const [attempt,retry] = useState(0);
  const [kind,setKind] = useState<LockKind>('cell');
  const [apply,setApply] = useState(true);
  const [phase,setPhase] = useState<Phase>({ step: 'idle' });
  const submitting = useRef(false);
  useEffect(() => {
    let active = true;
    readConfig().then(c => { if(active)setConfig(c); }, e => { if(active)setNote(pickError(e)); });
    return () => {active=false;};
  }, [attempt]);

  // 这个小区就是当前锁定目标：可以解除，或在仍驻留别处时立即生效。频点锁下点某个小区则是改为精确锁定。
  const covered = (config?.opt === 1 && cellKey(config) === cellKey(cell)) ||
    (config?.extended && config.opt === 2 && kind === 'arfcn' && config.rat === cell.rat && config.arfcn === cell.arfcn);
  const replace = !!config?.opt && !covered;
  const target = config?.opt === 2 ? `${config.rat} 频点 ${config.arfcn} · 任意 PCI` : config && cellLabel(config);
  const lockedKind: LockKind = config?.opt === 2 ? 'arfcn' : 'cell';

  const submit = async (mode: 'lock' | 'unlock' | 'reapply') => {
    if (!config || submitting.current) return;
    submitting.current = true;
    setBusy(true);
    try {
      const fresh = await readConfig();
      if (!sameConfig(config, fresh)) {
        setConfig(fresh); if (!fresh.extended) setKind('cell');
        setNote('锁定配置已改变，请核对后再操作。'); return;
      }
      const useKind = mode === 'reapply' ? lockedKind : fresh.extended ? kind : 'cell';
      const reply: LockReply = mode === 'unlock'
        ? await lockRequest('cell_clear', fresh.extended ? { apply } : {})
        : await requestCellLock(cell, useKind, fresh.extended && (mode === 'reapply' || apply), fresh.extended);
      const done = mode === 'unlock' ? '已解除锁定' : useKind === 'arfcn' ? `已锁定频点 ${cell.rat} ${cell.arfcn}` : `已锁定主小区 ${cellLabel(cell)}`;
      if (reply.applied) {
        setPhase({ step: 'watching', seconds: 0 });
        const camp = mode === 'unlock' ? null : { rat: cell.rat, arfcn: cell.arfcn, pci: cell.pci };
        const result = await waitForCamp(camp, useKind, (seconds) => setPhase({ step: 'watching', seconds }));
        if (result === 'matched') {
          Toast.success(`${done}，${campText(result, camp, useKind)}`);
          onDone();
          return;
        }
        setPhase({ step: 'result', tone: 'warning', text: `${done}。${campText(result, camp, useKind)}` });
      } else if (reply.apply_error) {
        setPhase({ step: 'result', tone: reply.apply_error === 'radio_off' ? 'danger' : 'warning', text: `${done}。${applyError(reply.apply_error)}` });
      } else {
        Toast.success(`${done}，将在基带下次重选小区时生效`);
        onDone();
      }
    } catch (e) {
      setConfig(null); setNote(pickError(e));
    } finally { submitting.current=false; setBusy(false); }
  };

  const watching = phase.step === 'watching';
  const finished = phase.step === 'result';
  return (
    <Modal
      title={covered ? '当前锁定目标' : replace ? '更换锁定目标' : '锁定为主小区'}
      visible
      onCancel={() => {if (!submitting.current) (finished ? onDone : onClose)();}}
      width="min(480px, calc(100vw - 32px))"
      footer={
        <div className="lock-modal-footer">
          {finished ? <Button theme="solid" onClick={onDone}>完成</Button> : <>
            <Button aria-label="取消" disabled={busy} onClick={onClose}>取消</Button>
            {config ? (covered ? <>
              <Button type="danger" loading={busy} disabled={watching} onClick={() => void submit('unlock')}>解除锁定</Button>
              {config.extended && !serving && <Button theme="solid" loading={busy} disabled={watching} onClick={() => void submit('reapply')}>重启射频并重新驻留</Button>}
            </> : <Button theme="solid" type="primary" loading={busy} disabled={watching} onClick={() => void submit('lock')}>
              {replace ? '改锁到此小区' : kind === 'arfcn' ? '锁定频点' : '锁定主小区'}
            </Button>) : note ? <Button onClick={()=>{setNote('');retry(n=>n+1);}}>重新读取</Button> : null}
          </>}
        </div>
      }
    >
        <div className="lock-modal">
          <div className="lock-modal-target">
            <Tag color={ratTagColor(cell.rat)}>{cell.rat}</Tag>
            <b>{cell.arfcn}</b>
            <span className="lock-modal-sep">/</span>
            <b>PCI {cell.pci}</b>
            {serving ? <Tag color={TAG_COLOR.success}>当前主小区</Tag> : null}
          </div>

          <div className="lock-modal-metrics">
            <div>
              <span>RSRP</span>
              <b>{cell.rsrp != null && Number.isFinite(cell.rsrp) ? `${cell.rsrp} dBm` : '—'}</b>
            </div>
            <div>
              <span>RSRQ</span>
              <b>{cell.rsrq != null ? `${cell.rsrq} dB` : '—'}</b>
            </div>
            <div>
              <span>SINR</span>
              <b>{cell.sinr10 != null ? `${cell.sinr10 / 10} dB` : '—'}</b>
            </div>
          </div>

          {note && <Banner type="warning" closeIcon={null} description={note} />}
          {watching && <Banner type="info" closeIcon={null}
            description={`射频已重启，正在按新规则重新驻留…已等待 ${phase.seconds} 秒`} />}
          {finished && <Banner type={phase.tone} closeIcon={null} description={phase.text} />}
          {config && !watching && !finished ? <>
            {covered ? <>
              <Banner type="info" closeIcon={null}
                description={serving ? `这是当前锁定目标（${target}），并且已是主小区。`
                  : `这是当前锁定目标（${target}），但尚未确认驻留在此目标。`} />
              {config.extended && <LockOptions unlocking apply={apply} onApply={setApply} disabled={busy} />}
            </>
            : <>
              {config.extended && <LockOptions kind={kind} onKind={setKind} apply={apply} onApply={setApply} disabled={busy} />}
              <Banner type={replace || !serving ? 'warning' : 'info'} closeIcon={null}
                description={replace ? `现有锁定：${target}。改锁会替换这项配置。`
                  : serving ? '这已是当前主小区；锁定后设备将只驻留在它上面。'
                    : kind === 'arfcn' ? '只锁频点时，设备可在这个频点的小区之间切换，覆盖更稳。'
                      : '锁定后设备只会以这个小区作为主小区（PCC），辅载波仍由网络配置。'} />
            </>}
            <Typography.Text type="tertiary" size="small">
              {config.extended && apply ? '请从局域网操作，以便在蜂窝连接断开时核对驻留。' : '不重启射频时，锁定会在基带下次重选小区时生效，连接中的设备可能长时间不切换。'}
              若锁定目标失去覆盖，设备可能脱网。
            </Typography.Text>
          </> : !config && !note && <Typography.Text type="tertiary" size="small">正在读取锁定配置…</Typography.Text>}
        </div>
    </Modal>
  );
};

const LockCellModal = ({cell,...props}: Omit<Props,'cell'> & {cell:Cell|null}) =>
  cell ? <TargetDialog key={cellKey(cell)} cell={cell} {...props}/> : null;

export default LockCellModal;
