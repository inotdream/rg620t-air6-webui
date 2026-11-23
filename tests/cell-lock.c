/* Host-only modem and storage failure injection. The RPC worker & voice guard are the production code. */
#define _GNU_SOURCE
#include <sys/uio.h>
static ssize_t journal_write(int fd,const struct iovec *parts,int count);
#define writev journal_write
#define main modem_cli_main
#include "dlink-cell.c"
#undef main
#undef writev
#include <assert.h>

static ql_nw_get_cell_arfcn_lock_resp_t lock_state;
static ql_nw_set_cell_arfcn_list_lock_req_t sent_list;
static int writes, list_writes, airplane, calls_on, calls_off;
static int fail_journal, fail_list, off_result, unreadable, wait_for_cancel;

static ssize_t journal_write(int fd,const struct iovec *parts,int count)
{
    if (fail_journal) { errno=ENOSPC; return -1; }
    return writev(fd,parts,count);
}
int ql_nw_get_cell_arfcn_lock(ql_nw_get_cell_arfcn_lock_resp_t *r) { *r=lock_state; return 0; }
int ql_nw_set_cell_arfcn_lock(ql_nw_set_cell_arfcn_lock_req_t *q)
{
    writes++;
    lock_state=(ql_nw_get_cell_arfcn_lock_resp_t){q->opt,q->act,q->arfcn,q->opt==1?q->pci:0,q->lock_mode};
    return 0;
}
int ql_nw_set_cell_arfcn_list_lock(ql_nw_set_cell_arfcn_list_lock_req_t *q)
{
    if (fail_list) return -1;
    list_writes++; sent_list=*q; return 0;
}
int ql_nw_get_band_mode(ql_nw_get_band_mode_info_t *b) { (void)b; return -1; }
int ql_dm_init(DM_IPC_MODE m) { (void)m; return 0; }
int ql_dm_release() { return 0; }
int ql_dm_get_air_plane_mode(QL_DM_AIR_PLANE_MODE_TYPE_E *p)
{
    if (unreadable) return -1;
    *p=airplane ? QL_DM_AIR_PLANE_MODE_ON : QL_DM_AIR_PLANE_MODE_OFF; return 0;
}
static void stamp(const char *name)
{
    int fd=open(name,O_WRONLY|O_CREAT,0600); assert(fd>=0); close(fd);
}
int ql_dm_set_air_plane_mode(QL_DM_AIR_PLANE_MODE_TYPE_E m)
{
    if (m==QL_DM_AIR_PLANE_MODE_ON) {
        calls_on++; airplane=1;
        if (wait_for_cancel) {
            stamp("radio-down");
            for (int i=0;i<150 && access("continue",F_OK);i++) usleep(100000);
        }
        return 0;
    }
    calls_off++;
    if (off_result==1) return -1;                        /* Stuck in airplane mode. */
    if (off_result==2) { unreadable=1; return -1; }      /* Final state cannot be read. */
    airplane=0;
    if (wait_for_cancel) stamp("radio-restored");
    return off_result==3 ? -1 : 0;                       /* Write worked despite an error. */
}
static void lock_fixture(void)
{
    modem_fd=open("modem.lock",O_CREAT|O_CLOEXEC|O_WRONLY,0600);
    assert(modem_fd>=0 && !flock(modem_fd,LOCK_EX|LOCK_NB));
}
static void cell_req(const char *system,const char *freq,const char *pci,int apply)
{
    char *argv[]={"cell","cell_set",(char *)system,(char *)freq,(char *)pci,"apply",NULL};
    if (!strcmp(system,"clear")) { argv[3]="apply"; cell_set(3+apply,argv); }
    else cell_set(5+apply,argv);
}
static void list_req(const char *value,int apply)
{
    char spec[CELL_LIST_MAX+1]; assert(strlen(value)<sizeof spec); strcpy(spec,value); cell_list(spec,apply);
}
static void fake_record(const char *contents)
{
    FILE *f=fopen(CELL_LIST_RECORD,"w"); assert(f); fputs(contents,f); assert(!fclose(f));
}
static void calls(const char *state) { assert(!setenv("VOICE_CASE",state,1)); }
static void report(const char *step)
{
    fflush(stdout);
    fprintf(stderr,"%s writes=%d list=%d on=%d off=%d opt=%u pci=%u airplane=%d\n",
            step,writes,list_writes,calls_on,calls_off,lock_state.opt,lock_state.pci,airplane);
}

int main(int argc, char **argv)
{
    if (argc==2 && !strcmp(argv[1],"interrupt")) {
        if (wait_for_lock_worker()) return 0;
        lock_fixture(); wait_for_cancel=1; calls("idle");
        cell_req("NR","633984","229",1); return 0;
    }
    lock_fixture(); calls("idle");
    unsetenv("DLINK_LOCK_RPC_V2"); locks(); report("legacy_locks");
    setenv("DLINK_LOCK_RPC_V2","1",1); locks(); report("fresh");
    cell_req("NR","633984","229",1); report("exact");
    assert(lock_state.act==11 && lock_state.arfcn==633984 && lock_state.lock_mode==3 && lock_state.pci==229);
    cell_req("NR","633984","229",1); report("same");
    calls("not_requested");
    cell_req("NR","633984","any",0); report("frequency");
    cell_req("NR","633984","1008",0); report("bad_pci");
    cell_req("LTE","0","any",0); report("bad_frequency");
    cell_req("LTE","0","0",0); report("legacy_zero");
    assert(lock_state.act==7 && lock_state.arfcn==0 && lock_state.pci==0);
    calls("idle");
    cell_req("clear",NULL,NULL,1); report("clear");
    const char *spec="NR:633984:229,LTE:0:0";
    list_req(spec,1); report("list_set");
    assert(sent_list.opt==1 && sent_list.nr_cell_count==1 && sent_list.nr_cell_list[0].nr_arfcn==633984 &&
           sent_list.nr_cell_list[0].pci==229 && sent_list.lte_cell_count==1 && sent_list.lte_cell_list[0].earfcn==0);
    locks(); report("list");
    fail_list=1; list_req("clear",1); report("list_reject"); fail_list=0; locks(); report("list_retained");
    calls("not_requested");
    list_req("clear",0); report("list_clear"); assert(sent_list.opt==0);
    locks(); report("list_empty");
    list_req(spec,0); report("list_again"); fail_journal=1;
    list_req("clear",0); report("record_failed"); fail_journal=0; locks(); report("record_unknown");
    fake_record("NR:2:1,NR:3:\n"); locks(); report("invalid");
    fake_record("NR:2:1,LTE:3:999\n"); locks(); report("out_of_range");
    calls("idle"); airplane=1; cell_req("clear",NULL,NULL,1); report("airplane");
    airplane=0; calls("call"); cell_req("NR","176190","20",1); report("voice_call");
    calls("mipc_call"); cell_req("clear",NULL,NULL,1); report("mipc_call");
    calls("unavailable"); cell_req("clear",NULL,NULL,1); report("voice_unknown");
    calls("legacy"); cell_req("clear",NULL,NULL,1); report("voice_legacy");
    calls("mipc_idle"); cell_req("clear",NULL,NULL,1); report("mipc_idle");
    calls("idle"); off_result=1; cell_req("clear",NULL,NULL,1); report("off");
    airplane=0; off_result=2; cell_req("clear",NULL,NULL,1); report("unknown");
    airplane=0; unreadable=0; off_result=3; cell_req("clear",NULL,NULL,1); report("off_ack_lost");
    return 0;
}
