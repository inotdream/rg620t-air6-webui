import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Banner, Button, Input, Tag, Toast, Typography } from '@douyinfe/semi-ui';
import { IconPhone, IconRefresh } from '@douyinfe/semi-icons';
import { Metric, PageCard, TwoCol } from '@/ui/widgets';
import { TAG_COLOR } from '@/ui/tokens';
import { ubus } from '@/services/deviceUbus';
import WebAudio from '@/modules/webvoice/WebAudio';
import CallServices from '@/modules/cellular/CallServices';
import { useSdkAccess } from '@/modules/cellular/sdk';

type Call = { id: number; direction: number; state: number; kind: number; number: string; voice?: boolean };
type VoiceStatus = { ok?: boolean; browser_audio?: boolean; read_only?: boolean; calls?: Call[]; error?: string };
type Checks = { ok?: boolean; sim?: string; radio?: boolean; ims?: boolean; ceer?: number; ratmode?: string };

const STATES = ['已接通', '保持', '拨号中', '等待对方接听', '来电响铃', '呼叫等待', '正在挂断'];
const KEYS: Array<{ main: string; sub: string }> = [
  { main: '1', sub: '' },
  { main: '2', sub: 'ABC' },
  { main: '3', sub: 'DEF' },
  { main: '4', sub: 'GHI' },
  { main: '5', sub: 'JKL' },
  { main: '6', sub: 'MNO' },
  { main: '7', sub: 'PQRS' },
  { main: '8', sub: 'TUV' },
  { main: '9', sub: 'WXYZ' },
  { main: '*', sub: '' },
  { main: '0', sub: '+' },
  { main: '#', sub: '' },
];
const DIALABLE = /^\+?\d{3,15}$/;
const POLL_MS = 3000;

const ERRORS: Record<string, string> = {
  dtmf_setup:'按键接口未就绪，本次没有发送。',dtmf_rejected:'基带拒绝了按键。',dtmf_unconfirmed:'未获得基带确认，没有自动重发。',
  confirm: '需要再次确认才会执行。',
  call_present: '已有通话，先挂断再拨号。',
  call_changed: '通话状态已变化，已重新读取。',
  not_ringing: '当前没有这通响铃来电。',
  not_active: '接通后才能发送按键。',
  tone: '只支持 0-9、* 和 #。',
  number: '号码格式不对，需要 3-15 位数字。',
  voice_timeout: '请求超时，已重新读取状态。',
  voice_rejected: '基带或网络拒绝这次请求。',
  voice_unconfirmed: '没有收到操作确认，已重新读取状态。',
  voice_status_unavailable: '基带暂时读不到通话状态。',
  busy: '基带忙，正在重试。',
};

const pickError = (error?: string) => (error ? ERRORS[error] || error : '操作失败');

const Voice: React.FC = () => {
  const access = useSdkAccess();
  const [status, setStatus] = useState<VoiceStatus | null>(null);
  const [checks, setChecks] = useState<Checks>({});
  const [number, setNumber] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState('');
  const [pending, setPending] = useState<{ action: 'dial' | 'answer' | 'hangup'; text: string } | null>(null);
  const [reading, setReading] = useState(true);
  const keyPending = useRef(false);
  const timer = useRef<number>();
  const alive = useRef(true);

  const readStatus = useCallback(async () => {
    for (let attempt = 0; attempt < 4; attempt += 1) {
      try {
        const next = await ubus<VoiceStatus>('dlink-cellular', 'voice_status');
        if (next?.ok) return next;
        if (next?.error && next.error !== 'busy' && next.error !== 'voice_status_unavailable') {
          return next;
        }
      } catch {
        /* 网络抖动，继续重试 */
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    return null;
  }, []);

  const refresh = useCallback(
    async (silent = false) => {
      const next = await readStatus();
      if (!alive.current) return null;
      if (next?.ok) {
        setStatus(next);
        setReading(false);
        if (!silent && note) setNote('');
      } else {
        setStatus(null);
        setReading(false);
      }

      for (let attempt = 0; attempt < 3; attempt += 1) {
        try {
          const info = await ubus<Checks>('dlink-cellular', 'diag_checks');
          if (alive.current && info?.ok) setChecks(info);
          break;
        } catch {
          await new Promise((resolve) => setTimeout(resolve, 200));
        }
      }
      return next;
    },
    [readStatus, status, note],
  );

  useEffect(() => {
    alive.current = true;
    refresh();
    timer.current = window.setInterval(() => refresh(true), POLL_MS);
    return () => {
      alive.current = false;
      window.clearInterval(timer.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const calls = status?.calls || [];
  const only = calls.length === 1 ? calls[0] : null;
  const idle = Boolean(status?.ok) && calls.length === 0;
  const talking = !!only && !status?.read_only && only.state === 0 && (only.kind === 0 || only.voice === true);
  const ringing = only?.state === 4 && only?.direction === 1;
  const audioAvailable = status?.browser_audio === true;

  const act = async (name: string, method: string, params: Record<string, unknown>, okText: string) => {
    if (name === 'dtmf') { if (keyPending.current) return; keyPending.current = true; }
    setBusy(name);
    setNote('');
    try {
      const result = await ubus<{ ok?: boolean; error?: string; ack?: string }>('dlink-cellular', method, {
        ...params,
        confirm: true,
      });
      if (name === 'dtmf' && result?.ok !== false && !(result?.ok === true && result?.ack === 'modem')) throw new Error('dtmf_unconfirmed');
      if (result?.ok === false) {
        setNote(pickError(result.error));
        Toast.error(pickError(result.error));
      } else {
        setNote(okText);
        Toast.success(okText);
      }
    } catch (error) {
      setNote(error instanceof Error ? pickError(error.message) : '操作失败');
    } finally {
      if (name === 'dtmf') keyPending.current = false;
      setBusy('');
      await refresh(true);
    }
  };

  const submitDial = () => {
    const target = number.trim().replace(/[ -]/g, '');
    if (!DIALABLE.test(target)) {
      setNote('号码需要 3-15 位数字，可以带 + 号。');
      return;
    }
    setPending({ action: 'dial', text: `确认拨打 ${target}？` });
  };

  const statusText = useMemo(() => {
    if (reading && !status) return '读取中';
    if (!status?.ok) return '基带暂无返回';
    if (calls.length === 0) return '空闲';
    if (calls.length > 1) return `${calls.length} 通通话`;
    return STATES[only?.state ?? 1] || '状态未识别';
  }, [reading, status, calls.length, only]);

  return (
    <div className="page-stack">
      <div className="page-toolbar">
        <div className="page-toolbar-left">
          <span className="toolbar-pill">
            <IconPhone size="small" />
            AT+CLCC 轮询 · 每 {POLL_MS / 1000} 秒同步
          </span>
        </div>
        <div className="page-toolbar-right">
          <Button size="small" icon={<IconRefresh />} loading={reading && !status} onClick={() => refresh()}>
            刷新状态
          </Button>
        </div>
      </div>

      {audioAvailable ? null : (
        <Banner
          type="info"
          closeIcon={null}
          description="设备未挂载浏览器声卡，语音音频走基带 ccci 通道。本页用于发起/接听/挂断与发送 DTMF 按键。"
        />
      )}

      {/* 服务就绪 KPI 条 */}
      <div className="kpi-strip">
        <Metric
          tile
          size="sm"
          label="SIM 卡"
          value={checks.sim === 'ready' ? '已就绪' : checks.sim || '未知'}
          tone={checks.sim === 'ready' ? 'success' : 'danger'}
          className="kpi-card"
        />
        <Metric
          tile
          size="sm"
          label="射频状态"
          value={checks.radio ? '已开启' : '已关闭'}
          tone={checks.radio ? 'success' : 'danger'}
          className="kpi-card"
        />
        <Metric
          tile
          size="sm"
          label="IMS 注册"
          value={checks.ims ? '已注册' : '未注册'}
          tone={checks.ims ? 'success' : 'warning'}
          hint={checks.ims === false ? 'VoLTE / VoNR 依赖 IMS' : undefined}
          className="kpi-card"
        />
        <Metric
          tile
          size="sm"
          label="当前通话"
          value={statusText}
          tone={talking ? 'success' : ringing ? 'warning' : undefined}
          className="kpi-card"
        />
      </div>

      <TwoCol>
        <PageCard
          title="通话控制"
          hint="当前线路状态与接听/挂断"
          extra={
            <Tag size="small" color={TAG_COLOR[talking ? 'success' : ringing ? 'warning' : 'neutral']}>
              {statusText}
            </Tag>
          }
        >
          <div className={`voice-stage${talking ? ' is-talking' : ringing ? ' is-ringing' : ''}`}>
            <span className={`voice-dot${talking ? ' active' : ringing ? ' ring' : ''}`} aria-hidden="true" />
            <div className="voice-stage-copy">
              <div className="voice-number">{only?.number || (calls.length ? `${calls.length} 通进行中` : '空闲待机')}</div>
              <Typography.Text type="tertiary" size="small">
                {only
                  ? `${only.direction === 1 ? '来电' : '去电'} · ${STATES[only.state] || '状态未识别'}`
                  : calls.length
                    ? '检测到多路通话，本页仅显示概况'
                    : status?.ok
                      ? '输入号码拨打，或等待来电呼入'
                      : '尚未读取到基带通话状态'}
              </Typography.Text>
            </div>
          </div>

          <div className="action-row voice-controls">
            <Button
              theme="solid"
              type="primary"
              disabled={!ringing}
              loading={busy === 'answer'}
              onClick={() => setPending({ action: 'answer', text: `接听 ${only?.number || '这通来电'}？` })}
            >
              接听来电
            </Button>
            <Button
              type="danger"
              theme="solid"
              disabled={!only || only.state > 5}
              loading={busy === 'hangup'}
              onClick={() => setPending({ action: 'hangup', text: '挂断当前通话？' })}
            >
              挂断通话
            </Button>
          </div>

          {audioAvailable && !status?.read_only ? (
            <WebAudio call={only && (only.kind === 0 || only.voice) ? only : null} />
          ) : null}
          {checks.ims === false ? (
            <Banner
              type="warning"
              closeIcon={null}
              description="IMS 未注册时语音电话可能无法接通（5G SA 下需运营商开通 VoNR / VoLTE）。"
              className="card-banner"
            />
          ) : null}

          {note ? (
            <Typography.Text type="secondary" size="small" className="hint-line">
              {note}
            </Typography.Text>
          ) : null}
        </PageCard>

        <PageCard title="拨号键盘" hint={talking ? '通话中：按键将发送 DTMF 音' : idle ? '输入号码后点击拨打' : '等待线路空闲'}>
          <div className="form-stack">
            <Input
              size="large"
              value={number}
              onChange={(value) => setNumber(value)}
              placeholder="输入电话号码"
              disabled={!idle}
              onEnterPress={submitDial}
              className="voice-input"
            />
            <div className="dial-pad">
              {KEYS.map(({ main, sub }) => (
                <button
                  type="button"
                  key={main}
                  className="dial-key-btn"
                  disabled={talking ? !!busy : !idle}
                  onClick={() => {
                    if (talking && only) {
                      act('dtmf', 'voice_dtmf', { id: String(only.id), key: main }, `基带已确认按键 ${main}`);
                      return;
                    }
                    if (idle) setNumber((current) => (current.length < 22 ? current + main : current));
                  }}
                >
                  <span className="dial-key-main">{main}</span>
                  {sub ? <span className="dial-key-sub">{sub}</span> : null}
                </button>
              ))}
            </div>
            <div className="voice-dial-actions">
              <Button theme="solid" type="primary" icon={<IconPhone />} disabled={!idle} onClick={submitDial} className="voice-dial-primary">
                拨打
              </Button>
              <Button disabled={!idle || !number} onClick={() => setNumber((c) => c.slice(0, -1))}>
                退格
              </Button>
              <Button disabled={!idle || !number} onClick={() => setNumber('')}>
                清空
              </Button>
            </div>
          </div>
        </PageCard>
      </TwoCol>

      {access?.services ? <CallServices disabled={!idle} /> : null}

      <div className="callout-note">
        呼叫指令映射：拨号 ATD、接听 ATA、挂断 AT+CHUP、按键 MIPC 单键 DTMF、状态轮询 AT+CLCC。与 LuCI 蜂窝页共用底层锁，多端并发操作会自动排队。
      </div>

      {pending ? (
        <div className="confirm-bar" role="dialog" aria-label="确认操作">
          <span className="confirm-bar-text">{pending.text}</span>
          <div className="action-row">
            <Button size="small" onClick={() => setPending(null)}>
              取消
            </Button>
            <Button
              size="small"
              type="danger"
              theme="solid"
              onClick={() => {
                const { action } = pending;
                setPending(null);
                if (action === 'dial') {
                  act('dial', 'voice_dial', { number: number.trim().replace(/[ -]/g, '') }, '已请求拨号');
                } else if (action === 'answer') {
                  act('answer', 'voice_answer', { id: String(only?.id ?? 0) }, '已请求接听');
                } else {
                  act('hangup', 'voice_hangup', { id: String(only?.id ?? 0) }, '已请求挂断');
                }
              }}
            >
              确认执行
            </Button>
          </div>
        </div>
      ) : null}
    </div>
  );
};

export default Voice;
