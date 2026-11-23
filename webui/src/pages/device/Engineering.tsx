import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Banner, Button, Input, Modal, Select, Tag } from '@douyinfe/semi-ui';
import { IconRefresh } from '@douyinfe/semi-icons';
import { Link, useSearchParams } from 'react-router-dom';
import { Field, Kv, PageCard, Panel, SectionHeader, TwoCol } from '@/ui/widgets';
import { Toggle, SimControls } from '@/modules/cellular/DeviceControls';
import { ScanResults } from '@/modules/cellular/ScanResults';
import { TAG_COLOR } from '@/ui/tokens';
import { ubus } from '@/services/deviceUbus';
import {
  WIFI_FLAGS, type WifiFlag, type Policy, AT_QUERIES, POWER_PRESETS, modemTemperatures, engineeringError, scanActive, scanStates, simLabels,
  type AtResult, type EngineeringInfo, type MimoInfo, type PowerRadio, type ScanRat, type ScanReply,
  type ScanScope, type SimStatus,
} from '@/modules/cellular/engineering';

const radioNames: Record<PowerRadio, string> = { '2g': '2.4 GHz', '5g': '5 GHz' };
const powerLabel = (percent: number) => percent === 100 ? '默认 · 100%' : `${percent}%`;
const temperature = (number: number) => `${(number / 1000).toFixed(1)} °C`;
type Confirmation = { title: string; description: string; command?: string; label: string; perform: () => Promise<void> };

const Engineering: React.FC = () => {
  const [query] = useSearchParams();
  const scanSection = useRef<HTMLElement>(null);
  const loadingInfo = useRef(false);
  const [info, setInfo] = useState<EngineeringInfo | null>(null);
  const [sim, setSim] = useState<SimStatus | null>(null);
  const [mimo, setMimo] = useState<MimoInfo | null>(null);
  const [pinLock,setPinLock]=useState<boolean|null>(null);
  const [policy,setPolicy]=useState<Policy>({});
  const [modemTemps,setModemTemps] = useState<ReturnType<typeof modemTemperatures>>([]);
  const [tempNote,setTempNote] = useState('');
  const [scan, setScan] = useState<ScanReply | null>(null);
  const [power, setPower] = useState<Partial<Record<PowerRadio, number>>>({});
  const [rat, setRat] = useState<ScanRat>('NR');
  const [scope, setScope] = useState<ScanScope>('network');
  const [command, setCommand] = useState('AT+CSQ');
  const [at, setAt] = useState<AtResult | null>(null);
  const [atBusy, setAtBusy] = useState(false);
  const [atProblem, setAtProblem] = useState('');
  const [loading, setLoading] = useState(false);
  const [confirm, setConfirm] = useState<Confirmation | null>(null);
  const [writing, setWriting] = useState(false);
  const [feedback, setFeedback] = useState<{ kind: 'bad' | 'ok'; text: string } | null>(null);
  const [accessProblem, setAccessProblem] = useState('');

  const load = useCallback(async () => {
    if (loadingInfo.current) return;
    loadingInfo.current = true;
    setLoading(true);
    setAccessProblem('');
    setModemTemps([]);setTempNote('');
    try {
      const supported = await ubus<EngineeringInfo>('dlink-cellular', 'engineering_info');
      if (supported.ok !== true) throw new Error(supported.error || 'unsupported');
      setInfo(supported);
      setPower({});
      // SIM and MIMO share the modem mutex; read them serially.
      setMimo(await ubus<MimoInfo>('dlink-cellular', 'mimo_info').catch(() => null));
      setSim(await ubus<SimStatus>('dlink-cellular', 'sim_status').catch(() => null));
      setPinLock((await ubus<{enabled?:boolean}>('dlink-cellular','sim_protection').catch(()=>null))?.enabled ?? null);
      setPolicy(await ubus<Policy>('dlink-cellular','radio_policy').catch(()=>({})));
      const task = supported.scan ? await ubus<ScanReply>('dlink-cellular','scan_status').catch(()=>null) : null;
      setScan(task);
      if (scanActive(task?.state)) {
        setTempNote('正在扫小区，基带温度稍后可刷新。');
      } else {
        // Read in the same serial chain as SIM/MIMO, without changing the AT console.
        const query = () => ubus<AtResult>('dlink-cellular','at_query',{command:'AT+QTEMP'});
        try {
          let result=await query();
          if (result.error==='busy') {
            await new Promise(resolve=>setTimeout(resolve,250));
            result=await query();
          }
          if (result.ok && result.modem_ok) setModemTemps(modemTemperatures(result.reply || ''));
          else setTempNote(result.error==='busy' ? '基带忙，暂未读到温度。' : '暂未读到基带温度。');
        } catch { setTempNote('暂未读到基带温度。'); }
      }
    } catch (error) {
      setInfo(null);setSim(null);setMimo(null);setPinLock(null);setPolicy({});
      setAccessProblem(engineeringError(error));
    } finally { loadingInfo.current = false; setLoading(false); }
  }, []);

  useEffect(() => { void load(); }, [load]);
  useEffect(() => {
    if (query.get('to') === 'scan' && scanSection.current) scanSection.current.scrollIntoView({ block: 'start' });
  }, [query, info?.ok]);

  const activeScan = scanActive(scan?.state);
  const refreshScan = useCallback(async () => {
    try {
      const next = await ubus<ScanReply>('dlink-cellular', 'scan_status');
      if (next.ok === true) setScan(next);
    } catch { /* Existing task is not resubmitted on an interrupted status read. */ }
  }, []);
  useEffect(() => {
    if (!activeScan) return;
    const id = window.setInterval(refreshScan, 1300);
    return () => window.clearInterval(id);
  }, [activeScan, refreshScan]);

  const atInFlight = useRef(false);
  const sendAt = async (text: string, custom: boolean) => {
    if (atInFlight.current) return;
    atInFlight.current = true;
    setAtBusy(true); setAt(null); setAtProblem('');
    try {
      const next = await ubus<AtResult>('dlink-cellular', custom ? 'at_send' : 'at_query',
        custom ? { command: text, confirm: true } : { command: text });
      if (next.ok !== true) throw new Error(next.error || 'at_no_response');
      setAt(next);
    } catch (err) { setAtProblem(engineeringError(err)); }
    finally { setAtBusy(false); atInFlight.current = false; }
  };
  const runAt = () => {
    if (!info?.ok || writing || atInFlight.current || activeScan || loading) return;
    const text = command.trim();
    if (!/^at/i.test(text) || /[\x00-\x1f\x7f]/.test(command) || new TextEncoder().encode(text).length > 509) {
      setAtProblem('请输入以 AT 开头的单行命令，最多 509 字节。');return;
    }
    const known = AT_QUERIES.find(([value])=>value === text.toUpperCase());
    if (known) { void sendAt(known[0],false); return; }
    const custom = 'AT' + text.slice(2);
    setConfirm({title:'发送自定义 AT 命令？',label:'确认发送', command:custom,
      description:'此命令将直接交给基带，可能更改配置或中断连接。发送后不会自动重试。',
      perform:()=>sendAt(custom,true)});
  };

  const submit = async () => {
    if (!confirm || writing) return;
    setWriting(true);
    setFeedback(null);
    try { await confirm.perform(); }
    catch (err) { setFeedback({ kind: 'bad', text: engineeringError(err) }); }
    finally { setConfirm(null); setWriting(false); }
  };

  const changeMimo = (rat: 'LTE' | 'NR', current: boolean) => {
    const enabled = !current;
    const key = rat === 'NR' ? 'nr' : 'lte';
    setConfirm({
      title: `${enabled ? '允许' : '停用'} ${rat} 4×4 MIMO？`,
      label: '确认修改',
      description: '基带可能重新协商连接。这里只改 4×4 许可，不指定当前空间流数，不主动重启射频。',
      perform: async () => {
        try {
          const result = await ubus<{ ok?: boolean; enabled?: boolean }>('dlink-cellular', 'mimo_set', { rat, enabled, confirm: true });
          if (result.ok !== true || result.enabled !== enabled) throw new Error('readback');
          setMimo((last) => ({ ...last, [key]: result.enabled }));
          setFeedback({ kind: 'ok', text: `${rat} 4×4 MIMO ${enabled ? '已允许' : '已停用'}，已回读基带配置。` });
        } catch (err) {
          setMimo(await ubus<MimoInfo>('dlink-cellular', 'mimo_info').catch(() => null));
          throw err;
        }
      },
    });
  };
  const savePower = (radio: PowerRadio, expected: number, percent: number) => setConfirm({
    title: `保存 ${radioNames[radio]} 功率档：${powerLabel(percent)}？`,
    label: '保存档位',
    description: '只修改此频段的无线配置，不调整国家/地区、不重载网络。档位在下一次正常重载无线时生效。',
    perform: async () => {
      const result = await ubus<{ ok?: boolean; percent?: number; applied?: boolean }>('dlink-cellular', 'wifi_power_set', {
        radio, percent, expected, confirm: true,
      });
      if (result.ok !== true || result.percent !== percent) throw new Error('readback');
      setInfo((last) => last ? { ...last, wifi: last.wifi?.map((item) => item.radio === radio ? { ...item, percent } : item) } : last);
      setFeedback({ kind: 'ok', text: `${radioNames[radio]} 配置已保存并回读；当前 Wi-Fi 未重载。` });
    },
  });

  const locked = !info?.ok || writing || loading || atBusy || activeScan;
  const setPolicyValue = (setting:'nr'|'roaming', expected:number, value:number, title:string) => setConfirm({
    title, label:'确认修改', description:'修改蜂窝策略可能引起重新注册并短暂中断数据连接。',
    perform: async () => {
      try{
        const r=await ubus<{ok:boolean;value:number}>('dlink-cellular','radio_policy_set',{setting,value,expected,confirm:true});
        if(!r.ok || r.value!==value) throw Error('readback');
        setPolicy(last=>({...last,[setting]:value}));setFeedback({kind:'ok',text:'蜂窝策略已回读。'});
      } catch(e){await load();throw e;}
    },
  });
  const wifiFlag=(radio:PowerRadio,flag:WifiFlag,expected:boolean)=>setConfirm({
    title:`${expected?'关闭':'开启'} ${radioNames[radio]}「${WIFI_FLAGS[flag]}」？`,label:'保存设置',
    description:({ap_enabled:'下次无线重载时，此频段主网络将按新配置启停。',broadcast:'关闭后，连接此网络需手动输入名称。',isolate:'开启后，同一主 AP 的客户端将无法直接互访。',wmm:'关闭 WMM 可能降低无线速率。'})[flag]+' 仅保存配置，本次不重载无线。',
    perform:async()=>{
      try{
        const r=await ubus<{ok:boolean;enabled:boolean}>('dlink-cellular','wifi_flag_set',{radio,flag,expected,enabled:!expected,confirm:true});
        if(!r.ok||r.enabled!==!expected)throw Error('readback');
        setInfo(last=>last?{...last,wifi:last.wifi?.map(w=>w.radio===radio?{...w,[flag]:!expected}:w)}:last);
        setFeedback({kind:'ok',text:'无线配置已回读，下次无线重载时生效。'});
      }catch(e){await load();throw e;}
    }
  });
  const startScan = () => setConfirm({
    title: '开始在线扫小区？',
    label: '开始扫描',
    description: '扫描期间蜂窝网络可能暂时波动，部分基带操作需等扫描结束。扫描超时会请求取消，不修改频段或小区锁。',
    perform: async () => {
      const result = await ubus<ScanReply>('dlink-cellular', 'scan_start', { rat, scope, confirm: true });
      if (result.ok !== true) throw new Error(result.error || 'scan_start');
      setScan(result);
    },
  });

  const stopScan = async () => {
    if (writing) return;
    setWriting(true);
    try {
      const result = await ubus<ScanReply>('dlink-cellular', 'scan_stop', { confirm: true });
      if (result.ok !== true) throw new Error(result.error || 'scan_stop');
      setScan(result);
    } catch (err) { setFeedback({ kind: 'bad', text: engineeringError(err) }); }
    finally { setWriting(false); }
  };

  return (
    <div className="page-stack engineering-page">
      <div className="page-toolbar">
        <div className="page-toolbar-left"><span className="toolbar-pill">RG620T · 管理员工具</span></div>
        <div className="page-toolbar-right">
          <Button size="small" icon={<IconRefresh />} loading={loading} disabled={writing || atBusy}
            onClick={() => void load()}>读取设备状态</Button>
          <Link className="scan-link" to="/network/info">网络状态</Link>
        </div>
      </div>

      {accessProblem && <Banner type="warning" closeIcon={null} description={accessProblem} />}
      {feedback && <Banner type={feedback.kind === 'bad' ? 'danger' : 'success'} closeIcon={null} description={feedback.text} />}

      <div className="bento-primary">
        <PageCard variant="hero" title="AT 调试" hint="输入单行 AT 命令，或选择下方快捷查询">
          <form className="engineering-at-form" onSubmit={(event) => { event.preventDefault(); void runAt(); }}>
            <Input id="engine-at-command" value={command} onChange={setCommand} aria-label="AT 命令" autoComplete="off" spellCheck={false} placeholder="例如 ATI" className="engineering-at-input" />
            <Button htmlType="submit" theme="solid" loading={atBusy} disabled={!info?.ok || writing || activeScan || loading}>
              发送命令
            </Button>
          </form>
          <div className="engineering-presets" aria-label="快捷查询">
            {AT_QUERIES.map(([value, label]) => (
              <button key={value} type="button" className={`band-chip${command.trim().toUpperCase() === value ? ' active' : ''}`} aria-label={value+' '+label} aria-pressed={command.trim().toUpperCase() === value}
                onClick={() => { setCommand(value); setAtProblem(''); }} ><code>{value}</code><span>{label}</span></button>
            ))}
          </div>
          <div className="engineering-terminal">
            <div className="engineering-terminal-head">
              <strong>{at?.command || '基带回应'}</strong>
              {at && <Tag size="small" color={TAG_COLOR[at.modem_ok ? 'success' : 'warning']}>{at.incomplete ? '回显不完整' : at.modem_ok ? 'OK' : '未返回 OK'}</Tag>}
            </div>
            <pre aria-live="polite">{atProblem || (atBusy ? '等待基带回应…' : at?.reply || '发送命令后在这里显示基带回应。')}</pre>
          </div>
        </PageCard>

        <PageCard title="SIM 卡" extra={<Tag size="small" color={TAG_COLOR[sim?.state === 'ready' ? 'success' : 'neutral']}>
          SIM · {sim?.state ? simLabels[sim.state] || '未知' : '未读到'}
        </Tag>}>
          <SimControls sim={sim} enabled={pinLock} disabled={locked} busy={writing} onBusy={setWriting} onRefresh={load}
            report={(bad,text)=>setFeedback({kind:bad?'bad':'ok',text})} />
          <div className="card-divider" />
          <Panel title="剩余尝试次数" extra="只读">
            <Kv items={[
              { label: 'PIN1 剩余', value: sim?.pin1 != null ? `${sim.pin1} 次` : '—' },
              { label: 'PUK1 剩余', value: sim?.puk1 != null ? `${sim.puk1} 次` : '—' },
            ]} />
          </Panel>
        </PageCard>
      </div>

      <PageCard title="设备温度" bodyClassName="engineering-temperatures">
        {!!modemTemps.length && <Panel title="基带温度"
          extra={modemTemps.some(t=>(t.cooling ?? 0) > 0) ? <Tag size="small" color={TAG_COLOR.warning}>已触发降频</Tag> : '未降频'}>
          <Kv dense columns={3} items={modemTemps.map(({sensor,celsius,cooling})=>({
            label:sensor,
            value:`${celsius.toFixed(1)} °C${cooling ? ` · 降频 L${cooling}` : ''}`,
          }))}/>
        </Panel>}
        {!!info?.thermal?.length && <Panel title="系统温度">
          <Kv dense items={info.thermal.map(({sensor,milli_c})=>({label:sensor,value:temperature(milli_c)}))}/>
        </Panel>}
        {tempNote ? <p className="engineering-muted">{tempNote}</p> : !modemTemps.length && !info?.thermal?.length &&
          <p className="engineering-muted">{loading ? '正在读取温度…' : '暂无可读温度'}</p>}
      </PageCard>

      <section className="page-section">
        <SectionHeader title="射频设置" />
        <TwoCol>
          <PageCard title="蜂窝 4×4 MIMO" hint="实际空间流见「网络状态 → 服务载波」">
            {(['NR', 'LTE'] as const).map((item) => {
              const current = item === 'NR' ? mimo?.nr : mimo?.lte;
              return <Toggle key={item} name={`${item==='NR'?'5G NR':'4G LTE'} 4×4 MIMO`} label={item==='NR'?'5G NR':'4G LTE'} value={current} disabled={locked}
                onChange={()=>{if(typeof current==='boolean')changeMimo(item,current);}} />;
            })}
            <p className="hint-line">蜂窝上行功率由基站和基带控制，PUSCH 读数见服务载波。</p>
          </PageCard>

          <PageCard title="Wi-Fi 功率档" hint="原厂相对档位，下次重载无线时生效">
            {(info?.wifi || []).map(({ radio, percent }) => {
              const value = power[radio] ?? percent;
              return <div className="engineering-setting engineering-setting--wifi" key={radio}>
                <div className="engineering-setting-label">
                  <strong>{radioNames[radio]}</strong>
                  {value !== percent && <span>已配置 {powerLabel(percent)}</span>}
                </div>
                <Select size="small" aria-label={`${radioNames[radio]} 功率档`} value={value}
                  optionList={(POWER_PRESETS.some((p) => p === percent) ? POWER_PRESETS : [percent, ...POWER_PRESETS])
                    .map((p) => ({ label: powerLabel(p), value: p }))}
                  onChange={(next) => setPower((last) => ({ ...last, [radio]: Number(next) }))} />
                <Button size="small" disabled={value === percent || writing || loading} onClick={() => savePower(radio, percent, value)}>保存</Button>
              </div>;
            })}
            {!info?.wifi?.length && <p className="hint-line">未读到匹配的 MT7990 无线配置。</p>}
          </PageCard>
        </TwoCol>
        <PageCard title="蜂窝接入策略" hint="SA 与 NSA 可独立设置。开关表示允许使用的组网方式，不代表当前驻留。">
          {([[2,'允许独立组网 SA'],[4,'允许非独立组网 NSA']] as const).map(([mask,name])=>{
            const nr=policy.nr,known=nr!=null&&[1,3,5,7].includes(nr);
            return <Toggle key={name} name={name} value={known?!!(nr&mask):null} disabled={locked}
              onChange={()=>{if(known)setPolicyValue('nr',nr,nr^mask,(nr&mask?'关闭':'开启')+name+'？');}} />;
          })}
          <Toggle name="开机自动拨号" value={info?.wan_auto} disabled={locked} onChange={()=>{
            const expected=info?.wan_auto;
            if(typeof expected!=='boolean')return;
            setConfirm({title:`${expected?'关闭':'开启'}开机自动拨号？`, label:'保存设置',
              description:'保存蜂窝 WAN 的自动启动设置；不立即断开或重拨当前连接。',perform:async()=>{
                try{
                  const r=await ubus<{ok:boolean;enabled:boolean}>('dlink-cellular','wan_auto_set',{enabled:!expected,expected,confirm:true});
                  if(!r.ok||r.enabled!==!expected)throw Error('readback');
                  setInfo(last=>last?{...last,wan_auto:!expected}:last);setFeedback({kind:'ok',text:'自动拨号设置已回读，当前连接未重拨。'});
                }catch(e){await load();throw e;}
              }});
          }}/>
          <Field label="漫游限制"><Select aria-label="漫游限制" value={policy.roaming ?? undefined} placeholder="未读到配置"
            disabled={locked||policy.roaming==null} optionList={[{value:0,label:'不限制漫游'},{value:1,label:'禁止国际漫游'},{value:2,label:'禁止国内漫游'},{value:4,label:'禁止高优先级 PLMN 搜索'}]}
            onChange={v=>{if(policy.roaming!=null && policy.roaming!==v)setPolicyValue('roaming',policy.roaming,Number(v),'修改漫游限制？');}} /></Field>
        </PageCard>
        <PageCard title="主 Wi-Fi 网络" hint="按频段保存，下次无线重载时生效。">
          <TwoCol>{info?.wifi?.map(w=><Panel key={w.radio} title={radioNames[w.radio]}>
            {(Object.keys(WIFI_FLAGS) as WifiFlag[]).map(flag=><Toggle key={flag} name={radioNames[w.radio]+' '+WIFI_FLAGS[flag]} label={WIFI_FLAGS[flag]}
              value={w[flag]} disabled={writing||loading} onChange={()=>{const current=w[flag];if(typeof current==='boolean')wifiFlag(w.radio,flag,current);}} />)}
          </Panel>)}</TwoCol>
          {!info?.wifi?.length && <p className="hint-line">未读到主无线网络。</p>}
        </PageCard>
      </section>

      <section ref={scanSection} className="page-section engineering-scan">
        <SectionHeader title="在线扫小区" desc="按制式扫描附近小区，结果可带入锁小区页" />
        <PageCard title="扫描任务" extra={scan?.state && <Tag color={TAG_COLOR[activeScan ? 'warning' : 'neutral']}>{scanStates[scan.state] || scan.state}</Tag>}>
          <div className="engineering-scan-form">
            <Field label="扫描制式">
              <Select aria-label="扫描制式" value={rat} onChange={(value) => setRat(value as ScanRat)} disabled={activeScan}
                optionList={[{ label: '5G NR', value: 'NR' }, { label: '4G LTE', value: 'LTE' }, { label: 'NR + LTE', value: 'both' }]} />
            </Field>
            <Field label="扫描范围">
              <Select aria-label="扫描范围" value={scope} onChange={(value) => setScope(value as ScanScope)} disabled={activeScan}
                optionList={[{ label: '网络范围', value: 'network' }, { label: '在线全频段', value: 'all' }]} />
            </Field>
            <Button theme="solid" disabled={!info?.scan || activeScan || writing || atBusy || loading} onClick={startScan}>开始扫描</Button>
            {activeScan && <Button disabled={scan?.state === 'stopping' || writing} onClick={() => void stopScan()}>停止扫描</Button>}
          </div>
          {!info?.scan && <p className="hint-line">设备未报告扫描接口。</p>}
          {!!scan?.cells?.length && <>
            <div className="card-divider" />
            <ScanResults cells={scan.cells} complete={scan.state === 'complete'} />
          </>}
          {scan?.state === 'complete' && !scan.cells?.length && <p className="hint-line">扫描完成，基带未返回小区。</p>}
        </PageCard>
      </section>

      <Modal width="min(440px, calc(100vw - 36px))" title={confirm?.title} visible={!!confirm} okText={confirm?.label} cancelText="返回"
        okButtonProps={{ 'aria-label': confirm?.label }} cancelButtonProps={{ 'aria-label': '返回' }}
        confirmLoading={writing} onOk={submit} onCancel={() => { if (!writing) setConfirm(null); }}>
        {confirm?.command && <pre className="engineering-at-preview">{confirm.command}</pre>}
        <p>{confirm?.description}</p>
      </Modal>
    </div>
  );
};

export default Engineering;
