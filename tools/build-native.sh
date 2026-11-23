#!/usr/bin/env bash
# Build device helpers into a new staging directory. Does not connect to a device.
set -euo pipefail
: "${CC:?set CC to the absolute path of aarch64-openwrt-linux-musl-gcc}"
: "${VENDOR_INC:?target include dir with mipc and alsa}"
: "${RIL_INC:?directory containing ql_nw.h and ql_sms.h}"
: "${RIL_LIB:?directory containing libqlril.so, libmipc_msg.so, libasound.so.2 and vendor libc}"
: "${SPEECH_OS:?audio_big_sw/os directory from the matching SDK}"
: "${SPEECH_ROOT:?matching speech runtime sysroot containing usr/lib and lib}"
B=$(cd "$(dirname "$0")/.." && pwd)
out=${1:?usage: build-native.sh NEW_OUTPUT_DIR}
mkdir "$out"; out=$(cd "$out" && pwd)
C="$B/backend/cellular/src"; A="$B/backend/audio-common"; N="$B/backend/webvoice/native"
s="$out/cellular/usr/libexec"; v="$out/webvoice/usr/libexec/dlink-webvoice"; mkdir -p "$s" "$v"
tmp=$(mktemp -d); trap 'rm -rf "$tmp"' EXIT
# Only use ALSA headers from the vendor sysroot; do not shadow the compiler's libc headers.
ln -s "$VENDOR_INC/alsa" "$tmp/alsa"
# This speech API needs the enum declarations, not the Android framework C++ wrappers.
grep -q '^#include <system/audio.h>' "$SPEECH_OS/include/speech_drv.h"
sed 's@^#include <system/audio.h>@#include <stdint.h>\
#include <system/audio-base.h>@' "$SPEECH_OS/include/speech_drv.h" > "$tmp/speech_drv.h"
vendor=(-L"$RIL_LIB" -Wl,-rpath-link,"$RIL_LIB" -Wl,--disable-new-dtags,-rpath,/usr/lib/t830-quectel)
loader=(-Wl,--dynamic-linker=/usr/lib/t830-quectel/libc.so -Wl,-z,now)
"$CC" -O2 -Wall -Wextra -Werror -Wl,--as-needed -I"$RIL_INC" "${vendor[@]}" "$C/dlink-cell.c" -lqlril -o "$s/dlink-cellular"
"$CC" -O2 -Wall -Wextra -Werror -I"$RIL_INC" ${JSON_C_CFLAGS:-} "${vendor[@]}" "$C/dlink-controls.c" ${JSON_C_LIBS:--ljson-c} -lqlril -o "$s/dlink-controls"
"$CC" -O2 -Wall -Wextra -Werror -Wl,--as-needed -pthread -I"$RIL_INC" "${vendor[@]}" "$C/dlink-sdk.c" -lqlril -o "$s/dlink-sdk"
# AT_INC is the SDK libql_at/inc directory (quectel_atcid_sender.h).
"$CC" -O2 -Wall -Wextra -Werror -I"${AT_INC:-$VENDOR_INC}" ${JSON_C_CFLAGS:-} "${vendor[@]}" "${loader[@]}" "$C/dlink-at-console.c" ${JSON_C_LIBS:--ljson-c} -lql_at -o "$s/dlink-at-console"
"$CC" -O2 -Wall -Wextra -Werror -Wl,--as-needed -I"$RIL_INC" "${vendor[@]}" "$C/dlink-sms-delete.c" -lqlril -o "$s/dlink-sms-delete"
"$CC" -O2 -Wall -Wextra -Werror -Wl,--as-needed -pthread -I"$RIL_INC" "${vendor[@]}" "$C/dlink-cell-diag.c" -lqlril -o "$s/dlink-cell-diag"
"$CC" -O2 -Wall -Wextra -Werror -Wl,--as-needed -pthread -I"$RIL_INC" "${vendor[@]}" "$C/dlink-cell-scan.c" -lqlril -o "$s/dlink-cell-scan"
"$CC" -D_LINUX -std=gnu11 -Os -Wall -Werror -I"$VENDOR_INC/mipc/msg" -I"$VENDOR_INC/mipc/common" "${vendor[@]}" "${loader[@]}" "$C/dtmf.c" -l:libmipc_msg.so -o "$s/dlink-dtmf"
"$CC" -O2 -Wall -Werror -Wno-misleading-indentation -I"$tmp" -I"$SPEECH_OS" -L"$SPEECH_ROOT/usr/lib" -Wl,-rpath-link,"$SPEECH_ROOT/usr/lib:$SPEECH_ROOT/lib" "$C/marker.c" -l:libspeech_drv.so -Wl,--no-as-needed -l:libaudioparamparser.so -lm -o "$s/dlink-bgs-marker"
for pair in "$C/stereo_rx.c:$s/t830-rx-channels" "$N/rx.c:$v/rx";do
 "$CC" -std=gnu11 -Os -I"$A" -I"$tmp" "${vendor[@]}" "${loader[@]}" "${pair%:*}" "$A/tone.c" -l:libasound.so.2 -lm -o "${pair#*:}"
done
"$CC" -std=gnu11 -Os -I"$tmp" -I"$SPEECH_OS" "$N/tx.c" -o "$v/tx"
cp -Rp "$B/backend/cellular/root/." "$out/cellular/"
mkdir -p "$out/webvoice/etc/init.d" "$out/webvoice/usr/libexec/rpcd" "$out/webvoice/usr/sbin"
install -m755 "$N/service" "$out/webvoice/etc/init.d/dlink-webvoice"
ln -s ../../sbin/dlink-webvoice "$out/webvoice/usr/libexec/rpcd/dlink-webvoice"
chmod 700 "$s/dlink-dtmf" "$v/rx" "$v/tx"
printf 'Staged cellular + native audio. Build the Go gateway into %s/webvoice/usr/sbin/dlink-webvoice as described in README.md.\n' "$out"
