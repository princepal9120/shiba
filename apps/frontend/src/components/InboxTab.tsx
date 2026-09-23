/**
 * InboxTab — workspace-pane inbox: registered mailboxes, their mail, and the
 * drafts awaiting a send decision. All data comes from the /api/mailboxes,
 * /api/emails*, /api/threads/:id, and /api/drafts* routes, which proxy the
 * Mailbox Durable Objects; "Send for approval" queues an approval rather
 * than transmitting anything.
 */
import { useCallback, useEffect, useRef, useState, type JSX } from "react";
import type {
  InboxAttachment,
  InboxDraft,
  InboxEmail,
  InboxMailbox,
  InboxThread,
} from "../types";
import { formatTimeAgo } from "../ui-helpers";

const GHOST_BUTTON =
  "text-[11px] bg-transparent hover:bg-[#fffef8] border border-[#e0ded5] hover:border-[#d3d2c8] text-[#6a6f63] hover:text-[#222320] font-medium py-1 px-2.5 touch:min-h-11 rounded-md transition-colors";
const ACCENT_BUTTON =
  "text-[11px] bg-[#0000a8]/10 hover:bg-[#0000a8]/15 border border-[#0000a8]/15 text-[#1c1cc8] font-medium py-1 px-2.5 touch:min-h-11 rounded-md transition-colors";

async function apiJson<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, init);
  const body = (await response.json().catch(() => ({}))) as T & { error?: string };
  if (!response.ok) {
    throw new Error(typeof body.error === "string" ? body.error : `Request failed: ${response.status}`);
  }
  return body;
}

/** Email statuses aren't run statuses — map them onto the same chip palette. */
function emailChipClass(status: string): string {
  switch (status) {
    case "unread":
      return "text-[#0000a8] border-[#0000a8]/30 bg-[#0000a8]/10";
    case "sent":
      return "text-[#15803d] border-[#15803d]/30 bg-[#15803d]/10";
    case "deleted":
      return "text-[#fb2c36] border-[#fb2c36]/30 bg-[#fb2c36]/10";
    default:
      return "text-[#6a6f63] border-[#e0ded5] bg-[#fffef8]";
  }
}

function draftChipClass(status: string): string {
  switch (status) {
    case "draft":
      return "text-[#b45309] border-[#f99c00]/40 bg-[#f99c00]/10";
    case "queued":
      return "text-[#0000a8] border-[#0000a8]/30 bg-[#0000a8]/10";
    case "sent":
      return "text-[#15803d] border-[#15803d]/30 bg-[#15803d]/10";
    default:
      return "text-[#6a6f63] border-[#e0ded5] bg-[#fffef8]";
  }
}

/** Where a reply to this email goes: inbound mail answers its sender. */
export function replyAddress(email: InboxEmail): string {
  return email.direction === "inbound" ? email.from_addr : email.to_addr;
}

/**
 * Mailbox a reply draft should be attributed to. The detail route returns
 * the owning mailbox at top level (`StoredEmail` carries none); the row's
 * `mailbox` tag only exists on fan-out list responses, so the "All
 * mailboxes" view must not rely on it.
 */
export function replyMailbox(
  detail: { mailbox: string | null; email: InboxEmail } | null,
  mailboxFilter: string,
): string {
  return detail?.mailbox ?? detail?.email.mailbox ?? mailboxFilter;
}

function replySubject(subject: string): string {
  return /^\s*re:/i.test(subject) ? subject : `Re: ${subject}`;
}

export interface InboxTabProps {
  /** Jumps to the Approvals tab so a queued send is one click away. */
  onOpenApprovals: () => void;
}

export function InboxTab({ onOpenApprovals }: InboxTabProps): JSX.Element {
  const [mailboxes, setMailboxes] = useState<InboxMailbox[] | null>(null);
  const [mailbox, setMailbox] = useState("");
  const [emails, setEmails] = useState<InboxEmail[]>([]);
  const [drafts, setDrafts] = useState<InboxDraft[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [searching, setSearching] = useState(false);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<{ mailbox: string | null; email: InboxEmail; attachments: InboxAttachment[] } | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [thread, setThread] = useState<InboxThread | null>(null);
  const [threadLoading, setThreadLoading] = useState(false);
  const [replyBody, setReplyBody] = useState("");
  const [replyOpen, setReplyOpen] = useState(false);
  const [actionBusy, setActionBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  // The email id the in-flight detail fetch belongs to — a slower reply
  // landing after a newer expand would otherwise paint A's body on B's row
  // and aim B's reply draft at A's sender.
  const detailRequestRef = useRef<string | null>(null);
  const [registerOpen, setRegisterOpen] = useState(false);
  const [newAddress, setNewAddress] = useState("");
  const [newLabel, setNewLabel] = useState("");
  const [registerError, setRegisterError] = useState<string | null>(null);
  const [registerNotice, setRegisterNotice] = useState<string | null>(null);

  const loadMailboxes = useCallback(async () => {
    try {
      const body = await apiJson<{ mailboxes?: InboxMailbox[] }>("/api/mailboxes");
      setMailboxes(Array.isArray(body.mailboxes) ? body.mailboxes : []);
    } catch {
      setMailboxes((current) => current ?? []);
    }
  }, []);

  useEffect(() => {
    void loadMailboxes();
  }, [loadMailboxes]);

  const registerMailbox = useCallback(async () => {
    const address = newAddress.trim();
    if (address === "") {
      setRegisterError("Enter the mailbox address to register.");
      return;
    }
    setActionBusy("register");
    setRegisterError(null);
    setRegisterNotice(null);
    try {
      const label = newLabel.trim();
      await apiJson<{ mailbox?: InboxMailbox }>("/api/mailboxes", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(label === "" ? { address } : { address, label }),
      });
      setRegisterNotice(`Registered ${address}.`);
      setNewAddress("");
      setNewLabel("");
      setRegisterOpen(false);
      await loadMailboxes();
    } catch (err) {
      setRegisterError(err instanceof Error ? err.message : String(err));
    } finally {
      setActionBusy(null);
    }
  }, [newAddress, newLabel, loadMailboxes]);

  const loadMail = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const mailboxParam = mailbox === "" ? "" : `mailbox=${encodeURIComponent(mailbox)}&`;
      const [emailsBody, draftsBody] = await Promise.all([
        apiJson<{ emails?: InboxEmail[] }>(`/api/emails?${mailboxParam}limit=50`),
        apiJson<{ drafts?: InboxDraft[] }>(`/api/drafts?${mailboxParam}limit=50`),
      ]);
      setEmails(Array.isArray(emailsBody.emails) ? emailsBody.emails : []);
      setDrafts(Array.isArray(draftsBody.drafts) ? draftsBody.drafts : []);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [mailbox]);

  useEffect(() => {
    void loadMail();
  }, [loadMail]);

  const runSearch = useCallback(async () => {
    const q = search.trim();
    if (q === "") {
      return;
    }
    setSearching(true);
    setError(null);
    try {
      const mailboxParam = mailbox === "" ? "" : `&mailbox=${encodeURIComponent(mailbox)}`;
      const body = await apiJson<{ emails?: InboxEmail[] }>(
        `/api/emails-search?q=${encodeURIComponent(q)}${mailboxParam}&limit=50`,
      );
      setEmails(Array.isArray(body.emails) ? body.emails : []);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSearching(false);
    }
  }, [search, mailbox]);

  const toggleExpanded = useCallback(
    async (email: InboxEmail) => {
      if (expandedId === email.id) {
        detailRequestRef.current = null;
        setExpandedId(null);
        setDetail(null);
        setThread(null);
        setReplyOpen(false);
        return;
      }
      detailRequestRef.current = email.id;
      setExpandedId(email.id);
      setDetail(null);
      setThread(null);
      setReplyOpen(false);
      setReplyBody("");
      setDetailLoading(true);
      try {
        const body = await apiJson<{ mailbox?: string; email: InboxEmail; attachments?: InboxAttachment[] }>(
          `/api/emails/${encodeURIComponent(email.id)}`,
        );
        if (detailRequestRef.current !== email.id) return;
        setDetail({ mailbox: body.mailbox ?? null, email: body.email, attachments: body.attachments ?? [] });
        if (email.status === "unread") {
          setEmails((prev) =>
            prev.map((row) => (row.id === email.id ? { ...row, status: "read" } : row)),
          );
          apiJson(`/api/emails/${encodeURIComponent(email.id)}/read`, { method: "POST" }).catch(
            () => {},
          );
        }
      } catch (err) {
        if (detailRequestRef.current === email.id) {
          setError(err instanceof Error ? err.message : String(err));
        }
      } finally {
        if (detailRequestRef.current === email.id) {
          setDetailLoading(false);
        }
      }
    },
    [expandedId],
  );

  const toggleThread = useCallback(async () => {
    if (thread !== null) {
      setThread(null);
      return;
    }
    if (detail === null || !detail.email.thread_id) return;
    const detailFor = detail.email.id;
    setThreadLoading(true);
    try {
      const body = await apiJson<{ thread: InboxThread }>(
        `/api/threads/${encodeURIComponent(detail.email.thread_id)}`,
      );
      if (detailRequestRef.current === detailFor) {
        setThread(body.thread);
      }
    } catch (err) {
      if (detailRequestRef.current === detailFor) {
        setError(err instanceof Error ? err.message : String(err));
      }
    } finally {
      setThreadLoading(false);
    }
  }, [thread, detail]);

  const saveReply = useCallback(async () => {
    if (detail === null || replyBody.trim() === "") return;
    const mailboxAddress = replyMailbox(detail, mailbox);
    if (mailboxAddress === "") {
      setError("Pick a mailbox in the filter to reply from.");
      return;
    }
    setActionBusy("reply");
    setError(null);
    try {
      await apiJson("/api/drafts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          mailbox: mailboxAddress,
          to_addr: replyAddress(detail.email),
          subject: replySubject(detail.email.subject),
          body_text: replyBody,
          thread_id: detail.email.thread_id,
          in_reply_to_email_id: detail.email.id,
        }),
      });
      setNotice("Reply saved to drafts.");
      setReplyOpen(false);
      setReplyBody("");
      await loadMail();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setActionBusy(null);
    }
  }, [detail, mailbox, replyBody, loadMail]);

  const sendDraft = useCallback(
    async (draft: InboxDraft) => {
      setActionBusy(draft.id);
      setError(null);
      try {
        await apiJson(`/api/drafts/${encodeURIComponent(draft.id)}/send`, { method: "POST" });
        setNotice("Queued for approval — review it in the Approvals tab.");
        setDrafts((prev) =>
          prev.map((row) => (row.id === draft.id ? { ...row, status: "queued" } : row)),
        );
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setActionBusy(null);
      }
    },
    [],
  );

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center gap-2">
        <select
          value={mailbox}
          onChange={(event) => setMailbox(event.target.value)}
          aria-label="Mailbox"
          className="flex-1 min-w-0 text-[11px] font-mono bg-[#fffef8] border border-[#e0ded5] rounded-md px-2 py-1.5 text-[#222320] focus:outline-none focus:border-[#0000a8]/50"
        >
          <option value="">All mailboxes</option>
          {(mailboxes ?? []).map((record) => (
            <option key={record.address} value={record.address}>
              {record.label ?? record.address}
            </option>
          ))}
        </select>
        <button
          type="button"
          onClick={() => void loadMail()}
          title="Refresh inbox"
          className="text-[11px] text-[#6a6f63] hover:text-[#222320] border border-[#e0ded5] hover:border-[#d3d2c8] rounded-md px-2 py-1 touch:min-h-11 transition-colors"
        >
          Refresh
        </button>
        <button
          type="button"
          onClick={() => {
            setRegisterOpen((open) => !open);
            setRegisterError(null);
            setRegisterNotice(null);
          }}
          aria-expanded={registerOpen}
          title="Register a mailbox"
          className={`${ACCENT_BUTTON} shrink-0`}
        >
          + Mailbox
        </button>
      </div>

      {registerOpen ? (
        <form
          aria-label="Register mailbox"
          onSubmit={(event) => {
            event.preventDefault();
            void registerMailbox();
          }}
          className="flex flex-col gap-2 border border-[#e0ded5] rounded-xl bg-[#f6f4ed] p-3"
        >
          <h4 className="text-[10px] font-bold uppercase tracking-wider text-[#6a6f63]">
            Register mailbox
          </h4>
          <input
            type="email"
            required
            value={newAddress}
            onChange={(event) => setNewAddress(event.target.value)}
            placeholder="agent@yourdomain.com"
            aria-label="Mailbox address"
            autoComplete="off"
            className="w-full text-[11px] font-mono bg-[#fffef8] border border-[#e0ded5] rounded-md px-2 py-1.5 text-[#222320] placeholder:text-[#6a6f63] focus:outline-none focus:border-[#0000a8]/50"
          />
          <input
            type="text"
            value={newLabel}
            onChange={(event) => setNewLabel(event.target.value)}
            placeholder="Label (optional)"
            aria-label="Mailbox label"
            className="w-full text-[11px] bg-[#fffef8] border border-[#e0ded5] rounded-md px-2 py-1.5 text-[#222320] placeholder:text-[#6a6f63] focus:outline-none focus:border-[#0000a8]/50"
          />
          {registerError !== null ? (
            <p role="alert" className="text-[11px] text-[#fb2c36] break-words">
              {registerError}
            </p>
          ) : null}
          <div className="flex items-center justify-end gap-2">
            <button type="button" className={GHOST_BUTTON} onClick={() => setRegisterOpen(false)}>
              Cancel
            </button>
            <button type="submit" className={ACCENT_BUTTON} disabled={actionBusy === "register"}>
              {actionBusy === "register" ? "Registering…" : "Register"}
            </button>
          </div>
        </form>
      ) : null}
      {registerNotice !== null ? (
        <p role="status" className="text-[11px] text-[#15803d] bg-[#15803d]/10 border border-[#15803d]/20 rounded-lg px-2.5 py-2">
          {registerNotice}
        </p>
      ) : null}

      <form
        onSubmit={(event) => {
          event.preventDefault();
          void runSearch();
        }}
        className="flex items-center gap-2"
      >
        <input
          type="search"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          placeholder="Search mail…"
          className="flex-1 min-w-0 text-[11px] font-mono bg-[#fffef8] border border-[#e0ded5] rounded-md px-2 py-1.5 text-[#222320] placeholder:text-[#6a6f63] focus:outline-none focus:border-[#0000a8]/50"
        />
        <button type="submit" disabled={searching} className={ACCENT_BUTTON}>
          {searching ? "Searching…" : "Search"}
        </button>
        {search.trim() !== "" ? (
          <button
            type="button"
            onClick={() => {
              setSearch("");
              void loadMail();
            }}
            className="text-[11px] text-[#6a6f63] hover:text-[#222320]"
          >
            Clear
          </button>
        ) : null}
      </form>

      {notice !== null ? (
        <p className="text-[11px] text-[#15803d] bg-[#15803d]/10 border border-[#15803d]/20 rounded-lg px-2.5 py-2 flex items-center justify-between gap-2">
          <span>{notice}</span>
          <button type="button" className="text-[#1c1cc8] underline shrink-0" onClick={onOpenApprovals}>
            Approvals →
          </button>
        </p>
      ) : null}
      {error !== null ? (
        <p className="text-[11px] text-[#fb2c36] bg-[#fb2c36]/10 border border-[#fb2c36]/20 rounded-lg px-2.5 py-2">
          {error}
        </p>
      ) : null}

      {drafts.length > 0 ? (
        <div className="flex flex-col gap-2">
          <h4 className="text-[10px] font-bold uppercase tracking-wider text-[#b45309]">
            Drafts
          </h4>
          {drafts.map((draft) => (
            <div
              key={draft.id}
              className="border border-[#e0ded5] border-l-2 border-l-[#f99c00] rounded-xl bg-[#f6f4ed] p-3"
            >
              <div className="flex items-start justify-between gap-2 mb-1">
                <div className="min-w-0">
                  <p className="font-mono text-[11px] text-[#222320] truncate">to {draft.to_addr}</p>
                  <p className="text-[11px] text-[#222320] truncate font-medium">{draft.subject}</p>
                </div>
                <span
                  className={`text-[10px] font-bold uppercase tracking-wider border rounded-full px-2 py-0.5 shrink-0 ${draftChipClass(draft.status)}`}
                >
                  {draft.status}
                </span>
              </div>
              <p className="text-[11px] text-[#6a6f63] font-mono truncate mb-1.5">
                {draft.body_text}
              </p>
              <div className="flex items-center justify-between gap-2">
                <span className="text-[10px] text-[#6a6f63] font-mono">
                  {draft.mailbox ?? ""} · {formatTimeAgo(draft.updated_at)}
                </span>
                {draft.status === "draft" ? (
                  <button
                    type="button"
                    className={ACCENT_BUTTON}
                    disabled={actionBusy === draft.id}
                    onClick={() => void sendDraft(draft)}
                  >
                    {actionBusy === draft.id ? "Queueing…" : "Send for approval"}
                  </button>
                ) : null}
              </div>
            </div>
          ))}
        </div>
      ) : null}

      {loading ? (
        <div className="flex flex-col items-center justify-center py-8 border border-dashed border-[#e0ded5] rounded-xl bg-[#f6f4ed] px-4 text-center">
          <p className="text-[#6a6f63] text-xs">Loading mail…</p>
        </div>
      ) : emails.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-8 border border-dashed border-[#e0ded5] rounded-xl bg-[#f6f4ed] px-4 text-center">
          <p className="text-[#6a6f63] text-xs">
            {mailboxes !== null && mailboxes.length === 0
              ? "No mailboxes registered yet. Register an address before Email Routing can deliver."
              : "No mail."}
          </p>
        </div>
      ) : (
        <ol className="flex flex-col gap-2">
          {emails.map((email) => {
            const expanded = expandedId === email.id;
            return (
              <li
                key={email.id}
                className={`border rounded-xl bg-[#f6f4ed] overflow-hidden transition-colors ${
                  expanded ? "border-[#0000a8]/50" : "border-[#e0ded5] hover:border-[#d3d2c8]"
                }`}
              >
                <button
                  type="button"
                  onClick={() => void toggleExpanded(email)}
                  className="w-full text-left p-3 hover:bg-[#fffef8] transition-colors"
                >
                  <div className="flex items-center gap-2 min-w-0">
                    <span
                      className={`size-1.5 rounded-full shrink-0 ${
                        email.status === "unread" ? "bg-[#0000a8]" : "bg-transparent"
                      }`}
                      title={email.status}
                    />
                    <span
                      className={`text-[11px] truncate min-w-0 ${
                        email.status === "unread" ? "text-[#222320] font-semibold" : "text-[#6a6f63]"
                      }`}
                    >
                      {email.from_addr}
                    </span>
                    <span className="text-[10px] text-[#6a6f63] font-mono shrink-0 ml-auto">
                      {formatTimeAgo(email.created_at)}
                    </span>
                  </div>
                  <p
                    className={`text-[11px] truncate mt-0.5 pl-3.5 ${
                      email.status === "unread" ? "text-[#222320] font-medium" : "text-[#6a6f63]"
                    }`}
                  >
                    {email.subject}
                  </p>
                </button>
                {expanded ? (
                  <div className="p-3 pt-1 border-t border-[#e0ded5]/60 flex flex-col gap-2">
                    {detailLoading ? (
                      <p className="text-[11px] text-[#6a6f63] font-mono">Loading…</p>
                    ) : detail !== null ? (
                      <>
                        <div className="text-[10px] text-[#6a6f63] font-mono flex flex-wrap gap-x-3 gap-y-1">
                          <span>from {detail.email.from_addr}</span>
                          <span>to {detail.email.to_addr}</span>
                          {email.mailbox ? <span>box {email.mailbox}</span> : null}
                          <span className={`border rounded-full px-1.5 ${emailChipClass(detail.email.status)}`}>
                            {detail.email.status}
                          </span>
                        </div>
                        <pre className="font-mono text-[11px] text-[#222320] bg-[#fffef8] p-2.5 rounded-lg border border-[#e0ded5] whitespace-pre-wrap break-words max-h-48 overflow-auto">
                          {detail.email.body_text ?? "(no plain-text body)"}
                        </pre>
                        {detail.attachments.length > 0 ? (
                          <div className="flex flex-wrap gap-1">
                            {detail.attachments.map((attachment) => (
                              <span
                                key={attachment.part_id}
                                className="text-[10px] font-mono text-[#6a6f63] border border-[#e0ded5] bg-[#fffef8] rounded-md px-1.5 py-0.5"
                              >
                                {attachment.filename ?? attachment.part_id}
                              </span>
                            ))}
                          </div>
                        ) : null}
                        <div className="flex items-center gap-2 flex-wrap">
                          <button type="button" className={GHOST_BUTTON} onClick={() => void toggleThread()}>
                            {threadLoading ? "Loading…" : thread !== null ? "Hide thread" : "Thread"}
                          </button>
                          <button
                            type="button"
                            className={ACCENT_BUTTON}
                            onClick={() => setReplyOpen((open) => !open)}
                          >
                            Draft reply
                          </button>
                        </div>
                        {thread !== null ? (
                          <ol className="flex flex-col gap-1.5 border-l-2 border-[#e0ded5] pl-2.5">
                            {thread.emails.map((item) => (
                              <li key={item.id} className="text-[10px] font-mono text-[#6a6f63]">
                                <span className="text-[#222320]">{item.from_addr}</span> ·{" "}
                                {formatTimeAgo(item.created_at)} · {item.subject}
                              </li>
                            ))}
                          </ol>
                        ) : null}
                        {replyOpen ? (
                          <div className="flex flex-col gap-2">
                            <p className="text-[10px] font-mono text-[#6a6f63]">
                              to {replyAddress(detail.email)} · {replySubject(detail.email.subject)}
                            </p>
                            <textarea
                              value={replyBody}
                              onChange={(event) => setReplyBody(event.target.value)}
                              rows={4}
                              placeholder="Write the reply…"
                              className="w-full text-[11px] font-mono bg-[#fffef8] border border-[#e0ded5] rounded-lg px-2.5 py-2 text-[#222320] placeholder:text-[#6a6f63] focus:outline-none focus:border-[#0000a8]/50"
                            />
                            <div className="flex items-center gap-2">
                              <button
                                type="button"
                                className={ACCENT_BUTTON}
                                disabled={actionBusy === "reply" || replyBody.trim() === ""}
                                onClick={() => void saveReply()}
                              >
                                {actionBusy === "reply" ? "Saving…" : "Save draft"}
                              </button>
                              <button
                                type="button"
                                className={GHOST_BUTTON}
                                onClick={() => setReplyOpen(false)}
                              >
                                Cancel
                              </button>
                            </div>
                          </div>
                        ) : null}
                      </>
                    ) : null}
                  </div>
                ) : null}
              </li>
            );
          })}
        </ol>
      )}
    </div>
  );
}
