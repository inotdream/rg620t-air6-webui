import React, { useCallback, useEffect, useState } from 'react';
import { Button, Checkbox, Input, Modal, Select, Toast, Typography } from '@douyinfe/semi-ui';
import { Field, PageCard, RefreshBtn } from '@/ui/widgets';
import { ubus } from '@/services/deviceUbus';
import { engineeringError } from './engineering';
import type { Apn } from './sdk';

const IP_TYPES = [{ value: 3, label: 'IPv4 + IPv6' }, { value: 1, label: '仅 IPv4' }, { value: 2, label: '仅 IPv6' }];
const AUTH_TYPES = [{ value: 0, label: '不认证' }, { value: 1, label: 'PAP' }, { value: 2, label: 'CHAP' }, { value: 3, label: 'PAP 或 CHAP' }];
const APN_RE = /^(?:[A-Za-z0-9][A-Za-z0-9.-]{0,62})?$/;
// Same character set as the backend: printable ASCII without spaces, quotes or backslashes.
const SECRET_RE = /^[!#-&(-[\]-_a-~]{0,64}$/;

export default function ApnSettings({ onApplied }: { onApplied?: () => void }) {
  const [saved, setSaved] = useState<Apn | null>(null);
  const [apn, setApn] = useState('');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [clearPassword, setClearPassword] = useState(false);
  const [auth, setAuth] = useState(0);
  const [iptype, setIptype] = useState(3);
  const [redial, setRedial] = useState(true);
  const [loading, setLoading] = useState(false);
  const [problem, setProblem] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    setProblem('');
    try {
      const next = await ubus<Apn>('dlink-cellular', 'apn_get');
      if (next.ok !== true) throw new Error(next.error || 'apn_unsupported');
      setSaved(next);
      setApn(next.apn || '');
      setUsername(next.username || '');
      setAuth(next.auth ?? 0);
      setIptype(next.iptype ?? 3);
      setPassword('');
      setClearPassword(false);
    } catch (error) {
      setProblem(engineeringError(error));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const valid = APN_RE.test(apn) && SECRET_RE.test(username) && SECRET_RE.test(password);
  const changed = !!saved && (apn !== (saved.apn || '') || username !== (saved.username || '') || auth !== saved.auth ||
    iptype !== saved.iptype || password !== '' || clearPassword);

  const submit = () => {
    if (!saved?.revision || !valid || !changed) return;
    const summary = apn ? `APN「${apn}」` : '按 SIM 卡自动匹配 APN';
    Modal.confirm({
      title: '保存蜂窝拨号参数？',
      content: redial ? `将使用${summary}并立即重新拨号，蜂窝数据会中断十几秒；局域网不受影响。`
        : `将保存${summary}，下次重新拨号时生效。`,
      okText: redial ? '保存并重拨' : '保存',
      cancelText: '取消',
      okButtonProps: { type: 'danger', theme: 'solid', 'aria-label': redial ? '保存并重拨' : '保存' },
      onOk: async () => {
        try {
          const params: Record<string, unknown> = { apn, username, auth, iptype, revision: saved.revision, confirm: true };
          if (password || clearPassword) params.password = clearPassword ? '' : password;
          const reply = await ubus<{ ok?: boolean; error?: string }>('dlink-cellular', 'apn_set', params);
          if (reply.ok !== true) throw new Error(reply.error || 'readback');
          if (redial) await ubus('dlink-cellular', 'wan_redial', { confirm: true });
          Toast.success(redial ? '已保存并触发重新拨号' : '已保存，下次拨号生效');
          await load();
          onApplied?.();
        } catch (error) {
          Toast.error(engineeringError(error));
        }
      },
    });
  };

  return (
    <PageCard title="APN 与拨号参数" hint="写入 network.wan；留空 APN 时由 SIM 卡自动匹配"
      extra={<RefreshBtn label="重新读取" loading={loading} onClick={() => void load()} />}>
      {saved ? (
        <>
          <div className="service-form">
            <Field label="APN" className="field--wide" hint={APN_RE.test(apn) ? '例如 3gnet、cmnet、ctnet；专网卡请按运营商提供的填写' : '只能包含字母、数字、点和连字符'}>
              <Input value={apn} onChange={setApn} placeholder="留空则按 SIM 卡自动匹配" maxLength={63} aria-label="APN" />
            </Field>
            <Field label="IP 类型">
              <Select value={iptype} optionList={IP_TYPES} onChange={(v) => setIptype(Number(v))} aria-label="IP 类型" />
            </Field>
            <Field label="认证方式">
              <Select value={auth} optionList={AUTH_TYPES} onChange={(v) => setAuth(Number(v))} aria-label="认证方式" />
            </Field>
            <Field label="用户名">
              <Input value={username} onChange={setUsername} maxLength={64} autoComplete="off" aria-label="用户名" />
            </Field>
            <Field label="密码" hint={SECRET_RE.test(password) ? undefined : '不能包含空格、引号或反斜杠'}>
              <Input mode="password" value={password} onChange={setPassword} maxLength={64} autoComplete="new-password"
                disabled={clearPassword} aria-label="密码" placeholder={saved.password_set ? '已设置，留空保持不变' : '未设置'} />
            </Field>
          </div>
          <div className="service-footer">
            <span className="service-actions">
              <Checkbox checked={redial} onChange={(e) => setRedial(!!e.target.checked)}>保存后立即重新拨号</Checkbox>
              {saved.password_set && (
                <Checkbox checked={clearPassword} onChange={(e) => setClearPassword(!!e.target.checked)}>清除已保存的密码</Checkbox>
              )}
            </span>
            <Button theme="solid" disabled={!valid || !changed} onClick={submit}>保存</Button>
          </div>
        </>
      ) : (
        <Typography.Text type="tertiary" size="small">{problem || (loading ? '正在读取拨号参数…' : '未读到拨号参数')}</Typography.Text>
      )}
      {saved && problem && <Typography.Text type="danger" size="small">{problem}</Typography.Text>}
    </PageCard>
  );
}
