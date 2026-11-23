import React, { useState } from 'react';
import { Button, Input, Modal, Select, Switch, Toast, Typography } from '@douyinfe/semi-ui';
import { Field, PageCard } from '@/ui/widgets';
import { ubus } from '@/services/deviceUbus';
import { engineeringError } from './engineering';
import { CF_REASONS, masked, type CallForward } from './sdk';

const NUMBER_RE = /^\+?\d{3,20}$/;
const NO_REPLY_SECONDS = [5, 10, 15, 20, 25, 30];
type Row = CallForward & { problem?: string };

export default function CallServices({ disabled }: { disabled?: boolean }) {
  const [rows, setRows] = useState<Record<number, Row>>({});
  const [waiting, setWaiting] = useState<boolean | null>(null);
  const [waitingProblem, setWaitingProblem] = useState('');
  const [reading, setReading] = useState(false);
  const [editing, setEditing] = useState<number | null>(null);
  const [number, setNumber] = useState('');
  const [seconds, setSeconds] = useState(20);
  const [saving, setSaving] = useState(false);

  // 每项查询都要和网络往返几秒，按顺序读，不并发占用基带。
  const readAll = async () => {
    setReading(true);
    try {
      try {
        const w = await ubus<{ ok?: boolean; error?: string; enabled?: boolean }>('dlink-cellular', 'cw_query');
        if (w.ok !== true) throw new Error(w.error || 'ss_rejected');
        setWaiting(w.enabled === true);
        setWaitingProblem('');
      } catch (error) {
        setWaiting(null);
        setWaitingProblem(error instanceof Error ? error.message : 'ss_rejected');
      }
      for (const { reason } of CF_REASONS) {
        try {
          const r = await ubus<CallForward>('dlink-cellular', 'cf_query', { reason });
          if (r.ok !== true) throw new Error(r.error || 'ss_rejected');
          setRows((all) => ({ ...all, [reason]: r }));
        } catch (error) {
          setRows((all) => ({ ...all, [reason]: { reason, problem: error instanceof Error ? error.message : 'ss_rejected' } }));
        }
      }
    } finally {
      setReading(false);
    }
  };

  const toggleWaiting = () => {
    if (waiting == null) return;
    const enable = !waiting;
    Modal.confirm({
      title: enable ? '开启呼叫等待？' : '关闭呼叫等待？',
      content: enable ? '通话中有新来电时会提示，可在语音页接听或拒接。' : '通话中的新来电将直接按忙线处理。',
      okText: enable ? '开启' : '关闭', cancelText: '取消',
      okButtonProps: { type: 'danger', theme: 'solid', 'aria-label': enable ? '开启' : '关闭' },
      onOk: async () => {
        try {
          const r = await ubus<{ ok?: boolean; error?: string; enabled?: boolean }>('dlink-cellular', 'cw_set', { enabled: enable, confirm: true });
          if (r.ok !== true) throw new Error(r.error || 'readback');
          setWaiting(r.enabled === true);
          Toast.success(enable ? '呼叫等待已开启' : '呼叫等待已关闭');
        } catch (error) {
          Toast.error(engineeringError(error));
        }
      },
    });
  };

  const submit = async (reason: number, enabled: boolean) => {
    setSaving(true);
    try {
      const params: Record<string, unknown> = { reason, enabled, confirm: true };
      if (enabled) {
        params.number = number;
        if (reason === 2) params.time = seconds;
      }
      const r = await ubus<CallForward>('dlink-cellular', 'cf_set', params);
      if (r.ok !== true) throw new Error(r.error || 'readback');
      setRows((all) => ({ ...all, [reason]: r }));
      setEditing(null);
      Toast.success(enabled ? '呼叫转移已设置，运营商已确认' : '呼叫转移已关闭');
    } catch (error) {
      Toast.error(engineeringError(error));
    } finally {
      setSaving(false);
    }
  };

  const disable = (reason: number, label: string) => Modal.confirm({
    title: `关闭${label}？`, content: '运营商确认后立即生效。', okText: '关闭', cancelText: '取消',
    okButtonProps: { type: 'danger', theme: 'solid', 'aria-label': '关闭' },
    onOk: () => submit(reason, false),
  });

  const target = CF_REASONS.find((r) => r.reason === editing);
  const busy = disabled || reading || saving;
  // 同一原因只在卡片底部说明一次，各行只标状态。
  const unavailable = waitingProblem === 'ss_unavailable' || Object.values(rows).some((r) => r.problem === 'ss_unavailable');
  const rowNote = (problem: string | undefined, hint: string) =>
    !problem ? hint : problem === 'ss_unavailable' ? hint : engineeringError(problem);
  const stateText = (problem?: string) => (problem === 'ss_unavailable' ? '不可用' : '读取失败');

  return (
    <PageCard title="呼叫转移与呼叫等待" hint="由运营商网络保存，需逐项向网络查询"
      extra={<Button size="small" loading={reading} disabled={disabled || saving} onClick={() => void readAll()}>
        {Object.keys(rows).length || waiting != null ? '重新读取' : '读取设置'}</Button>}>
      <div className="cf-row">
        <div className="cf-label"><strong>呼叫等待</strong><small>{rowNote(waitingProblem, '通话中提示新的来电')}</small></div>
        <span className="cf-state">{waitingProblem ? stateText(waitingProblem) : waiting == null ? '未读取' : waiting ? '已开启' : '已关闭'}</span>
        <Switch aria-label="呼叫等待" checked={waiting === true} disabled={busy || waiting == null} onChange={toggleWaiting} />
      </div>
      {CF_REASONS.map(({ reason, label, hint }) => {
        const row = rows[reason];
        return (
          <div className="cf-row" key={reason}>
            <div className="cf-label"><strong>{label}</strong><small>{rowNote(row?.problem, hint)}</small></div>
            <span className="cf-state">
              {!row ? '未读取' : row.problem ? stateText(row.problem) : row.enabled
                ? `转到 ${masked(row.number, 4)}${row.time ? ` · ${row.time} 秒` : ''}` : '已关闭'}
            </span>
            <span className="service-actions">
              {row?.enabled && <Button size="small" disabled={busy} onClick={() => disable(reason, label)}>关闭</Button>}
              <Button size="small" disabled={busy || !row || !!row.problem}
                onClick={() => { setEditing(reason); setNumber(row?.number || ''); setSeconds(row?.time || 20); }}>
                {row?.enabled ? '修改' : '设置'}
              </Button>
            </span>
          </div>
        );
      })}
      {unavailable ? <p className="service-note">{engineeringError('ss_unavailable')}</p> : (
        <Typography.Text type="tertiary" size="small" className="hint-line">
          部分运营商只允许通过客服或短信开通转移；网络拒绝时会在对应项下显示原因。
        </Typography.Text>
      )}

      <Modal title={target ? `设置${target.label}` : ''} visible={editing != null} width="min(420px, calc(100vw - 32px))"
        okText="提交到运营商" cancelText="取消" confirmLoading={saving}
        okButtonProps={{ disabled: !NUMBER_RE.test(number), 'aria-label': '提交到运营商' }}
        onOk={() => editing != null && submit(editing, true)} onCancel={() => !saving && setEditing(null)}>
        <div className="pin-fields">
          <Field label="转移到号码" hint={NUMBER_RE.test(number) || !number ? '手机号或带国家码的号码' : '只能输入数字，可选 + 开头'}>
            <Input value={number} onChange={setNumber} placeholder="例如 13800000000" maxLength={21} inputMode="tel" aria-label="转移到号码" />
          </Field>
          {editing === 2 && (
            <Field label="无应答等待">
              <Select value={seconds} onChange={(v) => setSeconds(Number(v))} aria-label="无应答等待"
                optionList={NO_REPLY_SECONDS.map((s) => ({ value: s, label: `${s} 秒` }))} />
            </Field>
          )}
        </div>
      </Modal>
    </PageCard>
  );
}
