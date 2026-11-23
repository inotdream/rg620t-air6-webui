import React, { useState } from 'react';
import { Button, Input, Modal, Toast, Typography } from '@douyinfe/semi-ui';
import { IconSetting } from '@douyinfe/semi-icons';
import { Field, Panel } from '@/ui/widgets';
import { ubus } from '@/services/deviceUbus';
import { engineeringError } from './engineering';
import { ussdText } from './sdk';

const SCA_RE = /^\+?\d{3,20}$/;
const USSD_RE = /^[0-9*#]{2,32}$/;

export default function SmsServices({ disabled }: { disabled?: boolean }) {
  const [open, setOpen] = useState(false);
  const [current, setCurrent] = useState<string | null | undefined>(undefined);
  const [address, setAddress] = useState('');
  const [code, setCode] = useState('');
  const [reply, setReply] = useState<{ text: string; more: boolean } | null>(null);
  const [problem, setProblem] = useState('');
  const [busy, setBusy] = useState('');

  const loadCentre = async () => {
    setProblem('');
    try {
      const r = await ubus<{ ok?: boolean; error?: string; address?: string | null }>('dlink-cellular', 'smsc_get');
      if (r.ok !== true) throw new Error(r.error || 'smsc_read');
      setCurrent(r.address ?? null);
      setAddress(r.address || '');
    } catch (error) {
      setCurrent(undefined);
      setProblem(engineeringError(error));
    }
  };

  const show = () => {
    setOpen(true);
    setReply(null);
    void loadCentre();
  };

  const saveCentre = () => {
    if (!SCA_RE.test(address) || address === current || current === undefined) return;
    Modal.confirm({
      title: '修改短信中心号码？',
      content: `新号码 ${address}。号码错误会导致短信发不出去；拔插 SIM 卡后会恢复卡内默认值。`,
      okText: '修改', cancelText: '取消',
      okButtonProps: { type: 'danger', theme: 'solid', 'aria-label': '修改' },
      onOk: async () => {
        setBusy('smsc');
        try {
          const r = await ubus<{ ok?: boolean; error?: string; address?: string }>('dlink-cellular', 'smsc_set',
            { address, expected: current ?? '', confirm: true });
          if (r.ok !== true) throw new Error(r.error || 'readback');
          setCurrent(r.address ?? address);
          Toast.success('短信中心号码已修改并读回');
        } catch (error) {
          Toast.error(engineeringError(error));
        } finally {
          setBusy('');
        }
      },
    });
  };

  const sendUssd = async () => {
    if (!USSD_RE.test(code) || busy) return;
    setBusy('ussd');
    setReply(null);
    try {
      const r = await ubus<{ ok?: boolean; error?: string; status?: number; reply?: string | null }>('dlink-cellular', 'ussd_send', { code, confirm: true });
      if (r.ok !== true) throw new Error(r.error || 'ussd_send');
      setReply({ text: ussdText(r.reply) || '运营商未返回文字内容。', more: r.status === 1 });
    } catch (error) {
      setReply({ text: engineeringError(error), more: false });
    } finally {
      setBusy('');
    }
  };

  return (
    <>
      <Button size="small" icon={<IconSetting />} disabled={disabled} onClick={show}>短信中心与 USSD</Button>
      <Modal title="短信中心与 USSD" visible={open} footer={null} width="min(480px, calc(100vw - 32px))" onCancel={() => setOpen(false)}>
        <div className="sms-services">
          <Panel title="短信中心号码" extra={current === undefined ? '' : current ? `当前 ${current}` : '卡内未设置'}>
            <div className="ussd-form">
              <Input value={address} onChange={setAddress} placeholder="例如 +8613010130500" maxLength={21} aria-label="短信中心号码" />
              <Button theme="solid" loading={busy === 'smsc'} disabled={!SCA_RE.test(address) || address === current || current === undefined}
                onClick={saveCentre}>保存</Button>
            </div>
            <p className="service-note">一般无需修改；只有短信持续发送失败、且运营商告知了正确号码时再改。</p>
          </Panel>
          <Panel title="USSD 查询">
            <Field label="USSD 代码" hint="例如运营商公布的余额或流量查询代码，以 * 开头、# 结尾">
              <div className="ussd-form">
                <Input value={code} onChange={setCode} placeholder="*100#" maxLength={32} aria-label="USSD 代码"
                  onEnterPress={() => void sendUssd()} />
                <Button theme="solid" loading={busy === 'ussd'} disabled={!USSD_RE.test(code)} onClick={() => void sendUssd()}>发送</Button>
              </div>
            </Field>
            {reply && <pre className="ussd-reply" aria-live="polite">{reply.text}</pre>}
            {reply?.more && <p className="service-note">运营商要求继续选择菜单；当前界面只支持单次查询，可直接发送对应的完整代码。</p>}
            <p className="service-note">VoLTE 网络下部分运营商不再提供 USSD，查询可能没有回复。</p>
          </Panel>
          {problem && <Typography.Text type="danger" size="small">{problem}</Typography.Text>}
        </div>
      </Modal>
    </>
  );
}
