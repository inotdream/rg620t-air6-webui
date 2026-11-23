import React, { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Button, Tag, Typography } from '@douyinfe/semi-ui';
import { Kv, PageCard, Panel, RefreshBtn } from '@/ui/widgets';
import { ubus } from '@/services/deviceUbus';
import { TAG_COLOR } from '@/ui/tokens';
import deployInfo from '@/modules/device-build.json';
import { engineeringError, simLabels } from './engineering';
import { masked, type Identity, useSdkAccess } from './sdk';

export default function ModemIdentity() {
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

  const live = access?.sdk === true;
  const sim = identity?.sim;
  const show = (value?: string | null) => (reveal ? value || '未读到' : masked(value));

  return (
    <PageCard
      title="蜂窝模组"
      hint={live ? '实时读取自基带' : '安装此版界面时从设备读取'}
      extra={live ? <RefreshBtn label="重新读取" loading={loading} onClick={() => void load()} />
        : <Tag size="small" color={TAG_COLOR.success}>部署时核对</Tag>}
    >
      <Kv
        layout="rows"
        items={[
          { label: '模组型号', value: 'Quectel RG620T' },
          ...(live ? [{ label: 'IMEI', value: <span className="mono">{show(identity?.imei)}</span> }] : []),
          ...(identity?.software ? [{ label: '模组软件版本', value: identity.software }] : []),
          { label: '基带版本', value: identity?.firmware || deployInfo.firmware },
          ...(live ? [
            { label: '模组状态', value: identity?.modem || '未读到' },
            { label: '飞行模式', value: identity?.airplane == null ? '未读到' : identity.airplane ? '已开启' : '已关闭' },
          ] : [{ label: '部署时系统槽位', value: deployInfo.systemSlot }]),
        ]}
      />
      {live && (
        <>
          <div className="card-divider" />
          <Panel
            title="SIM 卡"
            extra={<Button size="small" theme="borderless" onClick={() => setReveal((v) => !v)}>{reveal ? '隐藏号码' : '显示完整号码'}</Button>}
          >
            <Kv
              layout="rows"
              items={[
                { label: '状态', value: sim ? simLabels[sim.state] || '未就绪' : identity ? '未读到' : '读取中' },
                { label: 'ICCID', value: <span className="mono">{show(sim?.iccid)}</span> },
                { label: 'IMSI', value: <span className="mono">{show(sim?.imsi)}</span> },
                { label: '本机号码', value: sim?.number ? <span className="mono">{show(sim.number)}</span> : '卡内未写入' },
                { label: '签约 PLMN', value: sim?.plmn || '未读到' },
              ]}
            />
          </Panel>
        </>
      )}
      {problem && <Typography.Text type="danger" size="small">{problem}</Typography.Text>}
      <div className="card-divider" />
      <Link to="/engineering" className="engineering-link">查看 SIM 与温度、查询基带</Link>
      <br />
      <Typography.Text type="tertiary" size="small">
        {live ? '本机号码取决于运营商是否写入 SIM 卡，空白属正常情况。'
          : '基带版本来自 AT+CGMR；后续刷机或切槽后，这份部署记录不会自动变化。'}
      </Typography.Text>
    </PageCard>
  );
}
