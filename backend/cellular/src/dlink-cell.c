#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <inttypes.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/file.h>
#include <signal.h>
#include <sys/uio.h>
#include <sys/wait.h>
#include <time.h>
#include <unistd.h>
#include "ql_dm.h"
#include "ql_nw.h"
#include "ql_sms.h"
#include "ql_sim.h"
#include "sms-submit.h"

/* Last locally accepted list this boot, never a modem readback. The modem flock also serializes this journal. */
#define CELL_LIST_RECORD "/var/lock/dlink-cell-list.last"
#define CELL_LIST_MAX 2048
#define VOICE_HELPER "/usr/libexec/dlink-cellular-voice"
static int modem_fd = -1;

#define COUNT(a) (sizeof(a) / sizeof((a)[0]))
static void fail(const char *error, int code)
{
	printf("{\"ok\":false,\"error\":\"%s\",\"code\":%d}\n",error,code);
}
static void num(int value, int min, int max)
{
	if (value<min || value>max) printf("null"); else printf("%d",value);
}
static const char *rat(int value)
{
	switch (value) {
	case QL_NW_RADIO_TECH_LTE: return "LTE";
	case QL_NW_RADIO_TECH_NR5G: return "5G SA";
	case QL_NW_RADIO_TECH_NSA5G: return "5G NSA";
	case QL_NW_RADIO_TECH_GSM: return "GSM";
	case QL_NW_RADIO_TECH_UMTS: return "UMTS";
	default: return "";
	}
}
static void digit_str(const char *s, size_t max)
{
	for (; max && *s>='0' && *s<='9'; s++,max--) putchar(*s);
}
static void signal_values(int rsrp, int rsrq, int snr, int rssi, int nr)
{
	printf("{\"rsrp\":"); num(rsrp,-160,-30);
	printf(",\"rsrq\":"); num(nr && rsrq>0 ? -rsrq : rsrq,-45,0);
	printf(",\"sinr10\":"); num(snr,-350,500);
	printf(",\"rssi\":"); num(rssi,-150,-10); putchar('}');
}
static void cell(const char *type, uint32_t arfcn, uint32_t pci, uint64_t cid, uint32_t tac, int rsrp, int rsrq, int sinr, uint32_t ta, int *comma)
{
	if (*comma) putchar(',');
	*comma=1;
	if (tac>0xffffff) { tac=0; if (cid==0xfffffff || cid==0xffffffff || cid==0xfffffffff) cid=0; }
	printf("{\"rat\":\"%s\",\"arfcn\":%" PRIu32 ",\"pci\":%" PRIu32 ",\"cell\":\"%" PRIu64 "\",\"tac\":%" PRIu32 ",\"rsrp\":",
		type,arfcn,pci,cid,tac);
	num(rsrp,-160,-30);
	printf(",\"rsrq\":"); num(rsrq,-45,20);
	printf(",\"sinr10\":");
	/* The UI uses tenths of a dB. Cell info supplies NR in whole dB, LTE in tenths.
	 * Reject absent/out-of-range NR readings before scaling an SDK sentinel. */
	if (!strcmp(type,"NR")) {
		if (sinr < -35 || sinr > 50) fputs("null",stdout);
		else printf("%d",sinr * 10);
	} else num(sinr,-200,300);
	/* Only the SDK primary entry supplies serving TA. The SDK specifies no distance unit. */
	if (ta < INT32_MAX) printf(",\"ta\":%" PRIu32,ta);
	putchar('}');
}
static int registered(int state)
{
	return state==QL_NW_SERVICE_FULL || state==QL_NW_SERVICE_ROAMING ||
	       state==QL_NW_SERVICE_HOME_CSFB_NOT_PREF || state==QL_NW_SERVICE_ROAMING_CSFB_NOT_PREF;
}
static void link_metrics(const char *key, unsigned layers, unsigned mcs, unsigned mod, unsigned rate, int tx)
{
	static const char *const modulation[]={"BPSK","QPSK","16QAM","64QAM","256QAM"};
	printf("\"%s\":",key);
	if (layers<1 || layers>8) { fputs("null",stdout); return; }
	printf("{\"layers\":%u,\"mcs\":",layers); num(mcs,0,31);
	fputs(",\"modulation\":",stdout);
	if (mod<COUNT(modulation)) printf("\"%s\"",modulation[mod]); else fputs("null",stdout);
	printf(",\"kbytes_s\":"); num(rate,0,UINT16_MAX-1);
	if (tx!=INT16_MIN) { fputs(",\"pusch_dbm\":",stdout); num(tx,-60,40); }
	putchar('}');
}
static void carrier(int nr, int primary, int band, uint32_t pci, uint64_t arfcn, unsigned bw, unsigned state,
                    const pcc_ca_info_table *pcc, const scc_ca_info_table *scc, int *comma)
{
	const char *lte[]={"1.4","3","5","10","15","20"};
	const char *five[]={"5","10","15","20","25","30","40","50","60","80","90","100","70","200","400"};
	if (band<1 || band>1024) return;
	if (*comma) putchar(',');
	*comma=1;
	printf("{\"rat\":\"%s\",\"primary\":%s,\"band\":%d,\"arfcn\":%" PRIu64 ",\"pci\":%" PRIu32 ",\"bw\":\"%s\",\"state\":%u,",
		nr?"NR":"LTE",primary?"true":"false",band,arfcn,pci,nr?(bw<COUNT(five)?five[bw]:""):(bw<COUNT(lte)?lte[bw]:""),state);
	if (pcc) {
		link_metrics("dl",pcc->pcc_dl_mimo,pcc->pcc_dl_mcs,pcc->pcc_dl_modulation,pcc->pcc_dl_tput,INT16_MIN);
		putchar(',');
		link_metrics("ul",pcc->pcc_ul_mimo,pcc->pcc_ul_mcs,pcc->pcc_ul_modulation,pcc->pcc_ul_tput,pcc->pcc_pusch_tx_pwr);
	} else if (scc && state==2) {
		link_metrics("dl",scc->scc_dl_mimo,scc->scc_dl_mcs,scc->scc_dl_modulation,scc->scc_dl_tput,INT16_MIN);
		putchar(',');
		if (scc->scc_ul_configured==1)
			link_metrics("ul",scc->scc_ul_mimo,scc->scc_ul_mcs,scc->scc_ul_modulation,scc->scc_ul_tput,scc->scc_pusch_tx_pwr);
		else fputs("\"ul\":null",stdout);
	} else fputs("\"dl\":null,\"ul\":null",stdout);
	putchar('}');
}
static void ambr_value(const char *value, size_t len)
{
	char raw[16]={0};
	if (len >= sizeof raw) { fputs("null",stdout); return; }
	memcpy(raw,value,len);
	char *unit;
	errno=0;
	unsigned long long kbps=strtoull(raw,&unit,10);
	if (errno || raw[0]<'0' || raw[0]>'9' || !kbps || strcmp(unit," Kbps")) fputs("null",stdout);
	else printf("%llu",kbps);
}
static void ambr(const ql_nw_get_band_info_t *b)
{
	fputs("{\"net_dl\":",stdout); ambr_value(b->net_ambr_dl,sizeof b->net_ambr_dl);
	fputs(",\"net_ul\":",stdout); ambr_value(b->net_ambr_ul,sizeof b->net_ambr_ul);
	fputs(",\"ims_dl\":",stdout); ambr_value(b->ims_ambr_dl,sizeof b->ims_ambr_dl);
	fputs(",\"ims_ul\":",stdout); ambr_value(b->ims_ambr_ul,sizeof b->ims_ambr_ul);
	putchar('}');
}
static void overview(int detail)
{
	ql_nw_reg_status_info_t reg={0};
	ql_nw_cell_info_t c={0};
	ql_nw_signal_strength_info_t s={0};
	QL_NW_SIGNAL_STRENGTH_LEVEL_E level=0;
	ql_nw_get_ca_info_resp_t ca={0};
	int rr=ql_nw_get_data_reg_status(&reg), rs=ql_nw_get_signal_strength(&s,&level);
	if (detail) {
		for (size_t i=0;i<COUNT(c.nr_info);i++) c.nr_info[i].ta=UINT32_MAX;
		for (size_t i=0;i<COUNT(c.lte_info);i++) c.lte_info[i].ta=UINT32_MAX;
	}
	int rc=detail?ql_nw_get_cell_info(&c):-1, ra=detail?ql_nw_get_ca_info(&ca):-1;
	int comma=0;
	if (rr && rs && rc && ra) { fail("radio_read",rr); return; }

	printf("{\"ok\":true,\"register\":");
	if (rr) printf("null");
	else {
		printf("{\"state\":%d,\"registered\":%s,\"rat\":\"%s\",\"plmn\":\"",reg.reg_state,registered(reg.reg_state)?"true":"false",rat(reg.radio_tech));
		digit_str(reg.mcc,3); digit_str(reg.mnc,3);
		printf("\",\"tac\":%" PRIu32 ",\"cell\":\"%" PRIu64 "\",\"reject\":%d}",reg.tac,reg.cid,reg.reg_state==QL_NW_SERVICE_DENIED ? reg.deny_reason : 0);
	}
	printf(",\"lte\":");
	if (!rs && s.has_lte==1) signal_values(s.lte.rsrp,s.lte.rsrq,s.lte.snr,s.lte.rssi,0); else printf("null");
	printf(",\"nr\":");
	if (!rs && s.has_nr5g==1) signal_values(s.nr5g.rsrp,s.nr5g.rsrq,s.nr5g.snr,s.nr5g.rssi,1); else printf("null");
	if (!detail) { puts("}"); return; }
	printf(",\"cells\":");
	if (rc) printf("null");
	else {
		putchar('[');
		if (c.nr_info_valid==1)
			for (size_t i=0;i<c.nr_info_len && i<COUNT(c.nr_info);i++)
				cell("NR",c.nr_info[i].nr_arfcn,c.nr_info[i].pci,c.nr_info[i].cid,c.nr_info[i].tac,c.nr_info[i].rsrp,
				     c.nr_info[i].rsrq,c.nr_info[i].sinr,i==0 ? c.nr_info[i].ta : UINT32_MAX,&comma);
		if (c.lte_info_valid==1)
			for (size_t i=0;i<c.lte_info_len && i<COUNT(c.lte_info);i++)
				cell("LTE",c.lte_info[i].earfcn,c.lte_info[i].pci,c.lte_info[i].cid,c.lte_info[i].tac,c.lte_info[i].rsrp,
				     c.lte_info[i].rsrq,c.lte_info[i].sinr,i==0 ? c.lte_info[i].ta : UINT32_MAX,&comma);
		putchar(']');
	}
	printf(",\"carriers\":");
	if (ra) printf("null");
	else {
		putchar('['); comma=0;
		if (ca.nr_pcc_num) carrier(1,1,ca.nr_pcc_ca_info.pcc_band,ca.nr_pcc_ca_info.pcc_pci,ca.nr_pcc_ca_info.pcc_arfcn,ca.nr_pcc_ca_info.pcc_dl_bandwidth,2,&ca.nr_pcc_ca_info,NULL,&comma);
		if (ca.lte_pcc_num) carrier(0,1,ca.lte_pcc_ca_info.pcc_band,ca.lte_pcc_ca_info.pcc_pci,ca.lte_pcc_ca_info.pcc_arfcn,ca.lte_pcc_ca_info.pcc_dl_bandwidth,2,&ca.lte_pcc_ca_info,NULL,&comma);
		for (size_t i=0;i<ca.nr_scc_num && i<COUNT(ca.nr_scc_ca_info);i++) {
			const scc_ca_info_table *a=&ca.nr_scc_ca_info[i];
			carrier(1,0,a->scc_band,a->scc_pci,a->scc_arfcn,a->scc_dl_bandwidth,a->scc_state,NULL,a,&comma);
		}
		for (size_t i=0;i<ca.lte_scc_num && i<COUNT(ca.lte_scc_ca_info);i++) {
			const scc_ca_info_table *a=&ca.lte_scc_ca_info[i];
			carrier(0,0,a->scc_band,a->scc_pci,a->scc_arfcn,a->scc_dl_bandwidth,a->scc_state,NULL,a,&comma);
		}
		putchar(']');
	}
	ql_nw_get_band_info_t band={0};
	const int has_band=!rr && registered(reg.reg_state) && !ql_nw_get_band_info(&band);
	fputs(",\"ambr\":",stdout);
	if (has_band) ambr(&band); else fputs("null",stdout);
	fputs(",\"cqi\":",stdout);
	if (has_band) {
		fputs("{\"nr\":",stdout);
		num((reg.radio_tech==QL_NW_RADIO_TECH_NR5G || reg.radio_tech==QL_NW_RADIO_TECH_NSA5G) &&
		    band.nr_band>=1 && band.nr_band<=1024?band.nr_cqi:-1,0,15);
		fputs(",\"lte\":",stdout);
		num((reg.radio_tech==QL_NW_RADIO_TECH_LTE || reg.radio_tech==QL_NW_RADIO_TECH_NSA5G) &&
		    band.lte_band>=1 && band.lte_band<=1024?band.lte_cqi:-1,0,15);
		putchar('}');
	} else fputs("null",stdout);
	printf("}\n");
}
static void bands(const uint32_t *mask, size_t count)
{
	int comma=0;
	putchar('[');
	for (size_t i=0;i<count*32;i++)
		if (mask[i/32] & (UINT32_C(1) << (i%32))) {
			printf("%s%zu",comma?",":"",i+1);
			comma=1;
		}
	putchar(']');
}
static void band_state(int option)
{
	ql_nw_get_band_mode_info_t info={.get_band_option=option};
	if (ql_nw_get_band_mode(&info)!=0) { printf("null"); return; }
	printf("{\"lte\":");
	bands(info.lte_band_class,COUNT(info.lte_band_class));
	printf(",\"nr\":");
	bands(info.nr_band_class,COUNT(info.nr_band_class));
	putchar('}');
}
static const char *list_request(char *spec, ql_nw_set_cell_arfcn_list_lock_req_t *request, char *order);
static int read_record(int fd, char spec[CELL_LIST_MAX+2])
{
	ssize_t n=pread(fd,spec,CELL_LIST_MAX+2,0);
	if (n<2 || n>CELL_LIST_MAX+1 || spec[n-1]!='\n' || memchr(spec,0,(size_t)n)) return 0;
	spec[n-1]=0;
	return 1;
}
static void list_record(void)
{
	char spec[CELL_LIST_MAX+2];
	/* An unwritable old record could not be invalidated by a later accepted mutation. */
	int fd=open(CELL_LIST_RECORD,O_RDWR|O_NONBLOCK|O_CLOEXEC|O_NOFOLLOW);
	int valid=fd>=0 && read_record(fd,spec);
	if (fd>=0) close(fd);
	ql_nw_set_cell_arfcn_list_lock_req_t list={0};
	char order[COUNT(list.lte_cell_list)+COUNT(list.nr_cell_list)];
	if (!valid || list_request(spec,&list,order)) { fputs("null",stdout); return; }
	putchar('[');
	unsigned lte=0,nr=0;
	for (int i=0;i<list.lte_cell_count+list.nr_cell_count;i++) {
		uint32_t freq,pci;
		if (order[i]) { freq=list.nr_cell_list[nr].nr_arfcn; pci=list.nr_cell_list[nr++].pci; }
		else { freq=list.lte_cell_list[lte].earfcn; pci=list.lte_cell_list[lte++].pci; }
		printf("%s{\"rat\":\"%s\",\"arfcn\":%"PRIu32",\"pci\":%"PRIu32"}",i?",":"",
		       order[i]?"NR":"LTE",freq,pci);
	}
	putchar(']');
}
static void locks(void)
{
	ql_nw_get_cell_arfcn_lock_resp_t info={0};
	int rc=ql_nw_get_cell_arfcn_lock(&info);
	const char *v2=getenv("DLINK_LOCK_RPC_V2");
	printf("{\"ok\":true,%s\"cell\":",v2 && !strcmp(v2,"1") ? "\"lock_api\":2," : "");
	if (rc) printf("null");
	else printf("{\"opt\":%u,\"rat\":\"%s\",\"arfcn\":%" PRIu32 ",\"pci\":%" PRIu32 ",\"mode\":%u}",
		info.opt,info.act==11?"NR":info.act==7?"LTE":info.act==2?"UMTS":"",info.arfcn,info.pci,info.lock_mode);
	printf(",\"list\":"); list_record();
	printf(",\"current\":"); band_state(0);
	printf(",\"supported\":"); band_state(1);
	printf("}\n");
}
/* The private voice check borrows our modem flock; a local dial cannot race it. */
static const char *voice_idle(void)
{
	pid_t child=fork();
	if (child<0) return "apply_voice_unknown";
	if (!child) {
		int null=open("/dev/null",O_WRONLY);
		if (null<0 || dup2(null,STDOUT_FILENO)<0 || dup2(modem_fd,9)<0 || fcntl(9,F_SETFD,0)<0) _exit(2);
		execl(VOICE_HELPER,VOICE_HELPER,"reselect-idle",(char *)NULL);
		_exit(2);
	}
	int status;
	while (waitpid(child,&status,0)<0) if (errno!=EINTR) return "apply_voice_unknown";
	if (!WIFEXITED(status)) return "apply_voice_unknown";
	return WEXITSTATUS(status)==10 ? NULL : WEXITSTATUS(status)==11 ? "apply_call" : "apply_voice_unknown";
}
static int airplane_state(void)
{
	QL_DM_AIR_PLANE_MODE_TYPE_E mode=QL_DM_AIR_PLANE_MODE_UNKNOWN;
	if (ql_dm_get_air_plane_mode(&mode)) return -1;
	return mode==QL_DM_AIR_PLANE_MODE_ON ? 1 : mode==QL_DM_AIR_PLANE_MODE_OFF ? 0 : -1;
}
static int settle(int want)
{
	struct timespec start,now;
	if (clock_gettime(CLOCK_MONOTONIC,&start)) return airplane_state();
	for (;;) {
		int seen=airplane_state();
		if (seen==want || clock_gettime(CLOCK_MONOTONIC,&now) || now.tv_sec-start.tv_sec>3 ||
		    (now.tv_sec-start.tv_sec==3 && now.tv_nsec>=start.tv_nsec)) return seen;
		usleep(250000);
	}
}
static const char *reselect(void)
{
	const char *problem=NULL;
	if (ql_dm_init(DM_IPC_MODE_DEFAULT)) return "apply_init";
	int state=airplane_state();
	if (state!=0) problem=state==1 ? "apply_airplane" : "apply_read";
	else problem=voice_idle();
	if (!problem) {
		/* Even an errored SET can have taken effect: always read the final radio state. */
		int rc=ql_dm_set_air_plane_mode(QL_DM_AIR_PLANE_MODE_ON);
		if ((rc ? airplane_state() : settle(1))!=1) problem="apply_radio";
		for (int i=0;i<3;i++) {
			rc=ql_dm_set_air_plane_mode(QL_DM_AIR_PLANE_MODE_OFF);
			state=rc ? airplane_state() : settle(0);
			if (state==0) break;
		}
		if (state!=0) problem=state==1 ? "radio_off" : "radio_unknown";
	}
	ql_dm_release();
	return problem;
}
static void done(int apply, int recorded)
{
	const char *problem=apply ? reselect() : NULL;
	printf("{\"ok\":true,\"applied\":%s",apply && !problem ? "true" : "false");
	if (recorded>=0) printf(",\"verified\":false,\"recorded\":%s",recorded ? "true" : "false");
	if (problem) printf(",\"apply_error\":\"%s\"",problem);
	puts("}");
}
static int uint_arg(const char *s, unsigned long max, uint32_t *out)
{
	if (!s || !*s || strspn(s,"0123456789")!=strlen(s)) return 0;
	errno=0;
	unsigned long n=strtoul(s,0,10);
	if (errno || n>max) return 0;
	*out=(uint32_t)n; return 1;
}
static int select_bands(uint32_t *requested, const uint32_t *support, size_t count, const char *csv)
{
	if (!strcmp(csv,"auto")) {
		memcpy(requested,support,count*sizeof(*support));
	} else {
		const char *first=csv;
		while (*first) {
			size_t len=strspn(first,"0123456789");
			if (!len || len>4 || (first[len] && first[len]!=',')) return 0;
			char field[5]={0};
			memcpy(field,first,len);
			uint32_t n;
			if (!uint_arg(field,count*32,&n) || !n) return 0;
			uint32_t flag=UINT32_C(1) << ((n-1)%32);
			if (!(support[(n-1)/32]&flag)) return 0;
			requested[(n-1)/32] |= flag;
			first += len;
			if (*first==',' && !*++first) return 0;
		}
	}
	for (size_t i=0;i<count;i++) if (requested[i]) return 1;
	return 0;
}
static void band_set(const char *rat_arg, const char *list)
{
	int nr=!strcmp(rat_arg,"NR");
	if (!nr && strcmp(rat_arg,"LTE")) { fail("input",0); return; }
	ql_nw_get_band_mode_info_t avail={.get_band_option=1}, actual={0};
	ql_nw_set_band_mode_info_t desired={.set_band_option=nr?2:1};
	int rc=ql_nw_get_band_mode(&avail);
	if (rc) { fail("band_read",rc); return; }
	uint32_t *want=nr?desired.nr_band_class:desired.lte_band_class;
	size_t count=nr?COUNT(desired.nr_band_class):COUNT(desired.lte_band_class);
	if (!select_bands(want,nr?avail.nr_band_class:avail.lte_band_class,count,list)) { fail("input",0); return; }
	if ((rc=ql_nw_get_band_mode(&actual))!=0) { fail("band_read",rc); return; }
	size_t len=count*sizeof(*want);
	if (memcmp(want,nr?actual.nr_band_class:actual.lte_band_class,len)) {
		if ((rc=ql_nw_set_band_mode(&desired))!=0) { fail("band_write",rc); return; }
		if ((rc=ql_nw_get_band_mode(&actual))!=0 ||
		    memcmp(want,nr?actual.nr_band_class:actual.lte_band_class,len)) {
			fail("readback",rc); return;
		}
	}
	puts("{\"ok\":true}");
}
static int same_lock(const ql_nw_set_cell_arfcn_lock_req_t *want, const ql_nw_get_cell_arfcn_lock_resp_t *got)
{
	if (!want->opt) return got->opt==0;
	/* A frequency lock (opt 2) has no PCI to compare. */
	return got->opt==want->opt && got->act==want->act && got->arfcn==want->arfcn &&
		got->lock_mode==want->lock_mode && (want->opt==2 || got->pci==want->pci);
}
/* cell_set clear [apply] | cell_set RAT ARFCN PCI|any [apply] */
static void cell_set(int argc,char **argv)
{
	ql_nw_set_cell_arfcn_lock_req_t desired={0};
	ql_nw_get_cell_arfcn_lock_resp_t actual={0};
	int clear=!strcmp(argv[2],"clear");
	int args=clear ? 3 : 5;
	int apply=argc==args+1 && !strcmp(argv[args],"apply");
	if (argc!=args && !apply) { fail("input",0); return; }
	if (!clear) {
		if (strcmp(argv[2],"LTE") && strcmp(argv[2],"NR")) { fail("input",0); return; }
		int nr=!strcmp(argv[2],"NR"), any=!strcmp(argv[4],"any");
		desired.act=nr?11:7; desired.opt=any?2:1; desired.lock_mode=3;
		if (!uint_arg(argv[3],nr?3279165:262143,&desired.arfcn) || (any && !desired.arfcn) ||
		    (!any && !uint_arg(argv[4],nr?1007:503,&desired.pci))) { fail("input",0); return; }
	}
	int rc=ql_nw_get_cell_arfcn_lock(&actual);
	if (rc) { fail("cell_read",rc); return; }
	if (!same_lock(&desired,&actual)) {
		if ((rc=ql_nw_set_cell_arfcn_lock(&desired))!=0) { fail("cell_write",rc); return; }
		if ((rc=ql_nw_get_cell_arfcn_lock(&actual))!=0 || !same_lock(&desired,&actual)) { fail("readback",rc); return; }
	}
	/* Re-applying an unchanged lock still re-selects: that is how a pending lock is made effective. */
	done(apply,-1);
}
/* Mark the record unknown before sending a write. A killed process leaves no stale list. */
static int begin_record(char previous[CELL_LIST_MAX+2])
{
	int fd=open(CELL_LIST_RECORD,O_RDWR|O_CREAT|O_NONBLOCK|O_CLOEXEC|O_NOFOLLOW,0600);
	if (fd>=0) {
		if (!read_record(fd,previous)) previous[0]=0;
		if (!ftruncate(fd,0)) return fd;
		close(fd);
	}
	unlink(CELL_LIST_RECORD);
	return -1;
}
static int finish_record(int fd, const char *spec)
{
	if (fd<0) return 0;
	size_t n=strlen(spec);
	struct iovec parts[]={{(void *)spec,n},{(void *)"\n",1}};
	int saved=n && writev(fd,parts,2)==(ssize_t)(n+1);
	if (close(fd)) saved=0;
	if (!saved) unlink(CELL_LIST_RECORD);
	return saved;
}
static const char *list_request(char *spec, ql_nw_set_cell_arfcn_list_lock_req_t *request, char *order)
{
	if (!strcmp(spec,"clear")) return NULL;
	request->opt=1;
	char *row;
	while ((row=strsep(&spec,","))) {
		char *system=strsep(&row,":");
		char *freq=strsep(&row,":");
		char *phys=strsep(&row,":");
		int nr=!strcmp(system,"NR");
		uint32_t arfcn,pci;
		if ((!nr && strcmp(system,"LTE")) || row || !uint_arg(freq,nr?3279165:262143,&arfcn) ||
		    !uint_arg(phys,nr?1007:503,&pci)) return "input";
		if (nr) {
			if (request->nr_cell_count>=COUNT(request->nr_cell_list)) return "input";
			if (order) order[request->nr_cell_count+request->lte_cell_count]=1;
			for (unsigned i=0;i<request->nr_cell_count;i++)
				if (request->nr_cell_list[i].nr_arfcn==arfcn && request->nr_cell_list[i].pci==pci) return "cell_duplicate";
			request->nr_cell_list[request->nr_cell_count++]=(nr_cell_lock_info){.nr_arfcn=arfcn,.pci=pci,.freq_band=0};
		} else {
			if (request->lte_cell_count>=COUNT(request->lte_cell_list)) return "input";
			if (order) order[request->nr_cell_count+request->lte_cell_count]=0;
			for (unsigned i=0;i<request->lte_cell_count;i++)
				if (request->lte_cell_list[i].earfcn==arfcn && request->lte_cell_list[i].pci==pci) return "cell_duplicate";
			request->lte_cell_list[request->lte_cell_count++]=(lte_cell_lock_info){.earfcn=arfcn,.pci=pci};
		}
	}
	return request->lte_cell_count+request->nr_cell_count>=2 ? NULL : "cell_min";
}
static void cell_list(char *spec, int apply)
{
	ql_nw_set_cell_arfcn_list_lock_req_t request={0};
	char accepted[CELL_LIST_MAX+1],previous[CELL_LIST_MAX+2]="";
	if (strlen(spec)>CELL_LIST_MAX) { fail("input",0); return; }
	strcpy(accepted,spec);
	const char *problem=list_request(spec,&request,NULL);
	if (problem) { fail(problem,0); return; }
	if (request.opt) {
		ql_nw_get_cell_arfcn_lock_resp_t single={0};
		int rc=ql_nw_get_cell_arfcn_lock(&single);
		if (rc) { fail("cell_read",rc); return; }
		if (single.opt) { fail("single_lock",0); return; }
	}
	int fd=begin_record(previous);
	int rc=ql_nw_set_cell_arfcn_list_lock(&request);
	if (rc) {
		finish_record(fd,previous);
		fail("cell_list_write",rc);
		return;
	}
	done(apply,finish_record(fd,accepted));
}
static void inbox(void)
{
	ql_sms_store_message_number_t storage={0};
	ql_sms_read_pdu_req_t req={.flag=QL_SMS_FLAG_ALL};
	ql_sms_read_pdu_resp_t res={0};
	int rs=ql_sms_get_store_message_number(&storage), rc=ql_sms_read_pdu(&req,&res);
	if (rc && (rs || storage.used_message)) { fail("sms_list",rc); return; }

	printf("{\"ok\":true,\"used\":");
	if (rs) printf("null"); else printf("%u",storage.used_message);
	printf(",\"capacity\":");
	if (rs) printf("null"); else printf("%u",storage.max_message);
	printf(",\"limited\":%s,\"indexes\":[",res.message_count>COUNT(res.all_message_index) ||
		(!rs && storage.used_message>res.message_count) ? "true":"false");
	for (size_t i=0;!rc && i<res.message_count && i<COUNT(res.all_message_index);i++)
		printf("%s%u",i?",":"",res.all_message_index[i]);
	puts("]}");
}
static void read_sms(const char *id)
{
	uint32_t n;
	if (!uint_arg(id,UINT16_MAX,&n)) { fail("input",0); return; }
	ql_sms_read_pdu_req_t req={.flag=QL_SMS_FLAG_INDEX,.message_index=n};
	ql_sms_read_pdu_resp_t res={0};
	int rc=ql_sms_read_pdu(&req,&res);
	if (rc || !res.content_size) { fail("sms_read",rc); return; }
	printf("{\"ok\":true,\"pdu\":\"");
	for (size_t i=0;i<res.content_size;i++) printf("%02X",(unsigned char)res.content[i]);
	puts("\"}");
}
static void send_sms(void)
{
	char to[18], body[212];
	/* Phone is on its own line; the remaining input is UTF-8 message text. */
	if (!fgets(to,sizeof to,stdin)) { fail("input",0); return; }
	char *newline=strchr(to,'\n');
	if (!newline) { fail("input",0); return; }
	*newline=0;
	size_t n=fread(body,1,sizeof body-1,stdin);
	if (ferror(stdin) || fgetc(stdin)!=EOF || memchr(body,0,n)) { fail("input",0); return; }
	body[n]=0;
	ql_sms_pdu_t pdu={.format=QL_SMS_PDU_FORMAT_GW_PP};
	pdu.content_size=sms_submit((unsigned char *)pdu.content,sizeof pdu.content,to,body);
	if (!pdu.content_size) { fail("input",0); return; }
	int rc=ql_sms_send_pdu(&pdu);
	if (rc) fail("sms_send",rc); else puts("{\"ok\":true}");
}
static int mimo_read(int nr, ql_nw_4x4_mimo_mode_t *mode)
{
	mode->mode=-1;
	return nr?ql_nw_get_nr_4x4_mimo_mode(mode):ql_nw_get_lte_4x4_mimo_mode(mode);
}
static void mimo_value(int nr)
{
	ql_nw_4x4_mimo_mode_t m;
	if (mimo_read(nr,&m) || (m.mode!=0 && m.mode!=1)) fputs("null",stdout);
	else fputs(m.mode?"true":"false",stdout);
}
static void mimo_info(void)
{
	fputs("{\"ok\":true,\"lte\":",stdout); mimo_value(0);
	fputs(",\"nr\":",stdout); mimo_value(1); puts("}");
}
static void mimo_set(const char *name, const char *enabled)
{
	const int nr=!strcmp(name,"NR");
	if ((!nr && strcmp(name,"LTE")) || (strcmp(enabled,"0") && strcmp(enabled,"1"))) { fail("input",0); return; }
	ql_nw_4x4_mimo_mode_t actual, desired={.mode=enabled[0]=='1'};
	int rc=mimo_read(nr,&actual);
	if (rc || (actual.mode!=0 && actual.mode!=1)) { fail("mimo_unsupported",rc); return; }
	if (actual.mode!=desired.mode) {
		rc=nr?ql_nw_set_nr_4x4_mimo_mode(&desired):ql_nw_set_lte_4x4_mimo_mode(&desired);
		if (rc) { fail("mimo_write",rc); return; }
		if ((rc=mimo_read(nr,&actual)) || actual.mode!=desired.mode) { fail("readback",rc); return; }
	}
	printf("{\"ok\":true,\"enabled\":%s}\n",actual.mode?"true":"false");
}
static void sim_status(void)
{
	int rc=ql_sim_init(SIM_IPC_MODE_DEFAULT);
	if (rc) { fail("sim_init",rc); return; }
	ql_sim_card_info_t card={0};
	ql_sim_get_all_remain_time_resp_t counts={.result=UINT32_MAX,.pin1_count=UINT8_MAX,.puk1_count=UINT8_MAX};
	rc=ql_sim_get_card_info(QL_SIM_SLOT_1,&card);
	if (rc) fail("sim_read",rc);
	else {
		const char *state="other";
		switch (card.state) {
		case QL_SIM_STATUS_NOT_INSERT: state="absent"; break;
		case QL_SIM_STATUS_READY: case QL_SIM_STATUS_COMPLETE_READY: state="ready"; break;
		case QL_SIM_STATUS_SIM_PIN: state="pin"; break;
		case QL_SIM_STATUS_SIM_PUK: state="puk"; break;
		default: break;
		}
		printf("{\"ok\":true,\"state\":\"%s\",\"pin1\":",state);
		const int count_ok=card.state!=QL_SIM_STATUS_NOT_INSERT &&
			!ql_sim_get_all_remain_time(QL_SIM_SLOT_1,&counts) && counts.result==0;
		num(count_ok?counts.pin1_count:-1,0,254);
		fputs(",\"puk1\":",stdout); num(count_ok?counts.puk1_count:-1,0,254);
		puts("}");
	}
	ql_sim_release();
}
/* Fork before the SDK starts its IPC threads. A timed-out RPC or a disconnected client
 * can kill the waiter, not the session which owns the modem lock and restores radio power. */
static int wait_for_lock_worker(void)
{
	int channel[2];
	if (pipe(channel)) { fail("busy",errno); return 1; }
	pid_t worker=fork();
	if (worker<0) { close(channel[0]); close(channel[1]); fail("busy",errno); return 1; }
	if (!worker) {
		close(channel[0]);
		if (setsid()<0 || dup2(channel[1],STDOUT_FILENO)<0) _exit(1);
		close(channel[1]);
		signal(SIGPIPE,SIG_IGN);
		return 0;
	}
	close(channel[1]);
	char reply[512];
	size_t used=0;
	while (used<sizeof reply-1) {
		ssize_t n=read(channel[0],reply+used,sizeof reply-1-used);
		if (n<0 && errno==EINTR) continue;
		if (n<=0) break;
		used+=(size_t)n;
	}
	close(channel[0]);
	int status;
	while (waitpid(worker,&status,0)<0 && errno==EINTR) {}
	if (!used || reply[used-1]!='\n') fail("timeout",0);
	else fwrite(reply,1,used,stdout);
	return 1;
}
int main(int argc,char **argv)
{
	if (argc<2) { fail("input",0); return 0; }
	const char *action=argv[1];
	int apply=(!strcmp(action,"cell_set") && (argc==6 || (argc==4 && !strcmp(argv[2],"clear")))) ||
	          (!strcmp(action,"cell_list") && argc==4);
	if (apply && !strcmp(argv[argc-1],"apply") && wait_for_lock_worker()) return 0;
	modem_fd=open("/var/lock/dlink-cellular.lock",O_CREAT|O_CLOEXEC|O_NOFOLLOW|O_WRONLY,0600);
	if (modem_fd<0 || flock(modem_fd,LOCK_EX|LOCK_NB)) { fail("busy",0); return 0; }
	if (!strcmp(action,"sim_status") && argc==2) { sim_status(); return 0; }
	int sms=!strncmp(action,"sms_",4);
	int rc=sms ? ql_sms_init(SMS_IPC_MODE_DEFAULT) : ql_nw_init(NW_IPC_MODE_DEFAULT);
	if (rc) { fail("ril_init",rc); return 0; }
	if (!strcmp(action,"overview")) overview(1);
	else if (!strcmp(action,"summary")) overview(0);
	else if (!strcmp(action,"locks")) locks();
	else if (!strcmp(action,"mimo_info") && argc==2) mimo_info();
	else if (!strcmp(action,"mimo_set") && argc==4) mimo_set(argv[2],argv[3]);
	else if (!strcmp(action,"band_set") && argc==4) band_set(argv[2],argv[3]);
	else if (!strcmp(action,"cell_set") && argc>=3) cell_set(argc,argv);
	else if (!strcmp(action,"cell_list") && (argc==3 || (argc==4 && !strcmp(argv[3],"apply")))) cell_list(argv[2],argc==4);
	else if (!strcmp(action,"sms_list") && argc==2) inbox();
	else if (!strcmp(action,"sms_read") && argc==3) read_sms(argv[2]);
	else if (!strcmp(action,"sms_send") && argc==2) send_sms();
	else fail("input",0);
	if (sms) ql_sms_release(); else ql_nw_release();
	return 0;
}
