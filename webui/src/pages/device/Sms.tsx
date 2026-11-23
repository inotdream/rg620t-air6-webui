import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Banner,
  Button,
  Checkbox,
  Input,
  Layout,
  Modal,
  Progress,
  Space,
  Tag,
  TextArea,
  Toast,
  Typography,
} from '@douyinfe/semi-ui';
import { IconDelete, IconPlus, IconRefresh, IconSearch, IconSend } from '@douyinfe/semi-icons';
import { getSession, ubus } from '@/services/deviceUbus';
import { useSmsEvents } from '@/modules/cellular/stream';
import { decodeDeliver, mergeParts, readableTime, type InboxMessage } from '@/modules/sms/decode';
import { TAG_COLOR } from '@/ui/tokens';
import SmsServices from '@/modules/cellular/SmsServices';
import { useSdkAccess } from '@/modules/cellular/sdk';

const { Sider, Content } = Layout;

type Inbox = { ok?: boolean; used?: number; capacity?: number; indexes?: number[]; limited?: boolean; error?: string };
type ReadResult = { ok?: boolean; pdu?: string; error?: string };
type DeleteResult = { ok?: boolean; deleted?: number; partial?: boolean; error?: string };
type Thread = { number: string; messages: InboxMessage[] };

/**
 * 联机基带只有一把非阻塞锁：事件采样器每 4/8 秒会短暂占锁，删除或读取正好撞上就返回 busy。
 * 这类冲突是瞬时的，值得退避重试，而不是直接把失败甩给用户。
 */
const RETRY_DELAYS = [250, 500, 900];
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const isBusy = (error?: string) => error === 'busy';

/** 删除同样会被瞬时占锁挡住：busy 时退避重试，最终仍失败才把原因交给页面。 */
const requestDelete = async (payload: Record<string, unknown>) => {
  for (let attempt = 0; ; attempt += 1) {
    try {
      const response = await ubus<DeleteResult>('dlink-cellular', 'sms_delete', { ...payload, confirm: true });
      if (response.ok !== true && isBusy(response.error) && attempt < RETRY_DELAYS.length) {
        await delay(RETRY_DELAYS[attempt]);
        continue;
      }
      return response;
    } catch (error) {
      if (error instanceof Error && isBusy(error.message) && attempt < RETRY_DELAYS.length) {
        await delay(RETRY_DELAYS[attempt]);
        continue;
      }
      throw error;
    }
  }
};

const avatarLabel = (num: string) => {
  const digits = num.replace(/\D/g, '');
  if (digits.length >= 2) return digits.slice(-2);
  return num.slice(0, 2) || '?';
};

const Sms: React.FC = () => {
  const sdkAccess = useSdkAccess();
  const [inbox, setInbox] = useState<Inbox | null>(null);
  const [messages, setMessages] = useState<InboxMessage[]>([]);
  const [unreadable, setUnreadable] = useState(0);
  const [readErrors, setReadErrors] = useState(0);
  const [inboxComplete, setInboxComplete] = useState(false);
  const [active, setActive] = useState('');
  const [query, setQuery] = useState('');
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [deleteCaps, setDeleteCaps] = useState({ single: false, group: false });
  const canDelete = deleteCaps.single;
  const [selection, setSelection] = useState<number[] | null>(null);
  const [deleting, setDeleting] = useState(false);
  const deleteInFlight = useRef(false);
  const [composeOpen, setComposeOpen] = useState(false);
  const [composeTo, setComposeTo] = useState('');
  const [composeBody, setComposeBody] = useState('');
  const endRef = useRef<HTMLDivElement>(null);
  const { version } = useSmsEvents();
  const seenVersion = useRef(version);

  const load = useCallback(async () => {
    setRefreshing(true);
    setSelection(null);
    setInboxComplete(false);
    try {
      let summary: Inbox | null = null;
      for (let attempt = 0; !summary; attempt += 1) {
        const reply = await ubus<Inbox>('dlink-cellular', 'sms_list');
        if (reply.ok === true && Array.isArray(reply.indexes)) summary = reply;
        else if (isBusy(reply.error) && attempt < RETRY_DELAYS.length) await delay(RETRY_DELAYS[attempt]);
        else throw new Error('未能获取完整短信列表，请刷新');
      }
      setInbox(summary);
      const decoded: InboxMessage[] = [];
      let bad = 0;
      let failed = 0;
      for (const index of summary.indexes!.slice(0, 80)) {
        try {
          let message: ReadResult | null = null;
          for (let attempt = 0; !message; attempt += 1) {
            const reply = await ubus<ReadResult>('dlink-cellular', 'sms_read', { index });
            if (reply.ok === true && reply.pdu) message = reply;
            else if (isBusy(reply.error) && attempt < RETRY_DELAYS.length) await delay(RETRY_DELAYS[attempt]);
            else break;
          }
          if (!message?.pdu) {
            failed += 1;
            continue;
          }
          const parsed = decodeDeliver(message.pdu);
          if (parsed) decoded.push({ index, ...parsed, records: [{ index, pdu: message.pdu }] });
          else bad += 1;
        } catch {
          failed += 1;
        }
      }
      setMessages(mergeParts(decoded, true));
      setUnreadable(bad);
      setReadErrors(failed);
      setInboxComplete(!failed && !summary.limited && summary.indexes!.length <= 80);
    } catch (error) {
      Toast.error(error instanceof Error ? error.message : '读取短信失败');
    } finally {
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    if (version == null || seenVersion.current === version || refreshing || deleting || selection !== null) return;
    seenVersion.current = version;
    void load();
  }, [version, refreshing, deleting, selection, load]);

  useEffect(() => {
    if (import.meta.env.VITE_SMS_DELETE !== 'on') return;
    let mounted = true;
    void ubus<{ sms_delete?: boolean; sms_delete_group?: boolean }>('dlink-cellular', 'access')
      .then((capabilities) => {
        if (mounted) setDeleteCaps({ single: capabilities.sms_delete === true, group: capabilities.sms_delete_group === true });
      })
      .catch(() => { /* Older or unavailable backend: leave delete hidden. */ });
    return () => { mounted = false; };
  }, []);

  const threads = useMemo<Thread[]>(() => {
    const map = new Map<string, InboxMessage[]>();
    messages.forEach((message) => {
      const key = message.number || '未知号码';
      map.set(key, [...(map.get(key) || []), message]);
    });
    const list = Array.from(map.entries())
      .map(([number, items]) => ({ number, messages: items }))
      .sort((a, b) => b.messages[b.messages.length - 1].index - a.messages[a.messages.length - 1].index);

    const keyword = query.trim().toLowerCase();
    if (!keyword) return list;
    return list.filter(
      (thread) =>
        thread.number.toLowerCase().includes(keyword) ||
        thread.messages.some((m) => (m.content || '').toLowerCase().includes(keyword)),
    );
  }, [messages, query]);

  const current = threads.find((thread) => thread.number === active) || threads[0];

  useEffect(() => {
    endRef.current?.scrollIntoView({ block: 'end' });
  }, [current?.messages.length, active]);

  const send = async (to: string, body: string) => {
    if (!to.trim() || !body.trim()) {
      Toast.warning('号码和内容都要填');
      return false;
    }
    setSending(true);
    try {
      await ubus('dlink-cellular', 'sms_send', { to: to.trim(), body, confirm: true });
      Toast.success('已发送');
      return true;
    } catch (error) {
      Toast.error(error instanceof Error ? error.message : '发送失败');
      return false;
    } finally {
      setSending(false);
    }
  };

  const storagePct = inbox?.capacity ? Math.round(((inbox.used || 0) / inbox.capacity) * 100) : 0;

  const canRemove = (message: InboxMessage) => Boolean(message.records?.length)
    && (!(message.fragments || message.records!.length > 1) || (deleteCaps.group && inboxComplete))
    && message.records!.every(({ index }) => Number.isInteger(index) && index > 0 && index < 65535);
  const selected = current?.messages.filter((message) => selection?.includes(message.index) && canRemove(message)) || [];
  const busy = deleting || refreshing || sending;

  const openThread = (number: string) => {
    setActive(number);
    setSelection(null);
  };

  const removeMessages = async (targets: InboxMessage[]) => {
    if (targets.length === 0 || deleteInFlight.current) return;
    deleteInFlight.current = true;
    setDeleting(true);
    const session = getSession();
    let removed = 0;
    let problem = '删除失败';
    try {
      for (const message of targets) {
        if (!canRemove(message) || !session || getSession() !== session) break;
        try {
          const records = message.records!;
          const grouped = Boolean(message.fragments || records.length > 1);
          const response = await requestDelete(grouped ? { records } : records[0]);
          if (response.partial === true) {
            problem = '部分分片未删除，刷新后可重试';
            continue;
          }
          if (response.ok !== true || (grouped && response.deleted !== records.length)) {
            throw new Error('设备没有确认整条删除，请刷新核对');
          }
          removed += 1;
        } catch (error) {
          const reason = error instanceof Error ? error.message : '';
          problem = ({
            sms_changed: '短信已变化，请刷新后核对',
            sms_read: '设备无法核对原短信',
            busy: '模块正忙',
            timeout: '设备未及时确认删除',
            unsupported: '设备尚未支持删除',
          } as Record<string, string>)[reason] || reason || '删除失败';
        }
      }
      const remaining = targets.length - removed;
      if (!remaining) Toast.success('已删除 ' + removed + ' 条短信');
      else if (removed) Toast.warning('已删除 ' + removed + ' 条，' + remaining + ' 条未完整删除：' + problem);
      else Toast.error(problem);
      await load();
    } finally {
      deleteInFlight.current = false;
      setDeleting(false);
    }
  };

  const confirmDeletion = (targets: InboxMessage[]) => {
    if (!targets.length || busy) return;
    const records = targets.reduce((n,m)=>n+(m.records?.length || 0),0);
    Modal.confirm({
      title: targets.length === 1 ? '删除这条短信' : '删除选中的短信',
      content: targets.some((message) => message.fragments || (message.records?.length || 0)>1)
        ? `将删除所选短信的全部 ${records} 条存储记录（含现有分片及重复副本），无法恢复。`
        : '将删除所选的 ' + targets.length + ' 条短信，删除后无法恢复。',
      okText: '删除',
      okButtonProps: { type: 'danger', theme: 'solid', 'aria-label': '确认删除' },
      cancelText: '取消',
      cancelButtonProps: { 'aria-label': '取消删除' },
      onOk: () => removeMessages(targets),
    });
  };

  return (
    <div className="sms-page sms-page--device">
      <div className="sms-toolbar">
        <div className="sms-toolbar-main">
          {inbox?.capacity ? (
            <div className="sms-storage-pill">
              <span>SIM 存储</span>
              <b>
                {inbox.used ?? 0}/{inbox.capacity}
              </b>
              <Progress percent={storagePct} showInfo={false} size="small" />
            </div>
          ) : (
            <span className="toolbar-pill">共 {threads.length} 组会话</span>
          )}
        </div>
        <div className="sms-toolbar-actions">
          {sdkAccess?.sdk ? <SmsServices disabled={deleting} /> : null}
          <Button size="small" icon={<IconRefresh />} loading={refreshing} disabled={deleting} onClick={() => load()}>
            刷新
          </Button>
          <Button size="small" theme="solid" type="primary" icon={<IconPlus />} disabled={deleting} onClick={() => setComposeOpen(true)}>
            发送新短信
          </Button>
        </div>
      </div>

      {inbox?.limited ? (
        <Banner type="warning" closeIcon={null} description="短信条数超过模块一次上报的上限，当前仅列出前一部分。" />
      ) : null}
      {readErrors ? (
        <Banner type="warning" closeIcon={null} description="部分短信未能读取，请刷新后再删除长短信。" />
      ) : null}
      {unreadable ? (
        <Banner
          type="info"
          closeIcon={null}
          description={`${unreadable} 条短信不是纯文本（可能是运营商通知或二进制推送），未在会话中展示。`}
        />
      ) : null}

      <Layout className="sms-shell">
        <Sider className="sms-contacts">
          <div className="sms-contacts-head">
            <Input
              prefix={<IconSearch />}
              size="small"
              value={query}
              onChange={(value) => { setQuery(value); setSelection(null); }}
              placeholder="搜索号码或内容…"
              showClear
            />
          </div>
          {threads.length === 0 ? (
            <div className="sms-contact-empty">
              <Typography.Text type="tertiary">
                {refreshing ? '正在同步短信…' : query ? '没有匹配的短信' : '暂无短信会话'}
              </Typography.Text>
            </div>
          ) : (
            <div className="sms-contact-list">
              {threads.map((thread) => {
                const last = thread.messages[thread.messages.length - 1];
                const isSelected = current?.number === thread.number;
                return (
                  <div
                    key={thread.number}
                    className={`sms-contact${isSelected ? ' active' : ''}`}
                    onClick={() => openThread(thread.number)}
                    role="button"
                    tabIndex={0}
                    onKeyDown={(event) => event.key === 'Enter' && openThread(thread.number)}
                  >
                    <span className="sms-avatar" aria-hidden="true">
                      {avatarLabel(thread.number)}
                    </span>
                    <div className="sms-contact-main">
                      <div className="sms-contact-line">
                        <span className="sms-contact-name">{thread.number}</span>
                        <span className="sms-contact-time">{readableTime(last.time).slice(5, 16)}</span>
                      </div>
                      <div className="sms-contact-bottom">
                        <span className="sms-contact-preview">{last.content || '(空内容)'}</span>
                        {thread.messages.length > 1 ? (
                          <span className="sms-count-pill">{thread.messages.length}</span>
                        ) : null}
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </Sider>

        <Content className="sms-thread">
          {current ? (
            <>
              <div className="sms-thread-head">
                <div className="sms-thread-peer">
                  <span className="sms-avatar sms-avatar--sm" aria-hidden="true">
                    {avatarLabel(current.number)}
                  </span>
                  <div>
                    <div className="sms-thread-title">{current.number}</div>
                    <div className="sms-thread-sub">共 {current.messages.length} 条记录</div>
                  </div>
                </div>
                <Space spacing={8} wrap>
                  <Tag size="small" color={TAG_COLOR.neutral}>
                    SIM 收件箱
                  </Tag>
                  {canDelete && current.messages.some(canRemove) && (
                    selection === null ? (
                      <Button
                        size="small"
                        theme="borderless"
                        icon={<IconDelete aria-hidden />}
                        onClick={() => setSelection([])}
                        disabled={busy}
                      >
                        批量删除
                      </Button>
                    ) : (
                      <>
                        <Button size="small" theme="borderless" disabled={busy} onClick={() => setSelection(null)}>
                          取消选择
                        </Button>
                        <Button
                          size="small"
                          type="danger"
                          theme="solid"
                          loading={deleting}
                          disabled={busy || selected.length === 0}
                          onClick={() => confirmDeletion(selected)}
                        >
                          删除所选 ({selected.length})
                        </Button>
                      </>
                    )
                  )}
                </Space>
              </div>

              <div className="sms-messages">
                {current.messages.map((message) => (
                  <div className="sms-message-row" key={message.index}>
                    <div className="sms-message-body">
                      <span className="sms-message-time">
                        {readableTime(message.time)}
                        {message.fragments && message.fragments.available < message.fragments.total
                          ? ' · 现存 ' + message.fragments.available + '/' + message.fragments.total + ' 个分片'
                          : message.parts ? ' · 分片 ' + message.parts.seq + '/' + message.parts.total : ''}
                      </span>
                      <div className="sms-bubble">{message.content || '(无内容)'}</div>
                    </div>
                    {canDelete && canRemove(message) && (
                      selection === null ? (
                        <Button
                          className="sms-message-delete"
                          size="small"
                          type="tertiary"
                          theme="borderless"
                          icon={<IconDelete aria-hidden />}
                          aria-label="删除这条短信"
                          title="删除这条短信"
                          disabled={busy}
                          onClick={() => confirmDeletion([message])}
                        />
                      ) : (
                        <Checkbox
                          aria-label={'选择 ' + readableTime(message.time) + ' 的短信'}
                          checked={selection.includes(message.index)}
                          disabled={busy}
                          onChange={(event) => {
                            setSelection((items) => items && (event.target.checked
                              ? [...items, message.index]
                              : items.filter((index) => index !== message.index)));
                          }}
                        />
                      )
                    )}
                  </div>
                ))}
                <div ref={endRef} />
              </div>

              <div className="sms-composer">
                <TextArea
                  value={draft}
                  onChange={setDraft}
                  placeholder={`回复 ${current.number}…`}
                  autosize={{ minRows: 2, maxRows: 4 }}
                />
                <Button
                  theme="solid"
                  type="primary"
                  icon={<IconSend />}
                  loading={sending}
                  disabled={deleting}
                  onClick={async () => {
                    if (await send(current.number, draft)) {
                      setDraft('');
                      await load();
                    }
                  }}
                >
                  发送
                </Button>
              </div>
              <div className="sms-composer-hint">
                <span>当前 {draft.length} 字 · 超过 70 个汉字将由模组自动拆分成长短信</span>
              </div>
            </>
          ) : (
            <div className="sms-thread-empty">
              <Typography.Text type="tertiary">选择左侧号码查看对话，或点击右上角发送新短信</Typography.Text>
            </div>
          )}
        </Content>
      </Layout>

      <Modal
        title="发送新短信"
        visible={composeOpen}
        footer={null}
        width={440}
        onCancel={() => {
          setComposeOpen(false);
          setComposeTo('');
          setComposeBody('');
        }}
      >
        <Space vertical spacing={14} className="sms-compose-form">
          <Input placeholder="请输入接收号码" value={composeTo} onChange={(value) => setComposeTo(value)} />
          <TextArea
            value={composeBody}
            onChange={setComposeBody}
            placeholder="请输入短信内容"
            autosize={{ minRows: 3, maxRows: 6 }}
          />
          <Button
            theme="solid"
            type="primary"
            block
            icon={<IconSend />}
            loading={sending}
            onClick={async () => {
              if (await send(composeTo, composeBody)) {
                setComposeOpen(false);
                setComposeTo('');
                setComposeBody('');
                await load();
              }
            }}
          >
            立即发送
          </Button>
        </Space>
      </Modal>
    </div>
  );
};

export default Sms;
