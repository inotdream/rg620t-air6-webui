const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { chromium } = require(process.env.PW_CORE || 'playwright-core');

const sid = '3456789abcdef0123456789abcdef012';
const carrier = { rat: 'NR', primary: true, state: 2, band: 5, arfcn: 175310, pci: 0, bw: '10',
  dl: { layers: 2, mcs: 11, modulation: '16QAM', kbytes_s: 1000 }, ul: { layers: 1, mcs: 3, modulation: 'QPSK', pusch_dbm: 14 } };
const neighbor = { rat: 'NR', band: 78, arfcn: 636666, pci: 0, cell: '13', tac: 123, rsrp: -100.25, sinr: 12 };
const overview = { ok: true, register: { state: 2, registered: true, rat: '5G SA', plmn: '46001', tac: 123, cell: '12', reject: 0 },
  nr: { rsrp: -101, rsrq: -13, sinr10: 57, rssi: -73 }, lte: null, cqi: { nr: 9 },
  cells: [{ ...carrier, cell: '12', tac: 123, rsrp: -101 }, neighbor],
  carriers: [carrier], ambr: { net_dl: 300000 } };
let broadcast=true, auto=true;
let protection = false, simState = 'ready', remaining = 3, nrMode = 7;
let scanState = 'complete', nr = true, percent = 100, online = true, lockArfcn = 636666;
// Synthetic scan: fourteen distinct targets, each reported twice.
const testBands = [[78, 630000], [5, 175000], [41, 510000], [28, 153000], [1, 430000]];
const completeCells = Array.from({length:14}, (_,i)=>{
  const [band,arfcn]=testBands[i % testBands.length];
  return {rat:'NR', band, arfcn, pci:100+i, rsrp:-88-i*1.25, sinr:12-i*1.5, cell:'0'};
}).flatMap(cell=>[cell,{...cell}]);
let lockOpt=1, lockApi=0, lockList=null, sdkTest=false, availableBytes=60*1024*1024;
const secondary = { ...carrier, primary:false, arfcn:636666, pci:0, band:78 };
let modemTemp = '+QTEMP:"","0.0","0"\r\n+QTEMP:"SOC_On_Die","71.8","0"\r\n+QTEMP:"PA_Group1_NTC","63.2","0"\r\n+QTEMP:"RFIC_NTC","-128.0","0"\r\nOK';
let thermal = [{ sensor: 'soc', milli_c: 53400 }, { sensor: 'wmac', milli_c: 61500 }];
let wifiCase='driver';
const calls = [], streams = new Set();
const dist = path.resolve(__dirname, '../dist');
const contentType = { '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.html': 'text/html' };

const sse = (event, data) => `event: ${event}\r\ndata: ${JSON.stringify(data)}\r\n\r\n`;
function pushNetwork() {
  for (const stream of streams) if (stream.sendNetwork) stream.write(sse('network', overview));
}
const server = http.createServer(async (req, res) => {
  if (req.url === '/cgi-bin/rg620-events') {
    let body = '';
    for await (const chunk of req) body += chunk;
    if (!online || ![sid + ':NS', sid + ':-S'].includes(body)) return res.writeHead(503).end();
    res.sendNetwork = body.endsWith(':NS');
    streams.add(res);
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store' });
    res.write(':fixture\r\n\r\n');
    if (res.sendNetwork) {
      const frame = sse('network', overview);
      res.write(frame.slice(0, 29));
      setTimeout(() => { if (!res.destroyed) res.write(frame.slice(29)); }, 25);
    }
    setTimeout(() => { if (!res.destroyed) res.write(sse('sms', 10001) + sse('health', { network: res.sendNetwork, sms: true })); }, 50);
    res.on('close', () => streams.delete(res));
    return;
  }
  if (req.url === '/ubus') {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const { id, params: [session, object, method, params] } = JSON.parse(raw);
    calls.push({ session, object, method, params });
    let result = { ok: true };
    if (object === 'iwinfo' && method === 'info') {
      const low=params.device==='ra0';
      result=wifiCase==='partial'?{htmode:'VHT80',txpower:0}:wifiCase==='ap'?{}:{
        channel:low?13:52,frequency:low?2472:5260,htmode:low?'HT20':'VHT160',txpower:low?23:18,noise:-91};
    } else if(object==='iwinfo' && method==='assoclist'){
      result=wifiCase==='driver'?{results:params.device==='ra0'?[]:[{mac:'02:00:00:00:00:01'}]}:{};
    } else if(object.startsWith('hostapd.')){
      result=wifiCase==='ap'?(method==='get_status'?{status:'ENABLED',channel:36,freq:5180}:{clients:{a:{assoc:true},b:{assoc:false}}}):{};
    } else if(object==='network.device' && ['ra0','rai0'].includes(params.name)){
      result=wifiCase==='driver'?{up:true}:{};
    } else if (object === 'dlink-cellular') {
      switch (method) {
        case 'access': result={ok:true,sdk:sdkTest,services:false};break;
        case 'sdk_identity': result={ok:true,imei:'111111111111111',firmware:null,sim:{state:'ready',number:'+8610000000000',iccid:'12345678901234567890',imsi:'123456789012345'}};break;
        case 'summary':
        case 'overview': result = overview; break;
        case 'locks': result = { ok: true, ...(lockApi ? {lock_api:lockApi,list:lockList} : {}), cell: lockOpt===null?null:{ opt: lockOpt, rat: 'NR', arfcn: lockArfcn, pci: 0, mode: 3 },
          supported: { nr: [5, 78], lte: [3] }, current: { nr: [5, 78], lte: [3] } }; break;
        case 'cell_set':
          lockArfcn = +params.arfcn;
          if (lockApi) { lockOpt=params.kind==='arfcn'?2:1; result={ok:true,applied:!!params.apply}; }
          break;
        case 'cell_clear': if(lockApi){lockOpt=0;result={ok:true,applied:!!params.apply};}break;
        case 'cell_list_set': if(lockApi){lockList=params.cells.split(',').map(row=>{const [rat,arfcn,pci]=row.split(':');return {rat,arfcn:+arfcn,pci:+pci};});result={ok:true,applied:!!params.apply,recorded:true,verified:false};} break;
        case 'cell_list_clear': if(lockApi){lockList=[];result={ok:true,applied:!!params.apply,recorded:true,verified:false};}break;
        case 'voice_status': result = { ok: true, calls: [] }; break;
        case 'sms_list': result = { ok: true, indexes: [] }; break;
        case 'qos': result = { ok: true, kind: '5QI', sessions: [
          { cid: 0, apn: 'lab.example', role: 'data', classes: [6] },
          { cid: 1, apn: 'ims.lab.example', role: 'ims', classes: [] },
        ] }; break;
        case 'diag_checks': result = { ok: true, sim: 'ready', radio: true, ims: true, ceer: 0, ratmode: 'NR/LTE' }; break;
        case 'diag': result = { ok: true, counters: { nr_rach: { attempt: '13', failure: '2' } } }; break;
        case 'engineering_info': result = { ok: true, scan: true, wan_auto:auto, wifi: [{ radio:'2g',percent:100,ap_enabled:true,broadcast,isolate:false,wmm:true }, { radio:'5g',percent,ap_enabled:true,broadcast:true,isolate:false,wmm:true }],
          thermal }; break;
        case 'sim_status': result = { ok: true, state: simState, pin1: remaining, puk1: 10 }; break;
        case 'sim_protection': result = {ok:true, enabled:protection}; break;
        case 'sim_action':
          if (params.secret === '9999') { remaining--; result = {ok:false,error:'sim_rejected'}; }
          else {protection=params.action==='enable'; result={ok:true};} break;
        case 'radio_policy': result = {ok:true, nr:nrMode, roaming:0}; break;
        case 'radio_policy_set': nrMode=params.value; result = {ok:true,value:nrMode}; break;
        case 'wan_auto_set': auto=params.enabled;result={ok:true,enabled:auto};break;
        case 'wifi_flag_set': broadcast=params.enabled;result={ok:true,enabled:broadcast};break;
        case 'beam_info': result={ok:true,beams:[{cc:'NR PCC',id:0,power:-101,avg:-102,snr:4}],rx:[{cc:'NR PCC',rsrp:[-100,null,-108,-110],snr:[5,null,0,-2],rssi:[-71,null,-76,-79]}]}; break;
        case 'mimo_info': result = { ok: true, nr, lte: null }; break;
        case 'mimo_set': nr = params.enabled; result = { ok: true, enabled: nr }; break;
        case 'wifi_power_set': percent = params.percent; result = { ok: true, percent, applied: false }; break;
        case 'at_send':result={ok:true,modem_ok:false,reply:'ERROR'};break;
        case 'at_query': result = { ok: true, modem_ok: true, command: params.command, reply: params.command==='AT+QTEMP' ? modemTemp : params.command==='ATI'?'RG620T-EU\nOK':'+CSQ: 18,99\nOK' }; break;
        case 'scan_status':
          result = { ok: true, state: scanState, cells: scanState === 'complete' ? completeCells : scanState === 'cancelled' ? [neighbor, neighbor, { ...neighbor, cell: '42', sinr: 0 }, { ...neighbor, pci: 2, rsrp: null }] : [] };
          break;
        case 'scan_start': scanState = 'running'; result = { ok: true, state: 'queued', cells: [] }; break;
        case 'scan_stop': scanState = 'cancelled'; result = { ok: true, state: 'stopping', cells: [] }; break;
      }
    } else if (object === 'system' && method === 'info' && sdkTest) {
      result={uptime:60,load:[0,0,0],memory:{total:100*1024*1024,free:20*1024*1024,...(availableBytes==null?{}:{available:availableBytes})}};
    } else if (object === 'network.interface') {
      result = { interface: [{ interface: 'wan', up: true, proto: 'ql_datacall', device: 'ccmni2', uptime: 120, 'ipv4-address': [{ address: '192.0.2.5' }] }] };
    } else if (object === 'network.device') {
      result = { statistics: { rx_bytes: 1536189 + calls.length * 32768, tx_bytes: 1048576 + calls.length * 16384 } };
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({ jsonrpc: '2.0', id, result: [0, result] }));
  }
  const url = new URL(req.url, 'http://localhost');
  if (!url.pathname.startsWith('/rg620/')) return res.writeHead(404).end();
  const file = path.resolve(dist, url.pathname.slice(7) || 'index.html');
  if (!file.startsWith(dist + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) return res.writeHead(404).end();
  res.setHeader('Content-Type', contentType[path.extname(file)] || 'application/octet-stream');
  fs.createReadStream(file).pipe(res);
});

(async () => {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  let browser;
  try {
    browser = await chromium.launch({ headless: true, executablePath: process.env.CHROMIUM_PATH });
    const origin = 'http://127.0.0.1:' + server.address().port;
    const ctx = await browser.newContext({ viewport: { width: 1360, height: 960 }, locale: 'zh-CN' });
    await ctx.route('**/*', (route) => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
    await ctx.addInitScript((session) => sessionStorage.setItem('rg620_ubus_session', session), sid);
    const page = await ctx.newPage();
    const browserErrors = [];
    page.on('pageerror', (e) => browserErrors.push(e.message));
    page.setDefaultTimeout(12000);
    const nav = (target) => page.getByRole('navigation').getByRole('button', { name: target, exact: true }).click();
    const visible = (text) => page.getByText(text, { exact: false }).first().waitFor();
    const capture = async (file) => {
      if (process.env.ENGINEERING_ARTIFACTS) await page.screenshot({ path: path.join(process.env.ENGINEERING_ARTIFACTS, file), animations: 'disabled', fullPage: true });
    };
    const verifyNoOverflow = async () => {
      await page.waitForFunction(() => document.documentElement.scrollWidth <= window.innerWidth + 1, undefined, { timeout: 1500 })
        .catch(async () => assert.fail('horizontal overflow: ' + await page.evaluate(() => JSON.stringify(
          Array.from(document.querySelectorAll('body *')).filter((el) => el.getBoundingClientRect().right > innerWidth + 1)
            .slice(0, 6).map((el) => [el.nodeName, el.getAttribute('class'), Math.round(el.getBoundingClientRect().right)]),
        ))));
    };
    const count = (method) => calls.filter((entry) => entry.method === method).length;
    if(process.env.MODEM_CARD_TEST){
      sdkTest=true;await page.setViewportSize({width:390,height:844});await page.goto(origin+'/rg620/#/system/info');
      const card=(title)=>page.locator('.page-card').filter({has:page.getByText(title,{exact:true})});
      const sim=card('SIM 卡'),modem=card('蜂窝模组');
      await sim.getByText(/•+7890/).waitFor();assert.equal(await page.getByText('12345678901234567890',{exact:true}).count(),0);
      await sim.getByRole('button',{name:'显示完整号码'}).click();await sim.getByText('12345678901234567890',{exact:true}).waitFor();
      await sim.getByRole('button',{name:'隐藏号码'}).click();await sim.getByText(/•+7890/).waitFor();
      await modem.getByText('未读到',{exact:true}).first().waitFor();
      const tile=label=>page.locator('.metric').filter({has:page.getByText(label,{exact:true})});
      await tile('内存占用').getByText('40.0 MiB / 100.0 MiB',{exact:true}).waitFor();await verifyNoOverflow();
      if(process.env.ENGINEERING_ARTIFACTS)await sim.screenshot({path:path.join(process.env.ENGINEERING_ARTIFACTS,'sim-mobile.png')});
      availableBytes=null;await page.reload();await tile('非空闲内存').getByText('80',{exact:false}).first().waitFor();
      await visible('含缓存');console.log('PASS: modem/SIM layout, masked identifiers and reveal, missing live reading, available/free memory semantics');return;
    }
    if(process.env.LOCK_PROTOCOL_TEST){
      const settings=origin+'/rg620/#/network/setting',network=origin+'/rg620/#/network/info';
      const dlg=page.getByRole('dialog'), exact=(n)=>dlg.getByRole('button',{name:n,exact:true});
      const target=page.getByRole('button',{name:'锁定 NR 636666 PCI 0',exact:true});
      const last=m=>calls.filter(c=>c.method===m).at(-1)?.params;
      await page.goto(network);lockOpt=0;await target.click();await exact('锁定主小区').waitFor();
      assert.equal(await dlg.getByRole('radio',{name:'只锁频点'}).count(),0);
      assert.equal(await dlg.getByRole('checkbox').count(),0);
      await exact('锁定主小区').click();await dlg.waitFor({state:'hidden'});
      assert.deepEqual(last('cell_set'),{rat:'NR',arfcn:'636666',pci:'0',confirm:true});
      await page.goto(settings);const apply=page.getByRole('checkbox',{name:/立即重新驻留/});
      await visible('候选小区');assert.equal(await apply.count(),0);
      lockApi=2;await page.reload();await apply.waitFor();assert(await apply.isChecked());await page.getByText(/^立即重新驻留（射频重启/).click();assert(!(await apply.isChecked()));
      await page.getByRole('radio',{name:'只锁频点'}).click();
      await page.locator('.candidate-row').filter({hasText:'636666'}).click();
      await page.getByRole('button',{name:'锁定频点',exact:true}).click();
      await page.waitForFunction(()=>document.body.innerText.includes('下次重选'));
      assert.deepEqual(last('cell_set'),{rat:'NR',arfcn:'636666',kind:'arfcn',apply:false,confirm:true});
      lockOpt=0;overview.carriers=[carrier,secondary];await page.goto(network);await visible('服务载波');pushNetwork();
      await page.getByRole('button',{name:'将 NR 636666 / PCI 0 设为主小区',exact:true}).click();await exact('锁定主小区').waitFor();
      const sent=count('cell_set');await exact('取消').click();assert.equal(count('cell_set'),sent);
      await page.setViewportSize({width:390,height:844});await page.getByRole('button',{name:'将 NR 636666 / PCI 0 设为主小区',exact:true}).click();await verifyNoOverflow();
      if(process.env.ENGINEERING_ARTIFACTS)await dlg.screenshot({path:path.join(process.env.ENGINEERING_ARTIFACTS,'protocol-mobile.png')});
      const ready=page.waitForResponse(r=>r.url()===origin+'/ubus'&&r.request().postDataJSON()?.params?.[2]==='cell_set');
      await exact('锁定主小区').click();await ready;await dlg.getByText(/正在按新规则重新驻留/).waitFor();
      overview.carriers=[{...secondary,primary:true,state:2}];pushNetwork();
      await dlg.waitFor({state:'hidden',timeout:10000});
      assert.deepEqual(last('cell_set'),{rat:'NR',arfcn:'636666',pci:'0',kind:'cell',apply:true,confirm:true});
      // A registered PCC outside the submitted list must not be reported as a successful match.
      lockOpt=0;lockList=null;
      const second={...neighbor,arfcn:637000,pci:2};
      overview.cells=[neighbor,second];overview.carriers=[carrier];await page.goto(settings);
      const candidates=page.locator('.candidate-row');await candidates.filter({hasText:'636666'}).click();await candidates.filter({hasText:'637000'}).click();
      await page.getByRole('button',{name:/提交白名单（2）/}).click();await visible('正在重新驻留');
      await visible('已等待 3 秒');assert(!(await page.locator('.status-note').innerText()).includes('名单内'));
      overview.carriers=[{...secondary,arfcn:second.arfcn,pci:second.pci,primary:true,state:2}];pushNetwork();
      await visible('实际主小区在提交的白名单内');
      assert.deepEqual(last('cell_list_set'),{cells:'NR:636666:0,NR:637000:2',apply:true,confirm:true});
      console.log('PASS: old backend exact-lock payload; mixed install hides v2; frequency-only omits PCI; apply opt-out; SCC action and mobile; actual PCC and whitelist match against fixtures');return;
    }
    if(process.env.RADIO_STATUS_TEST){
      await page.goto(origin+'/rg620/#/system/info');
      const card=name=>page.locator('.page-card').filter({has:page.getByText(name,{exact:true})});
      const low=card('2.4 GHz 无线'), high=card('5 GHz 无线');
      await low.getByText('CH 13',{exact:true}).waitFor();
      for(const [box,vals] of [[low,['20 MHz','2472 MHz','23 dBm','0 台']],[high,['CH 52','160 MHz','5260 MHz','18 dBm','1 台']]]){
        for(const v of vals)await box.getByText(v,{exact:true}).waitFor();
      }
      await capture('radio-desktop.png');await page.setViewportSize({width:360,height:800});await verifyNoOverflow();
      wifiCase='partial';await page.getByRole('button',{name:'刷新射频状态'}).click();
      await low.getByText('80 MHz',{exact:true}).waitFor();await low.getByText('0 dBm',{exact:true}).waitFor();
      await low.getByText('未读到',{exact:true}).first().waitFor();
      assert.equal(await low.getByText('0 台',{exact:true}).count(),0);
      wifiCase='ap';await page.getByRole('button',{name:'刷新射频状态'}).click();
      await high.getByText('CH 36',{exact:true}).waitFor();await high.getByText('1 台',{exact:true}).waitFor();
      console.log('PASS: per-band driver values, empty vs unavailable clients, partial fields, hostapd compatibility, refresh, mobile');
      return;
    }
    await page.goto(origin + '/rg620/#/network/info');
    if (process.env.SERVING_TA_TEST) {
      await visible('实时推送中');
      const reading = page.locator('.kv-item').filter({has: page.getByText('定时提前量 TA', {exact:true})}).locator('.kv-value');
      const expectTA = async value => {
        pushNetwork();
        await reading.getByText(value, {exact:true}).waitFor();
      };
      const main = overview.cells[0];
      main.ta = 16;
      neighbor.ta = 88; // same PCI, wrong frequency; never use it as a fallback
      await expectTA('16');
      if (process.env.ENGINEERING_ARTIFACTS) {
        await reading.locator('xpath=ancestor::*[contains(@class,"kv-grid")][1]').screenshot({path:path.join(process.env.ENGINEERING_ARTIFACTS,'serving-ta.png')});
      }
      main.ta = 0;
      await expectTA('0');
      for (const invalid of [null, undefined, 2147483647, 4294967295]) {
        main.ta = invalid;
        await expectTA('未上报');
      }
      main.ta = 16;
      overview.register.cell = '14';
      await expectTA('未上报');
      overview.register.cell = '12';
      overview.carriers = [{...carrier, arfcn: 175330}];
      await expectTA('未上报');
      overview.carriers = [];
      await expectTA('16');
      overview.register.rat = 'LTE';
      await expectTA('未上报');
      overview.cells = [{...main, rat:'LTE', ta:3}];
      await expectTA('3');
      overview.register.registered = false;
      await expectTA('未驻留');
      await page.setViewportSize({width:360,height:800}); await verifyNoOverflow();
      console.log('PASS: serving TA, zero, unavailable, legacy payload, handover, LTE, detached, mobile');
      return;
    }
    if(process.env.LOCK_DIALOG_TEST){
      const row=page.getByRole('button',{name:'锁定 NR 636666 PCI 0',exact:true});
      const dlg=page.getByRole('dialog');
      const close=async()=>{await dlg.getByRole('button',{name:'取消',exact:true}).click();await dlg.waitFor({state:'hidden'});};
      for(const [opt,freq,label] of [[0,0,'锁定主小区'],[1,636666,'解除锁定'],[1,175310,'改锁到此小区'],[2,636666,'改锁到此小区'],[null,0,'重新读取']]){
        lockOpt=opt;lockArfcn=freq;
        await row.click();await dlg.getByRole('button',{name:label,exact:true}).waitFor();
        for(const other of ['锁定主小区','改锁到此小区','解除锁定']) if(other!==label)assert.equal(await dlg.getByRole('button',{name:other,exact:true}).count(),0);
        if(opt===null){lockOpt=0;await dlg.getByRole('button',{name:'重新读取'}).click();await dlg.getByRole('button',{name:'锁定主小区'}).waitFor();}
        await close();
      }
      assert.equal(count('cell_set')+count('cell_clear')+count('cell_list_clear'),0);
      lockOpt=1;lockArfcn=636666;await row.click();await dlg.getByRole('button',{name:'解除锁定'}).waitFor();
      lockArfcn=175310;await dlg.getByRole('button',{name:'解除锁定'}).click();
      await dlg.getByRole('button',{name:'改锁到此小区'}).waitFor();
      assert.equal(count('cell_clear'),0);
      await dlg.getByRole('button',{name:'改锁到此小区'}).click();await dlg.waitFor({state:'hidden'});assert.equal(count('cell_set'),1);
      await row.click();await dlg.getByRole('button',{name:'解除锁定'}).click();await dlg.waitFor({state:'hidden'});
      assert.equal(count('cell_clear'),1);assert.equal(count('cell_list_clear'),0);
      lockOpt=0;await page.setViewportSize({width:360,height:800});await row.click();await dlg.getByRole('button',{name:'锁定主小区'}).waitFor();
      await verifyNoOverflow();await dlg.screenshot({path:path.join(process.env.ENGINEERING_ARTIFACTS,'lock-mobile.png')});
      console.log('PASS: unlocked, same, other, frequency-only, unreadable/retry, stale state, isolated clear, mobile');return;
    }
    await visible('实时推送中');
    await visible('单载波');
    const pcc=page.locator('.carrier-card--primary');
    await pcc.getByText('SSB #0',{exact:true}).waitFor();
    const detail=pcc.locator('details');
    assert.equal(await detail.getAttribute('open'),null);
    assert.equal(await pcc.getByText('Rx3',{exact:true}).isVisible(),false);
    await detail.locator('summary').click();await visible('Rx3');
    await page.setViewportSize({ width:360,height:800 });await verifyNoOverflow();
    await capture('home-beams-mobile.png');
    await page.setViewportSize({ width:1360,height:960 });
    await capture('home-expanded.png');await detail.locator('summary').click();
    assert.ok(count('beam_info')>0,'homepage loads beams without button');
    await capture('home-beams.png');
    await visible('2 层 · MCS 11 · 16QAM');
    await visible('PCI 0');
    const smsReads = count('sms_list');
    for (const stream of streams) stream.write(sse('sms', 10002));
    for (let attempt = 0; attempt < 15 && count('sms_list') === smsReads; attempt += 1)
      await new Promise((resolve) => setTimeout(resolve, 100));
    assert.ok(count('sms_list') > smsReads, 'SMS event triggers the existing private inbox RPC');
    assert.equal(count('sms_read'), 0);
    overview.carriers.push({ ...carrier, primary: false, band: 78, arfcn: 624666, pci: 101 }, { ...carrier, primary: false, band: 41, arfcn: 515000, pci: 14 });
    pushNetwork();
    await visible('NR 3CC · 载波聚合');
    assert.equal(await page.locator('.carrier-card--primary').count(), 1);
    await capture('network-3cc.png');
    const savedCarriers=overview.carriers.splice(0);
    pushNetwork();
    await page.locator('.carrier-measurement').getByText('SSB #0',{exact:true}).waitFor();
    assert.equal(await page.locator('.carrier-grid .empty-surface').count(),0);
    overview.carriers.push(...savedCarriers);pushNetwork();

    await nav('锁频锁小区');
    await visible('仍驻留其他小区');
    assert.equal(await page.locator('.candidate-row').filter({ hasText: '636666' }).getByText('驻留中').count(), 0);
    overview.carriers.splice(0, overview.carriers.length, { ...carrier, band: 78, arfcn: 636666 });
    pushNetwork();
    await visible('已驻留目标');
    const length = count('cell_set');
    assert.equal(length, 0, 'passive lock match must not write radio');

    await nav('工程工具');
    await visible('53.4 °C');
    await visible('71.8 °C');
    assert.equal(await page.getByRole('button',{name:'准备查询基带温度'}).count(),0);
    assert.equal(await page.getByText('-128.0 °C',{exact:true}).count(),0);
    assert.equal(await page.getByText('0.0 °C',{exact:true}).count(),0);
    const manualQueries=()=>calls.filter(x=>x.method==='at_query'&&x.params.command!=='AT+QTEMP').length;

    const pinSwitch = page.getByRole('switch',{name:'开机需要 PIN'});
    await pinSwitch.click();
    assert.equal(count('sim_action'),0);
    await page.getByRole('dialog').getByLabel('当前 PIN',{exact:true}).fill('9999');
    await page.getByRole('dialog').getByRole('button',{name:'确认提交'}).click();
    await visible('SIM 卡未接受');
    assert.equal(count('sim_action'),1);
    assert.equal(await pinSwitch.getAttribute('aria-checked'),'false');
    await pinSwitch.click();
    await page.getByRole('dialog').getByLabel('当前 PIN',{exact:true}).fill('4567');
    await page.getByRole('dialog').getByRole('button',{name:'确认提交'}).click();
    await page.waitForFunction(()=>document.querySelector('[aria-label="开机需要 PIN"]')?.getAttribute('aria-checked') === 'true');
    await page.getByRole('switch',{name:'允许独立组网 SA',exact:true}).click();
    await page.getByRole('dialog').getByRole('button',{name:'确认修改'}).click();
    await page.waitForFunction(()=>document.querySelector('[aria-label="允许独立组网 SA"]')?.getAttribute('aria-checked') === 'false');
    assert.equal(nrMode,5);
    assert.equal(await page.getByRole('button',{name:'读取波束'}).count(),0);
    await page.getByRole('switch',{name:'2.4 GHz 广播网络名称'}).click();
    assert.equal(count('wifi_flag_set'),0);
    await page.getByRole('dialog').getByRole('button',{name:'保存设置'}).click();
    await visible('无线配置已回读');
    assert.deepEqual(calls.find(x=>x.method==='wifi_flag_set').params,{radio:'2g',flag:'broadcast',enabled:false,expected:true,confirm:true});
    await page.getByRole('switch',{name:'开机自动拨号'}).click();
    await page.getByRole('dialog').getByRole('button',{name:'保存设置'}).click();
    await visible('当前连接未重拨');
    simState='puk';await page.getByRole('button',{name:'读取设备状态'}).click();
    await page.getByRole('button',{name:'用 PUK 解锁'}).click();
    const challenge=page.getByRole('dialog');
    await challenge.getByLabel('运营商提供的 PUK').fill('12345678');
    await challenge.getByLabel('新 PIN',{exact:true}).fill('4321');
    await challenge.getByLabel('再次输入新 PIN').fill('1234');
    assert.equal(await challenge.getByRole('button',{name:'确认提交'}).isDisabled(),true);
    await challenge.getByRole('button',{name:'取消'}).click();
    simState='ready';
    thermal = [];
    await page.getByRole('button', { name: '读取设备状态' }).click();
    await page.getByText('71.8 °C',{exact:true}).waitFor();
    await visible('14 个锁定目标');
    await visible('14 个锁定目标 · 28 条上报');
    assert.equal(await page.getByRole('link', { name: '带入锁小区' }).count(), 14);
    assert.equal(await page.locator('.scan-details').count(), 0);
    assert.equal(await page.getByRole('textbox', { name:'AT 命令' }).inputValue(),'AT+CSQ');
    assert.equal(await page.getByText('系统温度',{exact:true}).count(),0);
    modemTemp='+QTEMP:"","0.0","0"\nOK';
    await page.getByRole('button',{name:'读取设备状态'}).click();
    await visible('暂无可读温度');
    assert.equal(await page.getByText('71.8 °C',{exact:true}).count(),0);
    thermal=[{sensor:'mdio_bus:06 / temp1',milli_c:66000},{sensor:'mdio_bus:07 / temp1',milli_c:64000}];
    modemTemp='+QTEMP:"SOC_On_Die","72.1","0"\n+QTEMP:"SOC_NTC","65.0","0"\n+QTEMP:"PA_Group1_NTC","62.8","0"\n+QTEMP:"PA_GROUP2_NTC","62.9","0"\n+QTEMP:"RFIC_NTC","63.3","0"\nOK';
    await page.getByRole('button',{name:'读取设备状态'}).click();
    await visible('72.1 °C');await visible('66.0 °C');
    const temps=page.locator('.page-card').filter({has:page.getByText('设备温度',{exact:true})});
    const simCard=page.locator('.page-card').filter({has:page.getByText('SIM 卡',{exact:true})});
    assert.equal(await temps.getByText('基带温度',{exact:true}).count(),1);
    assert.equal(await temps.getByText('系统温度',{exact:true}).count(),1);
    assert.equal(await simCard.getByText('系统温度',{exact:true}).count(),0);
    assert.equal(await temps.getByRole('switch').count(),0);
    await capture('engineering-desktop.png');
    for (const width of [320, 768, 1024]) {
      await page.setViewportSize({ width, height: 844 });
      await verifyNoOverflow();
    }
    await page.setViewportSize({ width: 1360, height: 960 });
    await page.getByRole('button', { name: '切换主题' }).click();
    await capture('engineering-dark.png');
    await page.getByRole('button', { name: '切换主题' }).click();
    const input=page.getByRole('textbox',{name:'AT 命令'});
    const send=page.getByRole('button',{name:'发送命令',exact:true});
    await input.fill('not an AT command');await send.click();await visible('请输入以 AT 开头');
    assert.equal(manualQueries(),0);
    await input.fill('ati');await send.click();await visible('RG620T-EU');
    assert.equal(manualQueries(),1);
    const custom='AT+EXAMPLE="Case Sensitive"';
    await input.fill(custom);await send.click();
    const confirmAt=page.getByRole('dialog');
    await confirmAt.getByText(custom,{exact:true}).waitFor();
    await confirmAt.getByRole('button',{name:'返回'}).click();assert.equal(count('at_send'),0);
    await send.click();await confirmAt.getByRole('button',{name:'确认发送'}).click();
    await visible('ERROR');
    assert.equal(count('at_send'),1);
    assert.deepEqual(calls.find(x=>x.method==='at_send').params,{command:custom,confirm:true});
    await page.getByRole('button',{name:'AT+CSQ 接收信号',exact:true}).click();
    await send.click();await visible('+CSQ: 18,99');assert.equal(manualQueries(),2);
    const lteSetting = page.locator('.engineering-setting').filter({ hasText: '4G LTE' });
    assert.equal(await lteSetting.getByRole('switch').isDisabled(), true);
    await page.locator('.engineering-setting').filter({ hasText: '5G NR' }).getByRole('switch', { name: '5G NR 4×4 MIMO' }).click();
    assert.equal(count('mimo_set'), 0);
    await page.getByRole('dialog').getByRole('button', { name: '确认修改' }).click();
    await visible('已回读基带配置');
    assert.deepEqual(calls.find((x) => x.method === 'mimo_set').params, { rat: 'NR', enabled: false, confirm: true });

    const wifi = page.locator('.engineering-setting--wifi').filter({ hasText: '5 GHz' });
    await wifi.locator('.semi-select').click();
    await page.getByText('60%', { exact: true }).click();
    await wifi.getByRole('button', { name: '保存', exact: true }).click();
    assert.equal(count('wifi_power_set'), 0);
    await page.getByRole('dialog').getByRole('button', { name: '保存档位' }).click();
    await visible('当前 Wi-Fi 未重载');
    assert.deepEqual(calls.find((x) => x.method === 'wifi_power_set').params, { radio: '5g', percent: 60, expected: 100, confirm: true });

    await page.getByRole('dialog').waitFor({ state: 'hidden' });
    await page.setViewportSize({ width: 390, height: 844 });
    await verifyNoOverflow();
    await page.evaluate(() => window.scrollTo(0, 0));
    await capture('engineering-mobile.png');
    await page.getByRole('button', { name: '开始扫描', exact: true }).click();
    assert.equal(count('scan_start'), 0);
    await verifyNoOverflow();
    await page.getByRole('dialog').getByRole('button', { name: '开始扫描', exact: true }).click();
    await visible('正在扫描');
    await page.getByRole('button', { name: '停止扫描' }).click();
    await visible('部分结果');
    await visible('2 个锁定目标 · 4 条上报');
    await page.locator('.scan-details summary').click();
    await visible('小区 ID 42');
    await verifyNoOverflow();
    await capture('scan-result-mobile.png');
    await page.getByRole('link', { name: '带入锁小区' }).first().click();
    await page.locator('#manual-cell input').first().waitFor();
    assert.equal(await page.locator('#manual-cell input').first().inputValue(), '636666');
    assert.equal(count('cell_set'), 0, 'selecting a scan result must not lock radio');
    await page.setViewportSize({ width: 1360, height: 960 });
    const beforeDial = calls.length;
    await nav('拨号与接口');
    await visible('lab.example');
    await visible('5QI 6');
    await visible('QoS 未上报');
    assert.equal(calls.slice(beforeDial).find((x) => x.method === 'qos').params.contexts, true);
    await page.getByRole('button', { name: '读取诊断' }).click();
    await visible('2 / 13');
    assert.equal(count('wan_redial'), 0);
    await capture('dial-diagnostics.png');

    online = false;
    for (const stream of streams) stream.end();
    await nav('网络状态');
    await visible('轮询模式');
    await visible('信号强度');
    assert.equal(browserErrors.length, 0, browserErrors.join('\n'));
    console.log('PASS: SSE and fallback, three carriers, lock verification, AT/4×4/power, mobile scan flow and dialing diagnostics');
  } finally {
    for (const stream of streams) stream.destroy();
    if (browser) await browser.close();
    await new Promise((resolve) => server.close(resolve));
  }
})().catch((error) => { console.error(error); process.exitCode = 1; });
