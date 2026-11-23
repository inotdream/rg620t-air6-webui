import React, { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Button, Tag, Typography } from '@douyinfe/semi-ui';
import { Kv, PageCard, RefreshBtn, TwoCol } from '@/ui/widgets';
import { ubus } from '@/services/deviceUbus';
import { TAG_COLOR } from '@/ui/tokens';
import deployInfo from '@/modules/device-build.json';
import { engineeringError, simLabels } from './engineering';
import { type Identity, useSdkAccess } from './sdk';

/** 与左侧系统卡并排的模组卡，下面一整行放 SIM 卡；两张蜂窝卡共用一次基带读取。 */
export default function ModemIdentity({ beside }: { beside: React.ReactNode }) {
  const access = useSdkAccess();
  const [identity, setIdentity] = useState<Identity | null>(null);
  const [problem, setProblem] = useState('');
  const [loading, setLoading] = useState(false);
  const [reveal, setReveal] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setProblem('');
    try {
      const next = await ubus<Identity>('dlink-cellular', 'sdk_identity');
      if (next.ok !== true) throw new Error(next.error || 'ril_init');
      setIdentity(next);
    } catch (error) {
      setProblem(engineeringError(error));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (access?.sdk) void load();
  }, [access?.sdk, load]);

  // 能力确认前按新后端排版，避免先闪一下部署记录再切换；确认是旧后端才退回。
  const live = access?.sdk !== false;
  const pending = !identity && !problem;
  const sim = identity?.sim;
  const show = (value?: string | null) => {
    if (pending) return '读取中';
    if (!value) return '未读到';
    if (reveal) return value;
    return value.length > 7 ? value.slice(0, 3) + '••••' + value.slice(-4) : '••••';
  };

  const modem = (
    <PageCard
      title="蜂窝模组"
      hint={live ? (problem && identity ? '上次读取结果' : access ? '从基带读取' : '正在确认读取能力') : '安装此版界面时从设备读取'}
      extra={live ? <RefreshBtn label="重新读取" loading={loading} onClick={() => void load()} />
        : <Tag size="small" color={TAG_COLOR.success}>部署时核对</Tag>}
    >
      <Kv
        layout="rows"
        items={[
          { label: '模组型号', value: 'Quectel RG620T' },
          ...(live ? [{ label: 'IMEI', value: <span className="mono">{show(identity?.imei)}</span> }] : []),
          ...(live ? [{ label: '模组软件版本', value: identity?.software || (pending ? '读取中' : '未读到') }] : []),
          { label: live ? '基带版本' : '部署时基带版本', value: live ? identity?.firmware || (pending ? '读取中' : '未读到') : deployInfo.firmware },
          ...(live ? [
            { label: '模组状态', value: identity?.modem || (pending ? '读取中' : '未读到') },
            { label: '飞行模式', value: identity?.airplane == null ? (pending ? '读取中' : '未读到') : identity.airplane ? '已开启' : '已关闭' },
          ] : [{ label: '部署时系统槽位', value: deployInfo.systemSlot }]),
        ]}
      />
      {problem && <Typography.Text type="danger" size="small">{problem}</Typography.Text>}
      {!live && (
        <>
          <div className="card-divider" />
          <Link to="/engineering" className="engineering-link">查看 SIM 与温度、查询基带</Link>
          <br />
          <Typography.Text type="tertiary" size="small">
            基带版本来自 AT+CGMR；后续刷机或切槽后，这份部署记录不会自动变化。
          </Typography.Text>
        </>
      )}
    </PageCard>
  );

  return (
    <>
      <TwoCol>
        {beside}
        {modem}
      </TwoCol>
      {live && (
        <PageCard
          title="SIM 卡"
          hint={sim ? simLabels[sim.state] || '未就绪' : pending ? '读取中' : '未读到'}
          extra={<span className="service-actions">
            <Button size="small" theme="borderless" onClick={() => setReveal((v) => !v)}>{reveal ? '隐藏号码' : '显示完整号码'}</Button>
            <Link to="/engineering" className="engineering-link">PIN 保护</Link>
          </span>}
        >
          <Kv
            columns={4}
            items={[
              { label: 'ICCID', value: <span className="mono">{show(sim?.iccid)}</span> },
              { label: 'IMSI', value: <span className="mono">{show(sim?.imsi)}</span> },
              { label: '本机号码', value: <span className="mono">{show(sim?.number)}</span> },
              { label: '签约 PLMN', value: sim?.plmn || (pending ? '读取中' : '未读到') },
            ]}
          />
          <Typography.Text type="tertiary" size="small" className="hint-line">
            本机号码取决于运营商是否写入 SIM 卡，空白属正常情况。
          </Typography.Text>
        </PageCard>
      )}
    </>
  );
}
