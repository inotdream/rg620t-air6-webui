#!/bin/sh
# Run on a Linux or macOS host with the matching SDK headers; no modem, SIM or network.
set -eu
: "${RIL_INC:?directory containing ql_dm.h, ql_nw.h, ql_sim.h and ql_sms.h}"
src=$(cd "$(dirname "$0")/.." && pwd)
d=$(mktemp -d); trap 'rm -rf "$d"' EXIT
export SDK_TEST="$d"
sed -e "s|/var/lock/dlink-cellular.lock|$d/lock|" -e "s|/tmp/dlink-plmn-scan|$d/scan|" \
    "$src/backend/cellular/src/dlink-sdk.c" > "$d/sdk.c"
cc -std=gnu11 -Wall -Wextra -Werror -pthread -I"$RIL_INC" "$d/sdk.c" "$src/tests/sdk-fake.c" -o "$d/sdk"
cd "$d"
json() { python3 -c 'import json,sys; json.loads(sys.stdin.read())' || { echo "invalid JSON from $1" >&2; exit 1; }; }
call() { out="$(./sdk "$@")"; printf '%s' "$out" | json "$*"; printf '%s' "$out"; }
expect() { case "$1" in *"$2"*) ;; *) echo "missing $2 in $1" >&2; exit 1;; esac; }
reject() { case "$1" in *"$2"*) echo "unexpected $2 in $1" >&2; exit 1;; esac; }

r="$(call identity)"
expect "$r" '"imei":"861234567890123"'
expect "$r" '"software":"RG620TEUACR01A03M8G"'
expect "$r" '"firmware":null'
expect "$r" '"airplane":false'
expect "$r" '"iccid":"89860121801234567890","imsi":"460011234567890","plmn":"46001","number":"+8613200000000"'
r="$(CARD=pin call identity)"
expect "$r" '"state":"pin","iccid":"89860121801234567890","imsi":null'
expect "$(CARD=absent call identity)" '"sim":{"state":"absent","iccid":null'
echo 'PASS: identity, SIM gating by card state, control bytes rejected'

r="$(OPERATOR='CHN "UNI\COM"' call network)"
expect "$r" '"long":"CHN \"UNI\\COM\"","short":"UNICOM","plmn":"46001"'
expect "$r" '"nitz":"26/11/23,03:48:22 +480"'
expect "$r" '"tdd":[{"period":8,"dl_slots":7,"ul_slots":2,"dl_symbols":6,"ul_symbols":4}]'
expect "$r" '"endc":{"available":true,"restricted":false}'
expect "$r" '"srv_domain":null'
expect "$r" '"voice":{"state":2,"rat":18}'
echo 'PASS: network extras, escaping, invalid TDD slot dropped, failed getter is null'

expect "$(call radio)" '"nwmode":21,"airplane":false,"selection":{"mode":"auto","plmn":null}'
expect "$(call nwmode_set 7 21)" '"error":"input"'
expect "$(call nwmode_set 3 15)" '"error":"policy_changed"'
expect "$(call nwmode_set 19 21)" '"ok":true,"value":19'
expect "$(call nwmode_set 3 19)" '"ok":true,"value":3'
expect "$(call airplane_set 1 1)" '"error":"policy_changed"'
expect "$(call airplane_set 1 0)" '"enabled":true'
expect "$(call radio)" '"nwmode":3,"airplane":true'
echo 1 > plmn_mode
expect "$(call radio)" '"selection":{"mode":"manual","plmn":"46001"}'
echo 'PASS: network mode and airplane mode with stale-state guard and readback'

expect "$(call plmn_set manual 4600 7)" '"error":"input"'
expect "$(call plmn_set manual 46001 9)" '"error":"input"'
[ ! -e plmn_set ]
expect "$(call plmn_set manual 46001 12)" '"ok":true,"pending":false'
[ "$(cat plmn_set)" = '1,2,12,46001' ]
expect "$(PLMN=reject call plmn_set auto)" '"error":"plmn_rejected"'
[ "$(cat plmn_set)" = '0,2,0,' ]
echo 'PASS: manual and automatic selection, rejected registration reported'

expect "$(call smsc_get)" '"address":"+8613010130500"'
expect "$(call smsc_set 12x -)" '"error":"input"'
expect "$(call smsc_set +8613800100500 +8613000000000)" '"error":"smsc_changed"'
expect "$(call smsc_set +8613800100500 +8613010130500)" '"address":"+8613800100500"'
expect "$(call smsc_get)" '"address":"+8613800100500"'
echo 'PASS: SMS centre normalisation, stale guard and readback'

expect "$(call ussd '*100#;')" '"error":"input"'
r="$(call ussd '*100#')"
expect "$r" '"status":0,"reply":"余额 \"29.9\" 元\n1. 流量"'
[ "$(cat ussd)" = '*100#' ]
expect "$(USSD=ucs2 call ussd '*100#')" '"reply":"4F59989D"'
echo 'PASS: USSD text with line breaks, binary reply as hex'

expect "$(call plmn_scan_status)" '"state":"idle"'
expect "$(call plmn_scan_start)" '"state":"running"'
expect "$(call plmn_scan_start)" '"error":"scan_running"'
for i in 1 2 3 4 5 6 7 8 9 10; do
    r="$(call plmn_scan_status)"
    case "$r" in *'"state":"complete"'*) break;; esac
    sleep 0.5
done
expect "$r" '"state":"complete"'
expect "$r" '{"name":{"long":"CHN-UNICOM","short":null,"plmn":"46001"},"status":1,"rat":18}'
expect "$r" '{"name":{"long":"中国移动","short":null,"plmn":"46000"},"status":5,"rat":4}'
reject "$r" '4x0'
echo 'PASS: detached PLMN scan, single owner, malformed entry dropped'

python3 - "$d/lock" <<'PY' &
import fcntl, sys, time
f = open(sys.argv[1], "w"); fcntl.flock(f, fcntl.LOCK_EX); time.sleep(4)
PY
sleep 0.5
expect "$(call identity)" '"error":"busy"'
wait
echo 'PASS: modem lock respected'
