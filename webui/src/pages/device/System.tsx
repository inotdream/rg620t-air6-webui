import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Tag, Toast, Typography } from '@douyinfe/semi-ui';
import { IconActivity, IconClock, IconServer, IconUserGroup, IconWifi } from '@douyinfe/semi-icons';
import { Kv, Metric, PageCard, RefreshBtn, SectionHeader, TwoCol } from '@/ui/widgets';
import { QualityBar } from '@/ui/charts';
import { ubus } from '@/services/deviceUbus';
import ModemIdentity from '@/modules/cellular/ModemIdentity';
import { TAG_COLOR, type Tone } from '@/ui/tokens';

type Release = { distribution?: string; version?: string; revision?: string; description?: string };
type Board = { hostname?: string; model?: string; system?: string; kernel?: string; release?: Release };
type Info = { uptime?: number; memory?: { total?: number; free?: number }; load?: number[] };
const bands = { ra0: '2.4 GHz', rai0: '5 GHz' } as const;
type Interface = keyof typeof bands;
type Radio = {
  channel?: number; frequency?: number; width?: string; power?: number; noise?: number;
  state?: string; stations?: number;
};
type Cpe = Partial<Record<Interface, Radio>>;
type DriverInfo = {channel?:number; frequency?:number; htmode?:string; txpower?:number; noise?:number};
const positive = (n:unknown) => typeof n==='number' && Number.isFinite(n) && n>0 ? n : undefined;

async function readRadio(name: Interface): Promise<Radio> {
  const [iw,assoc,ap] = await Promise.all([
    ubus<DriverInfo>('iwinfo','info',{device:name}).catch(()=>null),
    ubus<{results?:unknown[]}>('iwinfo','assoclist',{device:name}).catch(()=>null),
    ubus<{status?:string;channel?:number;freq?:number}>(`hostapd.${name}`,'get_status').catch(()=>null),
  ]);
  const [link, clients] = await Promise.all([
    !ap?.status ? ubus<{up?:boolean}>('network.device','status',{name}).catch(()=>null) : null,
    !Array.isArray(assoc?.results) ? ubus<{clients?:Record<string,{assoc?:boolean}>}>(`hostapd.${name}`,'get_clients').catch(()=>null) : null,
  ]);
  const apClients=clients?.clients;
  const stations = Array.isArray(assoc?.results) ? assoc.results.length
    : apClients && typeof apClients==='object' && !Array.isArray(apClients)
      ? Object.values<{assoc?:boolean}>(apClients).filter(client => client?.assoc !== false).length : undefined;
  const width=iw?.htmode?.match(/^(?:HT|VHT|HE|EHT)(80\+80|320|160|80|40|20)$/i)?.[1];
  return {
    channel:positive(iw?.channel) ?? positive(ap?.channel),
    frequency:positive(iw?.frequency) ?? positive(ap?.freq), width,
    power:iw?.txpower, noise:iw?.noise, stations,
    state:ap?.status || (link?.up === true ? 'IF_UP' : link?.up === false ? 'IF_DOWN' : undefined),
  };
}
const stateNames:Record<string,string> = {
  ENABLED:'AP 已启用', DISABLED:'AP 已停用', HT_SCAN:'信道扫描中', DFS:'DFS 检测中',
  IF_UP:'接口已启用', IF_DOWN:'接口已停用',
};
const reading = (v:number|undefined,unit:string) => v!=null && Number.isFinite(v) ? `${v} ${unit}` : '未读到';
const duration = (seconds?: number) => {
  if (!seconds) return '—';
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (d) return `${d} 天 ${h} 小时`;
  if (h) return `${h} 小时 ${m} 分`;
  return `${m} 分`;
};

const gb = (bytes?: number) => (bytes ? `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB` : '—');

/** 占用率（越高越糟）：>85 危险 / >70 警告 */
const usageTone = (percent: number | null): Tone => {
  if (percent == null) return 'neutral';
  return percent > 85 ? 'danger' : percent > 70 ? 'warning' : 'success';
};

const System: React.FC = () => {
  const [board, setBoard] = useState<Board>({});
  const [info, setInfo] = useState<Info>({});
  const [cpe, setCpe] = useState<Cpe>({});

  const readingRadios=useRef(false);
  const [refreshing,setRefreshing]=useState(false);
  const refresh=useCallback(async()=>{
    if(readingRadios.current) return;
    readingRadios.current=true;setRefreshing(true);
    try {
      const [ra0,rai0]=await Promise.all([readRadio('ra0'),readRadio('rai0')]);
      setCpe({ra0,rai0});
    } finally {readingRadios.current=false;setRefreshing(false);}
  },[]);
  useEffect(() => {
    void Promise.all([ubus<Board>('system', 'board'), ubus<Info>('system', 'info')])
      .then(([nextBoard, nextInfo]) => {setBoard(nextBoard);setInfo(nextInfo);})
      .catch((error) => Toast.error(error instanceof Error ? error.message : '读取失败'));
    void refresh();
  }, [refresh]);

  const mem = info.memory;
  const usedPercent = mem?.total && mem.free != null ? Math.round((1 - mem.free / mem.total) * 100) : null;
  const usedBytes = mem?.total && mem.free != null ? mem.total - mem.free : undefined;
  const load = info.load?.map((n) => (n / 65535).toFixed(2)).join(' / ');
  const stations = cpe.ra0?.stations != null && cpe.rai0?.stations != null ? cpe.ra0.stations + cpe.rai0.stations : '—';

  return (
    <div className="page-stack">
      <div className="kpi-strip">
        <Metric
          tile
          size="md"
          icon={<IconClock size="small" />}
          label="运行时长"
          value={duration(info.uptime)}
          hint={board.hostname ? `主机 ${board.hostname}` : '系统连续在线'}
          className="kpi-card"
        />
        <Metric
          tile
          size="md"
          icon={<IconUserGroup size="small" />}
          label="无线关联终端"
          value={stations}
          unit={typeof stations === 'number' ? '台' : undefined}
          hint={`2.4G ${reading(cpe.ra0?.stations,'台')} · 5G ${reading(cpe.rai0?.stations,'台')}`}
          className="kpi-card"
        />
        <Metric
          tile
          size="md"
          icon={<IconServer size="small" />}
          label="内存占用"
          value={usedPercent == null ? '—' : usedPercent}
          unit={usedPercent != null ? '%' : undefined}
          tone={usageTone(usedPercent) === 'success' ? undefined : usageTone(usedPercent)}
          hint={`${gb(usedBytes)} / ${gb(mem?.total)}`}
          className="kpi-card"
        />
        <Metric
          tile
          size="md"
          icon={<IconActivity size="small" />}
          label="平均负载"
          value={load || '—'}
          hint="1m / 5m / 15m"
          className="kpi-card"
        />
      </div>

      <TwoCol>
        <PageCard
          title="系统与固件"
          hint="主机硬件、发行版与内存使用率"
          extra={<Tag size="small" color={TAG_COLOR.accent}>{board.release?.distribution || 'ImmortalWrt'}</Tag>}
        >
          <Kv
            layout="rows"
            items={[
              { label: '主机名', value: board.hostname || '—' },
              { label: '设备型号', value: board.model || 'DWR-BE7200G' },
              { label: '发行版', value: board.release?.distribution || 'ImmortalWrt' },
              { label: '固件版本', value: board.release?.description || board.release?.version || '—' },
              { label: '内核版本', value: board.kernel || '—' },
            ]}
          />
          <div className="card-divider" />
          <QualityBar
            label="内存使用率"
            value={usedPercent}
            domain={[0, 100]}
            unit="%"
            higherIsWorse
            tone={usageTone(usedPercent)}
          />
          <Typography.Text type="tertiary" size="small" className="hint-line hint-line--tight">
            已用 {gb(usedBytes)} / 总计 {gb(mem?.total)}
          </Typography.Text>
        </PageCard>

        <ModemIdentity />
      </TwoCol>

      <section className="page-section">
        <SectionHeader title="无线射频" desc="主无线接口当前的信道、功率与关联终端" icon={<IconWifi />}
          extra={<RefreshBtn label="刷新射频状态" loading={refreshing} onClick={()=>void refresh()} />} />
        <TwoCol>
          {(Object.keys(bands) as Interface[]).map(name=>{
            const radio=cpe[name];
            const state=radio?.state;
            return <PageCard key={name} title={bands[name]+' 无线'} hint={'主接口 '+name}
              extra={<Tag size="small" color={TAG_COLOR[state==='ENABLED' || state==='IF_UP' ? 'success' : 'neutral']}>
                {state ? stateNames[state] ?? state : !radio ? '读取中' : '状态未读到'}
              </Tag>}>
              <Kv columns={2} items={[
                {label:'主信道',value:radio?.channel!=null ? `CH ${radio.channel}` : '未读到'},
                {label:'工作带宽',value:radio?.width ? radio.width+' MHz' : '未读到'},
                {label:'工作频率',value:reading(radio?.frequency,'MHz')},
                {label:'驱动报告功率',value:reading(radio?.power,'dBm')},
                {label:'噪声底',value:reading(radio?.noise,'dBm')},
                {label:'关联终端',value:reading(radio?.stations,'台')},
              ]} />
            </PageCard>;
          })}
        </TwoCol>
      </section>
    </div>
  );
};

export default System;
