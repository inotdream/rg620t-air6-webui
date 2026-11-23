#!/bin/sh
# Linux host with OpenWrt's host jshn (staging_dir/host): fake UCI store and modem, no router.
# jshn.sh needs ash or bash (export -n); set TEST_SHELL=bash where /bin/sh is dash.
set -eu
: "${JSHN_DIR:?directory containing jshn.sh; the jshn binary must be on PATH}"
run_sh="${TEST_SHELL:-sh}"
src=$(cd "$(dirname "$0")/.." && pwd)
root="$src/backend/cellular/root"
d=$(mktemp -d); trap 'rm -rf "$d"' EXIT
mkdir -p "$d/bin"
export UCI_STORE="$d/uci" MODEM="$d/modem" PATH="$d/bin:$PATH"
eq() { [ "$1" = "$2" ] || { printf 'expected %s\n     got %s\n' "$2" "$1" >&2; exit 1; }; }
expect() { case "$1" in *"$2"*) ;; *) printf 'missing %s in %s\n' "$2" "$1" >&2; exit 1;; esac; }

cat > "$d/bin/uci" <<'UCI'
#!/bin/sh
stage=
while [ $# -gt 0 ]; do case "$1" in -q) shift;; -t) stage="$2/delta"; shift 2;; *) break;; esac; done
cmd=$1; shift
case "$cmd" in
	get) awk -v k="$1=" 'index($0, k) == 1 {print substr($0, length(k) + 1); f = 1} END {exit !f}' "$UCI_STORE";;
	set) printf 'set %s\n' "$1" >> "$stage";;
	delete) grep -q -- "^${1}=" "$UCI_STORE" || exit 1; printf 'del %s\n' "$1" >> "$stage";;
	commit) [ -z "${UCI_FAIL:-}" ] || exit 1
	        while IFS= read -r op; do
	          arg=${op#* }; key=${arg%%=*}
	          grep -v -- "^$key=" "$UCI_STORE" > "$UCI_STORE.new" || :
	          [ "${op%% *}" = del ] || printf '%s\n' "$arg" >> "$UCI_STORE.new"
	          mv "$UCI_STORE.new" "$UCI_STORE"
	        done < "$stage";;
	changes) [ ! -s "$UCI_STORE.pending" ] || cat "$UCI_STORE.pending";;
	*) exit 1;;
esac
UCI
cat > "$d/mipc" <<'MIPC'
#!/bin/sh
[ "$1" = --at_cmd ] || exit 1
printf '%s\n' "$2" >> "$MODEM/log"
if [ -n "${SS_ERROR:-}" ]; then printf 'AT response:\r\n+CME ERROR: %s\r\n' "$SS_ERROR"; exit 0; fi
case "$2" in
	AT+CCFC=?,2) r=${2#AT+CCFC=}; r=${r%%,*}
	             if [ -f "$MODEM/cf$r" ]; then cat "$MODEM/cf$r"; else printf '+CCFC: 0,255\r\n'; fi
	             printf '\r\nOK\r\n';;
	AT+CCFC=?,0) r=${2#AT+CCFC=}; rm -f "$MODEM/cf${r%%,*}"; printf 'OK\r\n';;
	AT+CCFC=?,3,*) r=${2#AT+CCFC=}; rest=${r#?,3,}; num=${rest%%,*}; time=${rest##*,,,}
	               [ "$time" != "$rest" ] || time=
	               printf '+CCFC: 1,1,%s,145,,,%s\r\n+CCFC: 0,4\r\n' "$num" "$time" > "$MODEM/cf${r%%,*}"; printf 'OK\r\n';;
	'AT+CCWA=0,2') printf '+CCWA: %s,1\r\nOK\r\n' "$(cat "$MODEM/cw" 2>/dev/null || echo 0)";;
	AT+CCWA=0,?,1) v=${2#AT+CCWA=0,}; echo "${v%%,*}" > "$MODEM/cw"; printf 'OK\r\n';;
	*) printf 'ERROR\r\n';;
esac
MIPC
chmod 755 "$d/bin/uci" "$d/mipc"
mkdir -p "$MODEM"
sed -e "1s|.*|#!/usr/bin/env $run_sh|" -e "s|/usr/bin/mipc_wan_cli|$d/mipc|" -e "s|/var/lock/|$d/|g" \
    -e "s|/usr/share/libubox/jshn.sh|$JSHN_DIR/jshn.sh|" "$root/usr/libexec/dlink-cellular-services" > "$d/services"
call() { printf '%s' "$2" | "$run_sh" "$d/services" "$1"; }

printf '%s\n' network.wan=interface network.wan.proto=ql_datacall network.wan.callid=1 network.wan.iptype=3 > "$UCI_STORE"
r="$(call apn_get '{}')"
expect "$r" '"apn": "", "username": "", "password_set": false, "auth": 0, "iptype": 3'
rev="$(printf '%s' "$r" | sed -n 's/.*"revision": "\([0-9a-f]*\)".*/\1/p')"
[ ${#rev} -eq 16 ]
expect "$(call apn_set "{\"confirm\":false,\"apn\":\"x\",\"username\":\"\",\"auth\":0,\"iptype\":3,\"revision\":\"$rev\"}")" '"error":"confirm"'
expect "$(call apn_set "{\"confirm\":true,\"apn\":\"bad apn\",\"username\":\"\",\"auth\":0,\"iptype\":3,\"revision\":\"$rev\"}")" '"error":"input"'
expect "$(call apn_set "{\"confirm\":true,\"apn\":\"3gnet\",\"username\":\"u\",\"password\":\"p'x\",\"auth\":2,\"iptype\":3,\"revision\":\"$rev\"}")" '"error":"input"'
expect "$(call apn_set "{\"confirm\":true,\"apn\":\"3gnet\",\"username\":\"\",\"auth\":4,\"iptype\":3,\"revision\":\"$rev\"}")" '"error":"input"'
expect "$(call apn_set "{\"confirm\":true,\"apn\":\"3gnet\",\"username\":\"\",\"auth\":0,\"iptype\":3,\"revision\":\"0000000000000000\"}")" '"error":"apn_changed"'
echo 'network.wan.mtu=1400' > "$UCI_STORE.pending"
expect "$(call apn_set "{\"confirm\":true,\"apn\":\"3gnet\",\"username\":\"\",\"auth\":0,\"iptype\":3,\"revision\":\"$rev\"}")" '"error":"network_pending"'
rm "$UCI_STORE.pending"
r="$(call apn_set "{\"confirm\":true,\"apn\":\"3gnet\",\"username\":\"user@cu\",\"password\":\"p&ss:w=1\",\"auth\":2,\"iptype\":1,\"revision\":\"$rev\"}")"
expect "$r" '"ok":true,"applied":false'
eq "$(grep -c 'network.wan.password=p&ss:w=1' "$UCI_STORE")" 1
r="$(call apn_get '{}')"
expect "$r" '"apn": "3gnet", "username": "user@cu", "password_set": true, "auth": 2, "iptype": 1'
case "$r" in *'p&ss'*) echo 'password leaked by apn_get' >&2; exit 1;; esac
rev="$(printf '%s' "$r" | sed -n 's/.*"revision": "\([0-9a-f]*\)".*/\1/p')"
expect "$(call apn_set "{\"confirm\":true,\"apn\":\"\",\"username\":\"\",\"auth\":0,\"iptype\":3,\"revision\":\"$rev\"}")" '"ok":true'
eq "$(grep -c '^network.wan.apn=' "$UCI_STORE" || true)" 0
eq "$(grep -c 'network.wan.password=p&ss:w=1' "$UCI_STORE")" 1
echo 'PASS: APN read without secrets, confirmation, validation, stale and pending guards, keep and clear'

expect "$(call cf_query '{"reason":4}')" '"error":"input"'
expect "$(call cf_query '{"reason":0}')" '"ok":true,"reason":0,"enabled":false,"number":null,"time":null'
expect "$(call cf_set '{"confirm":true,"reason":2,"enabled":true,"number":"138;ATD","time":20}')" '"error":"input"'
expect "$(call cf_set '{"confirm":true,"reason":2,"enabled":true,"number":"+8613800000000","time":7}')" '"error":"input"'
expect "$(call cf_set '{"confirm":true,"reason":2,"enabled":true,"number":"+8613800000000","time":15}')" \
    '"ok":true,"reason":2,"enabled":true,"number":"+8613800000000","time":15'
grep -qx 'AT+CCFC=2,3,"+8613800000000",145,,,15' "$MODEM/log"
expect "$(call cf_set '{"confirm":true,"reason":0,"enabled":true,"number":"13800000000"}')" '"number":"13800000000","time":null'
grep -qx 'AT+CCFC=0,3,"13800000000",129' "$MODEM/log"
expect "$(call cf_set '{"confirm":true,"reason":2,"enabled":false}')" '"enabled":false'
expect "$(call cw_query '{}')" '"enabled":false'
expect "$(call cw_set '{"confirm":true,"enabled":true}')" '"enabled":true'
expect "$(SS_ERROR=30 call cw_query '{}')" '"error":"ss_unavailable"'
expect "$(SS_ERROR=30 call cf_query '{"reason":0}')" '"error":"ss_unavailable"'
expect "$(SS_ERROR=21 call cw_query '{}')" '"error":"ss_rejected"'
echo 'PASS: call forwarding and waiting with number validation, type of address and readback'

# rpcd dispatch: type checks and argv handed to the SDK helper.
cat > "$d/sdk" <<'SDK'
#!/bin/sh
printf '%s\n' "$*" >> "$MODEM/sdk"
printf '{"ok":true}\n'
SDK
cat > "$d/voice" <<'VOICE'
#!/bin/sh
cat "$MODEM/calls" 2>/dev/null || printf '{"ok":true,"calls":[]}\n'
VOICE
cat > "$d/bin/jsonfilter" <<'JF'
#!/usr/bin/env python3
import json, re, sys
data = json.load(sys.stdin)
for part in re.findall(r'\.(\w+)|\[(\d+)\]', sys.argv[2][1:]):
    try: data = data[part[0]] if part[0] else data[int(part[1])]
    except (KeyError, IndexError, TypeError): sys.exit(1)
print(str(data).lower() if isinstance(data, bool) else data)
JF
chmod 755 "$d/sdk" "$d/voice" "$d/bin/jsonfilter"
printf 'dlink,dwr-be7200g\n' > "$d/board"
printf 'root:fixture-only:0:0:0:0:::\n' > "$d/shadow"
cat > "$d/cell" <<'CELL'
#!/bin/sh
if [ "$1" = locks ]; then
	printf '%s\n' "${DLINK_LOCK_RPC_V2:-0}" > "$MODEM/lock-cap"
else
	printf '%s\n' "$*" >> "$MODEM/cell"
	[ -z "${DLINK_LOCK_RPC_V2-}" ] || exit 1
fi
printf '{"ok":true}\n'
CELL
chmod 755 "$d/cell"
sed -e "s|/tmp/sysinfo/board_name|$d/board|g" -e "s|/etc/shadow|$d/shadow|g" \
    -e "s|/usr/libexec/dlink-sdk|$d/sdk|g" -e "s|/usr/libexec/dlink-cellular-services|$d/services|g" \
    -e "s|/usr/libexec/dlink-cellular-voice|$d/voice|g" -e "s|/usr/share/libubox/jshn.sh|$JSHN_DIR/jshn.sh|g" \
    -e "s|run_helper /usr/libexec/dlink-cellular \"\\\$@\"|run_helper $d/cell \"\$@\"|" \
    "$root/usr/libexec/rpcd/dlink-cellular" > "$d/rpc"
chmod 755 "$d/services"
rpc() { printf '%s' "$2" | "$run_sh" "$d/rpc" call "$1"; }
expect "$(rpc access '{}')" '"sdk":true,"services":true'
rpc sdk_identity '{}' >/dev/null
rpc plmn_scan_status '{}' >/dev/null
expect "$(rpc airplane_set '{"enabled":true,"expected":false}')" '"error":"confirm"'
expect "$(rpc airplane_set '{"enabled":1,"expected":false,"confirm":true}')" '"error":"input"'
rpc airplane_set '{"enabled":true,"expected":false,"confirm":true}' >/dev/null
expect "$(rpc nwmode_set '{"value":"3","expected":19,"confirm":true}')" '"error":"input"'
rpc nwmode_set '{"value":3,"expected":19,"confirm":true}' >/dev/null
expect "$(rpc plmn_set '{"mode":"manual","plmn":"46001;x","act":12,"confirm":true}')" '"error":"input"'
rpc plmn_set '{"mode":"manual","plmn":"46001","act":12,"confirm":true}' >/dev/null
rpc plmn_set '{"mode":"auto","confirm":true}' >/dev/null
printf '{"ok":true,"calls":[{"id":1}]}\n' > "$MODEM/calls"
expect "$(rpc plmn_scan_start '{"confirm":true}')" '"error":"scan_call"'
rm "$MODEM/calls"
rpc plmn_scan_start '{"confirm":true}' >/dev/null
expect "$(rpc smsc_set '{"address":"+86 138","expected":"","confirm":true}')" '"error":"input"'
rpc smsc_set '{"address":"+8613800100500","expected":"","confirm":true}' >/dev/null
expect "$(rpc ussd_send '{"code":"*100#$(reboot)","confirm":true}')" '"error":"input"'
rpc ussd_send '{"code":"*100#","confirm":true}' >/dev/null
eq "$(cat "$MODEM/sdk")" "$(printf '%s\n' identity plmn_scan_status 'airplane_set 1 0' 'nwmode_set 3 19' \
    'plmn_set manual 46001 12' 'plmn_set auto' plmn_scan_start 'smsc_set +8613800100500 -' 'ussd *100#')"
expect "$(rpc cw_query '{}')" '"enabled":true'
expect "$(rpc locks '{}')" '"ok":true'
eq "$(cat "$MODEM/lock-cap")" 1
expect "$(rpc cell_set '{"rat":"NR","arfcn":"633984","pci":"229","apply":"yes","confirm":true}')" '"error":"input"'
expect "$(rpc cell_set '{"rat":"NR","arfcn":"633984","pci":"any","confirm":true}')" '"error":"input"'
expect "$(rpc cell_set '{"rat":"NR","arfcn":"633984","pci":"1","kind":"band","confirm":true}')" '"error":"input"'
rpc cell_set '{"rat":"NR","arfcn":"633984","pci":"229","confirm":true}' >/dev/null
rpc cell_set '{"rat":"NR","arfcn":"633984","pci":"229","apply":true,"confirm":true}' >/dev/null
rpc cell_set '{"rat":"NR","arfcn":"633984","kind":"arfcn","apply":false,"confirm":true}' >/dev/null
rpc cell_clear '{"apply":true,"confirm":true}' >/dev/null
rpc cell_list_set '{"cells":"NR:633984:229,NR:176190:20","apply":true,"confirm":true}' >/dev/null
rpc cell_list_clear '{"confirm":true}' >/dev/null
rpc band_set '{"rat":"LTE","bands":"3","apply":"ignored-by-legacy","confirm":true}' >/dev/null
eq "$(cat "$MODEM/cell")" "$(printf '%s\n' 'cell_set NR 633984 229' 'cell_set NR 633984 229 apply' 'cell_set NR 633984 any' \
    'cell_set clear apply' 'cell_list NR:633984:229,NR:176190:20 apply' 'cell_list clear' 'band_set LTE 3')"
printf 'root:!:0:0:0:0:::\n' > "$d/shadow"
expect "$(rpc sdk_radio '{}')" '"error":"password_required"'
expect "$(rpc apn_get '{}')" '"error":"password_required"'
echo 'PASS: rpcd confirmation and type checks, exact helper argv, call guard, cell lock apply/kind, password-protected endpoints'
