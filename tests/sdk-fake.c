/* Test double for the vendor SDK used by dlink-sdk.c. State lives in files under SDK_TEST
 * because every helper call is a new process; callbacks run on a thread like the real client. */
#include <pthread.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
#include "ql_dm.h"
#include "ql_nw.h"
#include "ql_sim.h"
#include "ql_sms.h"

static const char *env(const char *key, const char *fallback)
{
    const char *v = getenv(key);
    return v ? v : fallback;
}

static void path(char *out, size_t size, const char *name)
{
    snprintf(out, size, "%s/%s", env("SDK_TEST", "."), name);
}

static int load(const char *name, int fallback)
{
    char p[512];
    path(p, sizeof p, name);
    FILE *f = fopen(p, "r");
    int v = fallback;
    if (f) {
        if (fscanf(f, "%d", &v) != 1)
            v = fallback;
        fclose(f);
    }
    return v;
}

static void store(const char *name, const char *value)
{
    char p[512];
    path(p, sizeof p, name);
    FILE *f = fopen(p, "w");
    if (f) {
        fputs(value, f);
        fclose(f);
    }
    path(p, sizeof p, "calls");
    f = fopen(p, "a");
    if (f) {
        fprintf(f, "%s=%s\n", name, value);
        fclose(f);
    }
}

int ql_dm_init(DM_IPC_MODE m) { (void)m; return 0; }
int ql_dm_release() { return 0; }
int ql_dm_get_device_serial_numbers(QL_DM_DEVICE_SERIAL_INDEX_E i, ql_dm_device_serial_numbers_info_t *p)
{
    if (i != QL_DM_DEVICE_SERIAL_INDEX_1)
        abort();
    p->imei_valid = 1;
    strcpy(p->imei, "861234567890123");
    return 0;
}
int ql_dm_get_software_version(char *s, int n) { snprintf(s, (size_t)n + 1, "RG620TEUACR01A03M8G"); return 0; }
int ql_dm_get_device_firmware_rev_id(char *s, int n) { snprintf(s, (size_t)n + 1, "%s", "bad\001value"); return 0; }
int ql_dm_get_modem_state(char *s, int n) { snprintf(s, (size_t)n + 1, "ONLINE"); return 0; }
int ql_dm_get_air_plane_mode(QL_DM_AIR_PLANE_MODE_TYPE_E *p)
{
    *p = load("airplane", 0) ? QL_DM_AIR_PLANE_MODE_ON : QL_DM_AIR_PLANE_MODE_OFF;
    return 0;
}
int ql_dm_set_air_plane_mode(QL_DM_AIR_PLANE_MODE_TYPE_E m)
{
    store("airplane", m == QL_DM_AIR_PLANE_MODE_ON ? "1" : "0");
    return 0;
}

int ql_sim_init(SIM_IPC_MODE m) { (void)m; return 0; }
int ql_sim_release() { return 0; }
int ql_sim_get_card_info(QL_SIM_SLOT_E s, ql_sim_card_info_t *c)
{
    (void)s;
    const char *v = env("CARD", "ready");
    c->state = !strcmp(v, "absent") ? QL_SIM_STATUS_NOT_INSERT : !strcmp(v, "pin") ? QL_SIM_STATUS_SIM_PIN : QL_SIM_STATUS_READY;
    return 0;
}
int ql_sim_get_iccid(QL_SIM_SLOT_E s, char *v, int n) { (void)s; snprintf(v, (size_t)n + 1, "89860121801234567890"); return 0; }
int ql_sim_get_imsi(QL_SIM_SLOT_E s, ql_sim_get_imsi_resp_t *r)
{
    (void)s;
    strcpy(r->imsi, "460011234567890");
    strcpy(r->plmn, "46001");
    r->mnc_len = 2;
    return 0;
}
int ql_sim_get_phone_num(QL_SIM_SLOT_E s, char *v, int n) { (void)s; snprintf(v, (size_t)n + 1, "+8613200000000"); return 0; }

int ql_nw_init(NW_IPC_MODE m) { (void)m; return 0; }
int ql_nw_release() { return 0; }
int ql_nw_get_mobile_operator_name(ql_nw_mobile_operator_name_info_t *p)
{
    strcpy(p->long_eons, env("OPERATOR", "CHN-UNICOM"));
    strcpy(p->short_eons, "UNICOM");
    strcpy(p->mcc, "460");
    strcpy(p->mnc, "01");
    return 0;
}
int ql_nw_get_nitz_time_info(ql_nw_nitz_time_info_t *p) { strcpy(p->nitz_time, "26/11/23,03:48:22 +480"); return 0; }
int ql_nw_get_nr_tdd_config(ql_nw_get_nr_tdd_config_t *p)
{
    p->tdd_pattern[0] = (ql_nw_tdd_ul_dl_pattern){1, 8, 7, 2, 6, 4};
    p->tdd_pattern[1] = (ql_nw_tdd_ul_dl_pattern){0, 0, 0, 0, 0, 0};
    return 0;
}
int ql_nw_get_endc_status(ql_nw_get_endc_status_req_t *p) { p->endc_available = 1; p->dcnr_restricted = 0; return 0; }
int ql_nw_get_srv_domain(ql_nw_get_srv_domain_req_t *p) { (void)p; return 5; }
int ql_nw_get_voice_reg_status(ql_nw_reg_status_info_t *p)
{
    p->reg_state = QL_NW_SERVICE_FULL;
    p->radio_tech = QL_NW_RADIO_TECH_NR5G;
    return 0;
}
int ql_nw_get_nwmode(ql_nw_get_nwmode_info_t *p) { p->rat_info = (uint8_t)load("nwmode", 21); return 0; }
int ql_nw_set_nwmode(ql_nw_set_nwmode_info_t *p)
{
    char v[8];
    snprintf(v, sizeof v, "%d", p->rat_info);
    store("nwmode", v);
    return 0;
}

static ql_nw_get_plmn_info_async_cb get_cb;
static ql_nw_set_plmn_info_async_cb set_cb;
static ql_nw_network_scan_async_cb scan_cb;
static ql_nw_set_plmn_info_req_t set_req;

static void *get_later(void *arg)
{
    (void)arg;
    usleep(100000);
    ql_nw_get_plmn_info_resp_t r = {.mode = (uint8_t)load("plmn_mode", 0), .format = 2};
    if (r.mode)
        strcpy(r.oper, "46001");
    get_cb(&r);
    return NULL;
}
int ql_nw_get_plmn_info(ql_nw_get_plmn_info_async_cb cb)
{
    pthread_t t;
    get_cb = cb;
    return pthread_create(&t, NULL, get_later, NULL);
}
static void *set_later(void *arg)
{
    (void)arg;
    usleep(200000);
    ql_nw_set_plmn_info_resp_t r = {.set_plmn_result = !strcmp(env("PLMN", ""), "reject") ? QL_NW_ASYNC_FAIL : QL_NW_ASYNC_SUCCESS,
                                    .mode = set_req.mode};
    set_cb(&r);
    return NULL;
}
int ql_nw_set_plmn_info(ql_nw_set_plmn_info_req_t *req, ql_nw_set_plmn_info_async_cb cb)
{
    char v[64];
    snprintf(v, sizeof v, "%u,%u,%u,%s", req->mode, req->format, req->act, req->oper);
    store("plmn_set", v);
    set_req = *req;
    set_cb = cb;
    if (!strcmp(env("PLMN", ""), "silent"))
        return 0;
    pthread_t t;
    return pthread_create(&t, NULL, set_later, NULL);
}
static void *scan_later(void *arg)
{
    (void)arg;
    usleep(700000);
    ql_nw_scan_result_list_info_t r = {.nw_scan_result = QL_NW_ASYNC_SUCCESS, .entry_len = 3};
    strcpy(r.entry[0].operator_name.long_eons, "CHN-UNICOM");
    strcpy(r.entry[0].operator_name.mcc, "460");
    strcpy(r.entry[0].operator_name.mnc, "01");
    r.entry[0].network_status = QL_NW_NETWORK_STATUS_CURRENT_SERVING;
    r.entry[0].rat = QL_NW_RADIO_TECH_NR5G;
    strcpy(r.entry[1].operator_name.long_eons, "中国移动");
    strcpy(r.entry[1].operator_name.mcc, "460");
    strcpy(r.entry[1].operator_name.mnc, "00");
    r.entry[1].network_status = QL_NW_NETWORK_STATUS_FORBIDDEN;
    r.entry[1].rat = QL_NW_RADIO_TECH_LTE;
    strcpy(r.entry[2].operator_name.mcc, "4x0");
    scan_cb(1, &r);
    return NULL;
}
int ql_nw_network_scan(int *index, ql_nw_network_scan_async_cb cb)
{
    pthread_t t;
    *index = 1;
    scan_cb = cb;
    return pthread_create(&t, NULL, scan_later, NULL);
}

int ql_sms_init(SMS_IPC_MODE m) { (void)m; return 0; }
int ql_sms_release() { return 0; }
int ql_sms_get_service_center_addr(char *addr, int n)
{
    char p[512], v[64] = "\"+8613010130500\",145";
    path(p, sizeof p, "smsc");
    FILE *f = fopen(p, "r");
    if (f) {
        if (!fgets(v, sizeof v, f))
            v[0] = 0;
        fclose(f);
    }
    snprintf(addr, (size_t)n + 1, "%s", v);
    return 0;
}
int ql_sms_set_service_center_addr(char *addr, int n)
{
    char v[64];
    snprintf(v, sizeof v, "\"%.*s\",145", n, addr);
    store("smsc", v);
    return 0;
}
static ql_ussd_response_cb_f ussd_cb;
static void *ussd_later(void *arg)
{
    (void)arg;
    usleep(100000);
    ql_ussd_response_ind_t r = {.ussd_response = 0};
    const char *mode = env("USSD", "text");
    if (!strcmp(mode, "ucs2")) {
        memcpy(r.ussd_payload, "\x4f\x59\x98\x9d", 4);
        r.ussd_len = 4;
    } else {
        strcpy(r.ussd_payload, "余额 \"29.9\" 元\n1. 流量\r\n");
        r.ussd_len = (uint16_t)strlen(r.ussd_payload);
    }
    ussd_cb(&r);
    return NULL;
}
int ql_ussd_response_cb(ql_ussd_response_cb_f cb) { ussd_cb = cb; return 0; }
int ql_ussd_send(ql_ussd_send_req_t *req)
{
    store("ussd", req->ussd_str);
    pthread_t t;
    return pthread_create(&t, NULL, ussd_later, NULL);
}
