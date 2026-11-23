#!/bin/sh
# Linux host, matching SDK headers, fake modem; no network or radio.
set -eu
: "${RIL_INC:?SDK with ql_dm, ql_nw, ql_sim and ql_sms headers}"
base=$(cd "$(dirname "$0")/.." && pwd)
d=$(mktemp -d); trap 'rm -rf "$d"' EXIT
src=$base/backend/cellular/src
helpers=$base/backend/cellular/root/usr/libexec
cd "$d"
sed -e "s|/var/lock/dlink-cell-list.last|$d/list|" -e "s|/usr/libexec/dlink-cellular-voice|$d/voice|" "$src/dlink-cell.c" > dlink-cell.c
sed -e "s|/usr/bin/mipc_wan_cli|$d/mipc|g" -e "s|/usr/libexec/dlink-cellular-voice.awk|$helpers/dlink-cellular-voice.awk|" \
    -e "s|/usr/libexec/dlink-cellular-mipc-calls.awk|$helpers/dlink-cellular-mipc-calls.awk|" "$helpers/dlink-cellular-voice" > actual-voice
cat > voice <<'SH'
#!/bin/sh
if [ "$VOICE_CASE" = legacy ]; then echo '{"ok":false,"error":"busy"}'; exit 0; fi
exec ./actual-voice "$@"
SH
cat > mipc <<'SH'
#!/bin/sh
echo "$VOICE_CASE $1" >> voice.log
case "$VOICE_CASE:$1" in
    call:--at_cmd) printf '+CLCC: 1,0,0,0,0\r\nOK\r\n';;
    idle:--at_cmd|mipc_call:--at_cmd) echo OK;;
    mipc_call:--get_call_status) echo 'result:0,count:1 call_id[0]:2,call_state[0]:0,';;
    mipc_idle:--get_call_status) echo 'result:0,count:0';;
    *) exit 1;;
esac
SH
chmod 755 voice actual-voice mipc
cc -O2 -Wall -Wextra -Werror -I"$d" -I"$src" -I"$RIL_INC" -ffunction-sections -fdata-sections \
    "$base/tests/cell-lock.c" -Wl,--gc-sections -o test
./test > out 2> trace
python3 - <<'PY'
import json, os, signal, subprocess, time
from pathlib import Path
rows = [json.loads(line) for line in Path("out").read_text().splitlines()]
traces = [line.split() for line in Path("trace").read_text().splitlines()]
assert len(rows) == len(traces)
out = {row[0]: j for row, j in zip(traces, rows)}
t = {row[0]: {k:int(v) for k,v in (p.split('=') for p in row[1:])} for row in traces}
def delta(a, b, field): return t[b][field]-t[a][field]
assert 'lock_api' not in out['legacy_locks'] and out['fresh']['lock_api']==2 and out['fresh']['list'] is None
assert out['exact']=={'ok':True,'applied':True} and (t['exact']['writes'],t['exact']['on'],t['exact']['off'])==(1,1,1)
assert out['same']['applied'] and delta('exact','same','writes')==0 and delta('exact','same','on')==1
assert out['frequency']=={'ok':True,'applied':False} and (t['frequency']['opt'],t['frequency']['pci'])==(2,0)
assert out['bad_pci']['error']==out['bad_frequency']['error']=='input' and delta('frequency','bad_frequency','writes')==0
assert out['legacy_zero']['ok'] and t['legacy_zero']['opt']==1 and delta('same','legacy_zero','on')==0
assert out['clear']['applied'] and not t['clear']['opt'] and out['list_set']=={'ok':True,'verified':False,'recorded':True,'applied':True}
wanted=[('NR',633984,229),('LTE',0,0)]
def ids(name): return [(v['rat'],v['arfcn'],v['pci']) for v in out[name]['list']]
assert ids('list')==ids('list_retained')==wanted and out['list_reject']['error']=='cell_list_write'
assert delta('list','list_reject','on')==0 and out['list_clear']=={'ok':True,'verified':False,'recorded':True,'applied':False}
assert out['list_empty']['list']==[] and out['list_again']['recorded'] and not out['record_failed']['recorded'] and out['record_failed']['ok']
assert all(out[k]['list'] is None for k in ('record_unknown','invalid','out_of_range'))
assert out['airplane']['apply_error']=='apply_airplane' and t['airplane']['airplane']==1
assert [out[k]['apply_error'] for k in ('voice_call','mipc_call','voice_unknown','voice_legacy')]==['apply_call','apply_call','apply_voice_unknown','apply_voice_unknown']
assert t['voice_call']['opt']==1 and delta('record_unknown','voice_legacy','on')==0 and out['mipc_idle']['applied']
assert not any(line.startswith('not_requested') for line in Path('voice.log').read_text().splitlines())
assert out['off']['apply_error']=='radio_off' and delta('mipc_idle','off','off')==3
assert out['unknown']['apply_error']=='radio_unknown' and out['off_ack_lost']['applied'] and not t['off_ack_lost']['airplane']
print("PASS: lock types, legacy EARFCN 0, capability pairing, whitelist journal/clear/failures, voice guard, radio readbacks")
def await_file(path):
    for _ in range(120):
        if Path(path).exists(): return
        time.sleep(.05)
    raise AssertionError(f"timed out waiting for {path}")
p=subprocess.Popen(['./test','interrupt'],stdout=subprocess.PIPE,stderr=subprocess.DEVNULL,start_new_session=True)
try:
    await_file('radio-down')
    os.killpg(p.pid,signal.SIGTERM)
    assert p.wait(3)==-signal.SIGTERM and p.stdout.read()==b'', "cancelled RPC still owns client stdout"
    Path('continue').touch()
    await_file('radio-restored')
finally:
    Path('continue').touch()
    if p.poll() is None: p.kill(); p.wait()
print("PASS: interrupting the RPC process group after radio-off does not interrupt restoration")
PY
