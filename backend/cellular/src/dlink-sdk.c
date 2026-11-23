/* Quectel SDK reads and confirmed writes that the AT console and dlink-cell do not cover.
 * Arguments arrive pre-validated from the rpcd script; every value is checked again here. */
#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <pthread.h>
#include <signal.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/file.h>
#include <sys/resource.h>
#include <sys/stat.h>
#include <time.h>
#include <unistd.h>
#include "ql_dm.h"
#include "ql_nw.h"
#include "ql_sim.h"
#include "ql_sms.h"

#define MODEM_LOCK "/var/lock/dlink-cellular.lock"
#define SCAN_DIR "/tmp/dlink-plmn-scan"
#define SCAN_SECONDS 240
#define N(x) (sizeof(x) / sizeof((x)[0]))

static void fail(const char *error, int code)
{
    printf("{\"ok\":false,\"error\":\"%s\",\"code\":%d}\n", error, code);
}

/* Modem strings are untrusted: emit only well-formed UTF-8 without control bytes, else null.
 * USSD menus are the one multi-line source, so line breaks are allowed there. */
static int utf8_clean(const char *s, size_t n, int lines)
{
    for (size_t i = 0; i < n;) {
        unsigned char c = (unsigned char)s[i];
        size_t len = c < 0x80 ? 1 : (c & 0xe0) == 0xc0 ? 2 : (c & 0xf0) == 0xe0 ? 3 : (c & 0xf8) == 0xf0 ? 4 : 0;
        int control = c < 0x20 && !(lines && (c == '\n' || c == '\r'));
        if (!len || i + len > n || control || c == 0x7f || (len == 2 && c < 0xc2))
            return 0;
        for (size_t k = 1; k < len; k++)
            if (((unsigned char)s[i + k] & 0xc0) != 0x80)
                return 0;
        i += len;
    }
    return 1;
}

static void emit(FILE *out, const char *s, size_t max, int lines)
{
    size_t n = s ? strnlen(s, max) : 0;
    while (n && (s[n - 1] == ' ' || s[n - 1] == '\n' || s[n - 1] == '\r'))
        n--;
    while (n && *s == ' ') {
        s++;
        n--;
    }
    if (!n || !utf8_clean(s, n, lines)) {
        fputs("null", out);
        return;
    }
    fputc('"', out);
    for (size_t i = 0; i < n; i++) {
        if (s[i] == '\n' || s[i] == '\r') {
            fputs(s[i] == '\n' ? "\\n" : "\\r", out);
            continue;
        }
        if (s[i] == '"' || s[i] == '\\')
            fputc('\\', out);
        fputc(s[i], out);
    }
    fputc('"', out);
}

static void text(FILE *out, const char *s, size_t max) { emit(out, s, max, 0); }

static void number(FILE *out, long long v, long long lo, long long hi)
{
    if (v >= lo && v <= hi)
        fprintf(out, "%lld", v);
    else
        fputs("null", out);
}

static int digits(const char *s, size_t lo, size_t hi)
{
    size_t n = strlen(s);
    return n >= lo && n <= hi && strspn(s, "0123456789") == n;
}

static int lock_modem(int wait_tenths)
{
    int fd = open(MODEM_LOCK, O_CREAT | O_CLOEXEC | O_NOFOLLOW | O_WRONLY, 0600);
    if (fd < 0)
        return -1;
    struct timespec pause = {.tv_nsec = 100000000};
    for (int i = 0; i <= wait_tenths; i++) {
        if (!flock(fd, LOCK_EX | LOCK_NB))
            return fd;
        if (errno != EWOULDBLOCK && errno != EINTR)
            break;
        nanosleep(&pause, NULL);
    }
    close(fd);
    return -1;
}

/* One pending vendor callback at a time; the SDK delivers it on its own client thread. */
static pthread_mutex_t mu = PTHREAD_MUTEX_INITIALIZER;
static pthread_cond_t cv = PTHREAD_COND_INITIALIZER;
static int done;

static void arm(void)
{
    pthread_mutex_lock(&mu);
    done = 0;
    pthread_mutex_unlock(&mu);
}

static void signal_done(void)
{
    pthread_mutex_lock(&mu);
    done = 1;
    pthread_cond_signal(&cv);
    pthread_mutex_unlock(&mu);
}

static int wait_done(int seconds)
{
    struct timespec until;
    clock_gettime(CLOCK_REALTIME, &until);
    until.tv_sec += seconds;
    pthread_mutex_lock(&mu);
    while (!done && pthread_cond_timedwait(&cv, &mu, &until) != ETIMEDOUT)
        ;
    int ok = done;
    pthread_mutex_unlock(&mu);
    return ok;
}

/* ---- device identity ---- */

static int airplane(void)
{
    QL_DM_AIR_PLANE_MODE_TYPE_E mode = QL_DM_AIR_PLANE_MODE_UNKNOWN;
    if (ql_dm_get_air_plane_mode(&mode))
        return -1;
    return mode == QL_DM_AIR_PLANE_MODE_ON ? 1 : mode == QL_DM_AIR_PLANE_MODE_OFF ? 0 : -1;
}

static void boolean(int v)
{
    fputs(v < 0 ? "null" : v ? "true" : "false", stdout);
}

static void identity(void)
{
    char imei[QL_DM_IMEI_MAX_LEN + 1] = "", soft[129] = "", firm[129] = "", modem[33] = "";
    int air = -1, dm = ql_dm_init(DM_IPC_MODE_DEFAULT);
    if (!dm) {
        ql_dm_device_serial_numbers_info_t serial = {0};
        if (!ql_dm_get_device_serial_numbers(QL_DM_DEVICE_SERIAL_INDEX_1, &serial) && serial.imei_valid &&
            digits(serial.imei, 14, 16))
            memcpy(imei, serial.imei, sizeof imei - 1);
        if (ql_dm_get_software_version(soft, sizeof soft - 1))
            soft[0] = 0;
        if (ql_dm_get_device_firmware_rev_id(firm, sizeof firm - 1))
            firm[0] = 0;
        if (ql_dm_get_modem_state(modem, sizeof modem - 1))
            modem[0] = 0;
        air = airplane();
        ql_dm_release();
    }
    const char *state = NULL;
    char iccid[QL_SIM_ICCID_LENGTH + 4] = "", phone[QL_SIM_PHONE_NUMBER_MAX + 1] = "";
    ql_sim_get_imsi_resp_t imsi = {0};
    int sim = ql_sim_init(SIM_IPC_MODE_DEFAULT);
    if (!sim) {
        ql_sim_card_info_t card = {0};
        if (!ql_sim_get_card_info(QL_SIM_SLOT_1, &card)) {
            int ready = card.state == QL_SIM_STATUS_READY || card.state == QL_SIM_STATUS_COMPLETE_READY;
            state = card.state == QL_SIM_STATUS_NOT_INSERT ? "absent" : ready ? "ready"
                : card.state == QL_SIM_STATUS_SIM_PIN ? "pin" : card.state == QL_SIM_STATUS_SIM_PUK ? "puk" : "other";
            if (card.state != QL_SIM_STATUS_NOT_INSERT &&
                (ql_sim_get_iccid(QL_SIM_SLOT_1, iccid, sizeof iccid - 1) ||
                 strspn(iccid, "0123456789ABCDEFabcdef") != strlen(iccid) || strlen(iccid) < 18))
                iccid[0] = 0;
            if (ready) {
                if (ql_sim_get_imsi(QL_SIM_SLOT_1, &imsi))
                    memset(&imsi, 0, sizeof imsi);
                imsi.imsi[sizeof imsi.imsi - 1] = 0;
                imsi.plmn[sizeof imsi.plmn - 1] = 0;
                if (ql_sim_get_phone_num(QL_SIM_SLOT_1, phone, sizeof phone - 1) ||
                    strspn(phone + (phone[0] == '+'), "0123456789") != strlen(phone + (phone[0] == '+')))
                    phone[0] = 0;
            }
        }
        ql_sim_release();
    }
    if (dm && sim) {
        fail("ril_init", dm);
        return;
    }
    fputs("{\"ok\":true,\"imei\":", stdout);
    text(stdout, imei, sizeof imei);
    fputs(",\"software\":", stdout);
    text(stdout, soft, sizeof soft);
    fputs(",\"firmware\":", stdout);
    text(stdout, firm, sizeof firm);
    fputs(",\"modem\":", stdout);
    text(stdout, modem, sizeof modem);
    fputs(",\"airplane\":", stdout);
    boolean(air);
    fputs(",\"sim\":", stdout);
    if (!state) {
        puts("null}");
        return;
    }
    printf("{\"state\":\"%s\",\"iccid\":", state);
    text(stdout, iccid, sizeof iccid);
    fputs(",\"imsi\":", stdout);
    text(stdout, digits(imsi.imsi, 6, 15) ? imsi.imsi : "", sizeof imsi.imsi);
    fputs(",\"plmn\":", stdout);
    text(stdout, digits(imsi.plmn, 5, 6) ? imsi.plmn : "", sizeof imsi.plmn);
    fputs(",\"number\":", stdout);
    text(stdout, phone, sizeof phone);
    puts("}}");
}

/* ---- network extras ---- */

static void operator_name(FILE *out, const ql_nw_mobile_operator_name_info_t *op)
{
    char plmn[8] = "";
    if (digits(op->mcc, 3, 3) && digits(op->mnc, 2, 3))
        snprintf(plmn, sizeof plmn, "%s%s", op->mcc, op->mnc);
    fputs("{\"long\":", out);
    text(out, op->long_eons, sizeof op->long_eons);
    fputs(",\"short\":", out);
    text(out, op->short_eons, sizeof op->short_eons);
    fputs(",\"plmn\":", out);
    text(out, plmn, sizeof plmn);
    fputc('}', out);
}

static void network(void)
{
    ql_nw_mobile_operator_name_info_t op = {0};
    ql_nw_nitz_time_info_t nitz = {0};
    ql_nw_get_nr_tdd_config_t tdd = {0};
    ql_nw_get_endc_status_req_t endc = {0};
    ql_nw_get_srv_domain_req_t domain = {.srv_domain = -1};
    ql_nw_reg_status_info_t voice = {0};
    int rop = ql_nw_get_mobile_operator_name(&op), rnitz = ql_nw_get_nitz_time_info(&nitz),
        rtdd = ql_nw_get_nr_tdd_config(&tdd), rendc = ql_nw_get_endc_status(&endc),
        rdomain = ql_nw_get_srv_domain(&domain), rvoice = ql_nw_get_voice_reg_status(&voice);
    if (rop && rnitz && rtdd && rendc && rdomain && rvoice) {
        fail("nw_read", rop);
        return;
    }
    fputs("{\"ok\":true,\"operator\":", stdout);
    if (rop)
        fputs("null", stdout);
    else
        operator_name(stdout, &op);
    fputs(",\"nitz\":", stdout);
    nitz.nitz_time[sizeof nitz.nitz_time - 1] = 0;
    text(stdout, !rnitz && strspn(nitz.nitz_time, "0123456789/,:+- ") == strlen(nitz.nitz_time) ? nitz.nitz_time : "",
         sizeof nitz.nitz_time);
    fputs(",\"tdd\":", stdout);
    if (rtdd)
        fputs("null", stdout);
    else {
        putchar('[');
        int comma = 0;
        for (size_t i = 0; i < N(tdd.tdd_pattern); i++) {
            const ql_nw_tdd_ul_dl_pattern *p = &tdd.tdd_pattern[i];
            if (p->valid != 1 || p->transmission_period > 9 || p->number_of_dl_slot > 320 ||
                p->number_of_ul_slot > 320 || p->number_of_dl_symbol > 14 || p->number_of_ul_symbol > 14)
                continue;
            printf("%s{\"period\":%u,\"dl_slots\":%u,\"ul_slots\":%u,\"dl_symbols\":%u,\"ul_symbols\":%u}",
                   comma ? "," : "", p->transmission_period, p->number_of_dl_slot, p->number_of_ul_slot,
                   p->number_of_dl_symbol, p->number_of_ul_symbol);
            comma = 1;
        }
        putchar(']');
    }
    fputs(",\"endc\":", stdout);
    if (rendc || endc.endc_available > 1 || endc.dcnr_restricted > 1)
        fputs("null", stdout);
    else
        printf("{\"available\":%s,\"restricted\":%s}", endc.endc_available ? "true" : "false",
               endc.dcnr_restricted ? "true" : "false");
    fputs(",\"srv_domain\":", stdout);
    number(stdout, rdomain ? -1 : domain.srv_domain, 0, 1);
    fputs(",\"voice\":", stdout);
    if (rvoice)
        fputs("null", stdout);
    else {
        fputs("{\"state\":", stdout);
        number(stdout, voice.reg_state, 0, 10);
        fputs(",\"rat\":", stdout);
        number(stdout, voice.radio_tech, 1, 20);
        putchar('}');
    }
    puts("}");
}

/* ---- radio policy: network mode, airplane mode, PLMN selection ---- */

static ql_nw_get_plmn_info_resp_t plmn_info;
static ql_nw_set_plmn_info_resp_t plmn_result;

static void on_plmn_info(ql_nw_get_plmn_info_resp_t *info)
{
    if (info) {
        pthread_mutex_lock(&mu);
        plmn_info = *info;
        pthread_mutex_unlock(&mu);
    }
    signal_done();
}

static void on_plmn_set(ql_nw_set_plmn_info_resp_t *result)
{
    pthread_mutex_lock(&mu);
    if (result)
        plmn_result = *result;
    else
        plmn_result.set_plmn_result = QL_NW_ASYNC_FAIL;
    pthread_mutex_unlock(&mu);
    signal_done();
}

static int nwmode(void)
{
    ql_nw_get_nwmode_info_t mode = {0};
    return ql_nw_get_nwmode(&mode) ? -1 : mode.rat_info;
}

static void radio(void)
{
    int mode = nwmode(), air = -1;
    if (!ql_dm_init(DM_IPC_MODE_DEFAULT)) {
        air = airplane();
        ql_dm_release();
    }
    memset(&plmn_info, 0xff, sizeof plmn_info);
    arm();
    int got = !ql_nw_get_plmn_info(on_plmn_info) && wait_done(4);
    fputs("{\"ok\":true,\"nwmode\":", stdout);
    number(stdout, mode, 0, 255);
    fputs(",\"airplane\":", stdout);
    boolean(air);
    fputs(",\"selection\":", stdout);
    pthread_mutex_lock(&mu);
    plmn_info.oper[sizeof plmn_info.oper - 1] = 0;
    if (!got || plmn_info.mode > 1)
        fputs("null", stdout);
    else {
        printf("{\"mode\":\"%s\",\"plmn\":", plmn_info.mode ? "manual" : "auto");
        text(stdout, digits(plmn_info.oper, 5, 6) ? plmn_info.oper : "", sizeof plmn_info.oper);
        putchar('}');
    }
    pthread_mutex_unlock(&mu);
    puts("}");
}

/* ql_nw_set_nwmode rat_info: 3 LTE, 15 NR SA, 19 LTE+NR, 21 WCDMA+LTE+NR (factory default). */
static int valid_mode(int v) { return v == 3 || v == 15 || v == 19 || v == 21; }

static void nwmode_set(const char *value, const char *expected)
{
    int v = digits(value, 1, 3) ? atoi(value) : -1, prev = digits(expected, 1, 3) ? atoi(expected) : -1;
    if (!valid_mode(v) || prev < 0 || prev > 255) {
        fail("input", 0);
        return;
    }
    if (nwmode() != prev) {
        fail("policy_changed", 0);
        return;
    }
    ql_nw_set_nwmode_info_t req = {.rat_info = (uint8_t)v};
    int rc = v == prev ? 0 : ql_nw_set_nwmode(&req);
    if (rc) {
        fail("policy_write", rc);
        return;
    }
    for (int i = 0; i < 8; i++) {
        if (nwmode() == v) {
            printf("{\"ok\":true,\"value\":%d}\n", v);
            return;
        }
        usleep(500000);
    }
    fail("readback", 0);
}

static void airplane_set(const char *enabled, const char *expected)
{
    if ((strcmp(enabled, "0") && strcmp(enabled, "1")) || (strcmp(expected, "0") && strcmp(expected, "1"))) {
        fail("input", 0);
        return;
    }
    int want = enabled[0] == '1', rc = ql_dm_init(DM_IPC_MODE_DEFAULT);
    if (rc) {
        fail("ril_init", rc);
        return;
    }
    if (airplane() != (expected[0] == '1'))
        fail("policy_changed", 0);
    else if (want != (expected[0] == '1') &&
             (rc = ql_dm_set_air_plane_mode(want ? QL_DM_AIR_PLANE_MODE_ON : QL_DM_AIR_PLANE_MODE_OFF)))
        fail("policy_write", rc);
    else {
        int now = -1;
        for (int i = 0; i < 12 && (now = airplane()) != want; i++)
            usleep(500000);
        if (now == want)
            printf("{\"ok\":true,\"enabled\":%s}\n", want ? "true" : "false");
        else
            fail("readback", 0);
    }
    ql_dm_release();
}

static void plmn_set(int argc, char **argv)
{
    int manual = argc == 5 && !strcmp(argv[2], "manual");
    if (!manual && !(argc == 3 && !strcmp(argv[2], "auto"))) {
        fail("input", 0);
        return;
    }
    ql_nw_set_plmn_info_req_t req = {.mode = manual, .format = 2};
    if (manual) {
        int act = digits(argv[4], 1, 2) ? atoi(argv[4]) : -1;
        if (!digits(argv[3], 5, 6) || (act != 7 && act != 12 && act != 13)) {
            fail("input", 0);
            return;
        }
        req.act = (uint8_t)act;
        memcpy(req.oper, argv[3], strlen(argv[3]) + 1);
    }
    memset(&plmn_result, 0, sizeof plmn_result);
    plmn_result.set_plmn_result = QL_NW_ASYNC_FAIL;
    arm();
    int rc = ql_nw_set_plmn_info(&req, on_plmn_set);
    if (rc) {
        fail("plmn_write", rc);
        return;
    }
    /* Registration can outlast the rpcd budget; the modem keeps going after we return. */
    if (!wait_done(15)) {
        puts("{\"ok\":true,\"pending\":true}");
        return;
    }
    pthread_mutex_lock(&mu);
    QL_NW_ASYNC_RESULT result = plmn_result.set_plmn_result;
    pthread_mutex_unlock(&mu);
    if (result == QL_NW_ASYNC_SUCCESS)
        puts("{\"ok\":true,\"pending\":false}");
    else
        fail("plmn_rejected", (int)result);
}

/* ---- PLMN scan: a detached worker owns the modem lock until the vendor callback finishes ---- */

static ql_nw_scan_result_list_info_t scan_result;

static void on_scan(int index, ql_nw_scan_result_list_info_t *info)
{
    (void)index;
    pthread_mutex_lock(&mu);
    if (info)
        scan_result = *info;
    else
        scan_result.nw_scan_result = QL_NW_ASYNC_FAIL;
    pthread_mutex_unlock(&mu);
    signal_done();
}

static int publish(const char *state, const char *error, int with_list)
{
    char tmp[] = SCAN_DIR "/status.XXXXXX";
    int fd = mkstemp(tmp);
    FILE *out = fd < 0 ? NULL : fdopen(fd, "w");
    if (!out) {
        if (fd >= 0)
            close(fd);
        return -1;
    }
    struct timespec now;
    clock_gettime(CLOCK_MONOTONIC, &now);
    fprintf(out, "{\"ok\":true,\"state\":\"%s\",\"at\":%lld", state, (long long)now.tv_sec);
    if (error)
        fprintf(out, ",\"error\":\"%s\"", error);
    fputs(",\"networks\":[", out);
    if (with_list) {
        int comma = 0;
        for (uint32_t i = 0; i < scan_result.entry_len && i < N(scan_result.entry); i++) {
            const ql_nw_scan_entry_info_t *e = &scan_result.entry[i];
            if (!digits(e->operator_name.mcc, 3, 3) || !digits(e->operator_name.mnc, 2, 3))
                continue;
            fputs(comma ? ",{\"name\":" : "{\"name\":", out);
            operator_name(out, &e->operator_name);
            fputs(",\"status\":", out);
            number(out, e->network_status, 0, 5);
            fputs(",\"rat\":", out);
            number(out, e->rat, 1, 20);
            fputc('}', out);
            comma = 1;
        }
    }
    fputs("]}\n", out);
    int bad = fflush(out) || fsync(fd);
    fclose(out);
    if (bad || rename(tmp, SCAN_DIR "/status.json")) {
        unlink(tmp);
        return -1;
    }
    return 0;
}

static void scan_worker(void)
{
    int fd = lock_modem(30);
    if (fd < 0) {
        publish("failed", "busy", 0);
        return;
    }
    if (ql_nw_init(NW_IPC_MODE_DEFAULT)) {
        publish("failed", "ril_init", 0);
        close(fd);
        return;
    }
    int index = 0;
    memset(&scan_result, 0, sizeof scan_result);
    arm();
    if (ql_nw_network_scan(&index, on_scan))
        publish("failed", "scan_start", 0);
    else if (!wait_done(SCAN_SECONDS))
        publish("timeout", NULL, 0);
    else {
        pthread_mutex_lock(&mu);
        QL_NW_ASYNC_RESULT result = scan_result.nw_scan_result;
        pthread_mutex_unlock(&mu);
        if (result == QL_NW_ASYNC_SUCCESS)
            publish("complete", NULL, 1);
        else
            publish(result == QL_NW_ASYNC_ABORT ? "cancelled" : "failed", "scan_rejected", 0);
    }
    ql_nw_release();
    close(fd);
}

static pid_t scan_owner(void)
{
    FILE *f = fopen(SCAN_DIR "/pid", "r");
    long pid = 0;
    if (!f)
        return 0;
    if (fscanf(f, "%ld", &pid) != 1)
        pid = 0;
    fclose(f);
    return pid > 1 && !kill((pid_t)pid, 0) ? (pid_t)pid : 0;
}

static void scan_status(void)
{
    FILE *f = fopen(SCAN_DIR "/status.json", "r");
    char buf[16384];
    size_t n = f ? fread(buf, 1, sizeof buf - 1, f) : 0;
    if (f)
        fclose(f);
    buf[n] = 0;
    if (!n || n == sizeof buf - 1 || !utf8_clean(buf, strcspn(buf, "\n"), 0)) {
        puts("{\"ok\":true,\"state\":\"idle\",\"networks\":[]}");
        return;
    }
    if (strstr(buf, "\"state\":\"running\"") && !scan_owner()) {
        /* The worker records its pid a moment after the request returns. */
        struct timespec now;
        long long at = -1;
        const char *stamp = strstr(buf, "\"at\":");
        clock_gettime(CLOCK_MONOTONIC, &now);
        if (!stamp || sscanf(stamp + 5, "%lld", &at) != 1 || now.tv_sec - at > 5) {
            puts("{\"ok\":true,\"state\":\"stop_unconfirmed\",\"networks\":[]}");
            return;
        }
    }
    fputs(buf, stdout);
}

static void scan_start(void)
{
    umask(077);
    struct stat st;
    if ((mkdir(SCAN_DIR, 0700) && errno != EEXIST) || lstat(SCAN_DIR, &st) || !S_ISDIR(st.st_mode) ||
        st.st_uid != geteuid()) {
        fail("scan_start", 0);
        return;
    }
    if (scan_owner()) {
        fail("scan_running", 0);
        return;
    }
    if (publish("running", NULL, 0)) {
        fail("scan_start", 0);
        return;
    }
    fflush(stdout);
    pid_t child = fork();
    if (child < 0) {
        publish("failed", "scan_start", 0);
        fail("scan_start", errno);
        return;
    }
    if (child) {
        puts("{\"ok\":true,\"state\":\"running\",\"networks\":[]}");
        return;
    }
    /* Detach from rpcd: it waits for stdout to close, not for this scan. */
    setsid();
    if (fork())
        _exit(0);
    int null = open("/dev/null", O_RDWR | O_CLOEXEC);
    if (null >= 0) {
        dup2(null, STDIN_FILENO);
        dup2(null, STDOUT_FILENO);
        dup2(null, STDERR_FILENO);
    }
    FILE *pid = fopen(SCAN_DIR "/pid", "w");
    if (pid) {
        fprintf(pid, "%ld\n", (long)getpid());
        fclose(pid);
    }
    scan_worker();
    unlink(SCAN_DIR "/pid");
    _exit(0);
}

/* ---- SMS service centre and USSD ---- */

/* The vendor returns the SCA as typed by AT+CSCA; keep only the dialable address. */
static int sca_normalize(const char *raw, char *out, size_t size)
{
    const char *p = raw + strcspn(raw, "+0123456789");
    size_t plus = *p == '+', n = strspn(p + plus, "0123456789");
    if (n < 3 || n > 20 || plus + n + 1 > size)
        return 0;
    memcpy(out, p, plus + n);
    out[plus + n] = 0;
    return 1;
}

static int sca_read(char *out, size_t size)
{
    char raw[QL_SMS_MAX_ADDR_LENGTH + 1] = "";
    if (ql_sms_get_service_center_addr(raw, sizeof raw - 1))
        return -1;
    raw[sizeof raw - 1] = 0;
    return sca_normalize(raw, out, size) ? 1 : 0;
}

static void smsc_get(void)
{
    char sca[24];
    int got = sca_read(sca, sizeof sca);
    if (got < 0) {
        fail("smsc_read", 0);
        return;
    }
    fputs("{\"ok\":true,\"address\":", stdout);
    text(stdout, got ? sca : "", sizeof sca);
    puts("}");
}

static int valid_sca(const char *s)
{
    return digits(s + (s[0] == '+'), 3, 20);
}

static void smsc_set(const char *address, const char *expected)
{
    if (!valid_sca(address) || (strcmp(expected, "-") && !valid_sca(expected))) {
        fail("input", 0);
        return;
    }
    char current[24];
    int got = sca_read(current, sizeof current);
    if (got < 0 || (got ? strcmp(current, expected) : strcmp(expected, "-"))) {
        fail(got < 0 ? "smsc_read" : "smsc_changed", 0);
        return;
    }
    char value[24];
    memcpy(value, address, strlen(address) + 1);
    int rc = strcmp(current, address) || !got ? ql_sms_set_service_center_addr(value, (int)strlen(value)) : 0;
    if (rc)
        fail("smsc_write", rc);
    else if (sca_read(current, sizeof current) != 1 || strcmp(current, address))
        fail("readback", 0);
    else {
        fputs("{\"ok\":true,\"address\":", stdout);
        text(stdout, current, sizeof current);
        puts("}");
    }
}

static ql_ussd_response_ind_t ussd_reply;

static void on_ussd(ql_ussd_response_ind_t *reply)
{
    pthread_mutex_lock(&mu);
    if (reply)
        ussd_reply = *reply;
    pthread_mutex_unlock(&mu);
    signal_done();
}

static void ussd(const char *code)
{
    size_t n = strlen(code);
    if (n < 2 || n > 32 || strspn(code, "0123456789*#") != n) {
        fail("input", 0);
        return;
    }
    ql_ussd_send_req_t req = {{0}};
    memcpy(req.ussd_str, code, n + 1);
    memset(&ussd_reply, 0, sizeof ussd_reply);
    arm();
    int rc = ql_ussd_response_cb(on_ussd);
    if (!rc)
        rc = ql_ussd_send(&req);
    if (rc) {
        fail("ussd_send", rc);
        return;
    }
    if (!wait_done(15)) {
        fail("ussd_timeout", 0);
        return;
    }
    pthread_mutex_lock(&mu);
    size_t len = ussd_reply.ussd_len < sizeof ussd_reply.ussd_payload ? ussd_reply.ussd_len : sizeof ussd_reply.ussd_payload;
    printf("{\"ok\":true,\"status\":%u,\"reply\":", ussd_reply.ussd_response);
    if (len && utf8_clean(ussd_reply.ussd_payload, strnlen(ussd_reply.ussd_payload, len), 1))
        emit(stdout, ussd_reply.ussd_payload, len, 1);
    else if (len) {
        /* Not text: hand the bytes over as hex so the page can decode UCS2. */
        putchar('"');
        for (size_t i = 0; i < len; i++)
            printf("%02X", (unsigned char)ussd_reply.ussd_payload[i]);
        putchar('"');
    } else
        fputs("null", stdout);
    pthread_mutex_unlock(&mu);
    puts("}");
}

int main(int argc, char **argv)
{
    struct rlimit core = {0, 0};
    setrlimit(RLIMIT_CORE, &core);
    signal(SIGPIPE, SIG_IGN);
    if (argc < 2) {
        fail("input", 0);
        return 0;
    }
    const char *a = argv[1];
    if (!strcmp(a, "plmn_scan_status") && argc == 2) {
        scan_status();
        return 0;
    }
    if (!strcmp(a, "plmn_scan_start") && argc == 2) {
        scan_start();
        return 0;
    }
    int readonly = !strcmp(a, "identity") || !strcmp(a, "network") || !strcmp(a, "radio") || !strcmp(a, "smsc_get");
    int fd = lock_modem(readonly ? 20 : 10);
    if (fd < 0) {
        fail("busy", 0);
        return 0;
    }
    if (!strcmp(a, "identity") && argc == 2)
        identity();
    else if (!strcmp(a, "airplane_set") && argc == 4)
        airplane_set(argv[2], argv[3]);
    else if (!strcmp(a, "smsc_get") && argc == 2) {
        if (ql_sms_init(SMS_IPC_MODE_DEFAULT))
            fail("ril_init", 0);
        else {
            smsc_get();
            ql_sms_release();
        }
    } else if ((!strcmp(a, "smsc_set") && argc == 4) || (!strcmp(a, "ussd") && argc == 3)) {
        int rc = ql_sms_init(SMS_IPC_MODE_DEFAULT);
        if (rc)
            fail("ril_init", rc);
        else {
            if (argc == 4)
                smsc_set(argv[2], argv[3]);
            else
                ussd(argv[2]);
            ql_sms_release();
        }
    } else if (!strcmp(a, "network") || !strcmp(a, "radio") || !strcmp(a, "nwmode_set") || !strcmp(a, "plmn_set")) {
        int rc = ql_nw_init(NW_IPC_MODE_DEFAULT);
        if (rc)
            fail("ril_init", rc);
        else {
            if (!strcmp(a, "network") && argc == 2)
                network();
            else if (!strcmp(a, "radio") && argc == 2)
                radio();
            else if (!strcmp(a, "nwmode_set") && argc == 4)
                nwmode_set(argv[2], argv[3]);
            else if (!strcmp(a, "plmn_set"))
                plmn_set(argc, argv);
            else
                fail("input", 0);
            ql_nw_release();
        }
    } else
        fail("input", 0);
    close(fd);
    return 0;
}
