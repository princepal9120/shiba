/**
 * InboxTab — workspace-pane inbox: registered mailboxes, their mail, and the
 * drafts awaiting a send decision. All data comes from the /api/mailboxes,
 * /api/emails*, /api/threads/:id, and /api/drafts* routes, which proxy the
 * Mailbox Durable Objects; "Send for approval" queues an approval rather
 * than transmitting anything.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type JSX } from "react";
import type {
  InboxAttachment,
  InboxDraft,
  InboxEmail,
  InboxMailbox,
  InboxThread,
} from "../types";
import { formatTimeAgo } from "../ui-helpers";

const GHOST_BUTTON =
  "text-[11px] bg-transparent hover:bg-[#fffef8] border border-[#e0ded5] hover:border-[#d3d2c8] text-[#6a6f63] hover:text-[#222320] font-medium py-1.5 px-3 touch:min-h-11 rounded-none transition-colors inline-flex items-center justify-center gap-1.5";
const ACCENT_BUTTON =
  "text-[11px] bg-[#0000a8] hover:bg-[#1c1cc8] text-[#fffef8] font-medium py-1.5 px-3 touch:min-h-11 rounded-none transition-colors shadow-[2px_2px_0_var(--paper-shadow)] inline-flex items-center justify-center gap-1.5 disabled:opacity-50 disabled:cursor-not-allowed";
const SECONDARY_BUTTON =
  "text-[11px] bg-[#0000a8]/10 hover:bg-[#0000a8]/15 border border-[#0000a8]/20 text-[#1c1cc8] font-medium py-1.5 px-3 touch:min-h-11 rounded-none transition-colors inline-flex items-center justify-center gap-1.5 disabled:opacity-50";

async function apiJson<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, init);
  const body = (await response.json().catch(() => ({}))) as T & { error?: string };
  if (!response.ok) {
    throw new Error(typeof body.error === "string" ? body.error : `Request failed: ${response.status}`);
  }
  return body;
}

/** Email statuses mapped to the warm dashboard palette. */
function emailChipClass(status: string): string {
  switch (status) {
    case "unread":
      return "text-[#0000a8] border-[#0000a8]/30 bg-[#0000a8]/10 font-semibold";
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

function formatBytes(bytes?: number): string {
  if (bytes === undefined || bytes === null || Number.isNaN(bytes)) return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
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
  const [filterView, setFilterView] = useState<"all" | "unread" | "drafts">("all");
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<{ mailbox: string | null; email: InboxEmail; attachments: InboxAttachment[] } | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [thread, setThread] = useState<InboxThread | null>(null);
  const [threadLoading, setThreadLoading] = useState(false);
  const [replyBody, setReplyBody] = useState("");
  const [replyOpen, setReplyOpen] = useState(false);
  const [actionBusy, setActionBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  // Settings & Two-Step Pairing State
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [pairingStep, setPairingStep] = useState<1 | 2>(1);
  const [newAddress, setNewAddress] = useState("");
  const [newLabel, setNewLabel] = useState("");
  const [newAgent, setNewAgent] = useState("");
  const [registerError, setRegisterError] = useState<string | null>(null);
  const [registerNotice, setRegisterNotice] = useState<string | null>(null);

  // The email id the in-flight detail fetch belongs to — prevents racing responses.
  const detailRequestRef = useRef<string | null>(null);

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
      void loadMail();
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
  }, [search, mailbox, loadMail]);

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
      const agent = newAgent.trim();
      if (agent !== "" && (agent.length > 128 || /\s/.test(agent))) {
        setRegisterError("Agent principal must match the token name (no whitespace, max 128 characters).");
        return;
      }
      const result = await apiJson<{ mailbox?: InboxMailbox }>("/api/mailboxes", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ address, ...(label === "" ? {} : { label }), agent: agent || null }),
      });
      const assigned = result.mailbox?.agent;
      setRegisterNotice(assigned
        ? `Registered ${address} for agent ${assigned}. Configure Email Routing and test delivery before using it.`
        : `Registered ${address} for dashboard use. Configure Email Routing and test delivery before using it.`);
      setNewAddress("");
      setNewLabel("");
      setNewAgent("");
      setPairingStep(1);
      setSettingsOpen(false);
      await loadMailboxes();
    } catch (err) {
      setRegisterError(err instanceof Error ? err.message : String(err));
    } finally {
      setActionBusy(null);
    }
  }, [newAddress, newLabel, newAgent, loadMailboxes]);

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
      setNotice("Reply saved to drafts. It will require approval before sending.");
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
        setNotice("Draft locked & queued for human approval — review it in the Approvals tab.");
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

  // Computed metrics
  const unreadCount = useMemo(() => emails.filter((e) => e.status === "unread").length, [emails]);
  const queuedDraftsCount = useMemo(() => drafts.filter((d) => d.status === "queued").length, [drafts]);
  const pendingDraftsCount = useMemo(() => drafts.filter((d) => d.status === "draft").length, [drafts]);

  // Filtered emails based on tab selection
  const displayedEmails = useMemo(() => {
    if (filterView === "unread") {
      return emails.filter((e) => e.status === "unread");
    }
    return emails;
  }, [emails, filterView]);

  return (
    <div className="flex flex-col gap-3.5 max-w-full">
      {/* Activity & System Summary Bar */}
      <section
        aria-label="Mailbox activity summary"
        className="bg-[#fffef8] border border-[#e0ded5] rounded-none p-3 shadow-[2px_2px_0_var(--paper-shadow)]"
      >
        <div className="flex items-center justify-between gap-3 flex-wrap">
          <div className="flex items-center gap-4 flex-wrap">
            <div className="flex items-center gap-2">
              <span className="text-[10px] font-mono uppercase tracking-wider text-[#6a6f63]">Mailboxes:</span>
              <span className="font-mono text-xs font-semibold text-[#222320]">
                {mailboxes === null ? "…" : mailboxes.length}
              </span>
            </div>
            <div className="flex items-center gap-2">
              <span className="text-[10px] font-mono uppercase tracking-wider text-[#6a6f63]">Unread:</span>
              <span className={`font-mono text-xs font-semibold ${unreadCount > 0 ? "text-[#0000a8]" : "text-[#222320]"}`}>
                {unreadCount}
              </span>
            </div>
            <div className="flex items-center gap-2">
              <span className="text-[10px] font-mono uppercase tracking-wider text-[#6a6f63]">Drafts:</span>
              <span className="font-mono text-xs font-semibold text-[#b45309]">
                {pendingDraftsCount}
                {queuedDraftsCount > 0 ? (
                  <span className="text-[10px] font-normal text-[#0000a8] ml-1">({queuedDraftsCount} queued)</span>
                ) : null}
              </span>
            </div>
          </div>

          <div className="flex items-center gap-2 ml-auto">
            <span
              className="text-[10px] font-mono text-[#15803d] bg-[#15803d]/10 border border-[#15803d]/20 px-2 py-0.5 rounded-none inline-flex items-center gap-1"
              title="Cloudflare Email Routing + Mailbox Durable Objects"
            >
              <span className="size-1.5 rounded-none bg-[#15803d]" />
              Approval-Gated Send
            </span>
            <button
              type="button"
              onClick={() => {
                setSettingsOpen((prev) => !prev);
                setRegisterError(null);
                setRegisterNotice(null);
              }}
              aria-expanded={settingsOpen}
              className={settingsOpen ? ACCENT_BUTTON : SECONDARY_BUTTON}
            >
              ⚙ Mailbox Settings
            </button>
          </div>
        </div>

        {/* Expandable Settings-First Two-Step Pairing Panel */}
        {settingsOpen ? (
          <div className="mt-3 pt-3 border-t border-[#e0ded5] flex flex-col gap-3">
            <div className="flex items-start justify-between gap-4">
              <div>
                <h4 className="text-xs font-semibold text-[#222320]">
                  Agent Mailbox Configuration &amp; Pairing
                </h4>
                <p className="text-[11px] text-[#6a6f63] mt-0.5 max-w-xl">
                  Connect inbound routing addresses to isolated Mailbox Durable Objects. All outbound communications require human verification via the Approvals queue. No provider credentials exist inside execution sandboxes.
                </p>
              </div>
              <button
                type="button"
                onClick={() => setSettingsOpen(false)}
                className="text-xs text-[#6a6f63] hover:text-[#222320]"
                aria-label="Close settings"
              >
                ✕
              </button>
            </div>

            {/* Currently Configured Mailboxes (Paired Lines) */}
            <div className="bg-[#f6f4ed] border border-[#e0ded5] rounded-none p-2.5">
              <h5 className="text-[10px] font-mono uppercase tracking-wider text-[#6a6f63] mb-1.5">
                Active Mailbox Lines
              </h5>
              {mailboxes === null || mailboxes.length === 0 ? (
                <p className="text-[11px] text-[#6a6f63] italic">No mailboxes registered yet.</p>
              ) : (
                <div className="flex flex-col gap-1.5">
                  {mailboxes.map((mb) => (
                    <div
                      key={mb.address}
                      className="flex items-center justify-between gap-2 text-[11px] bg-[#fffef8] border border-[#e0ded5] rounded-none px-2.5 py-1.5"
                    >
                      <div className="flex items-center gap-2 min-w-0">
                        <span className="size-2 rounded-none bg-[#15803d]" />
                        <span className="font-mono font-medium text-[#222320] truncate">{mb.address}</span>
                        {mb.label ? (
                          <span className="text-[10px] text-[#6a6f63] bg-[#f6f4ed] border border-[#e0ded5] rounded-none px-1.5 py-0.2">
                            {mb.label}
                          </span>
                        ) : null}
                      </div>
                      <span className="text-[10px] font-mono text-[#6a6f63] shrink-0">
                        {mb.agent ? `agent: ${mb.agent}` : "dashboard only"} · registered {formatTimeAgo(mb.created_at)}
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </div>

            {/* Two-Step Pairing Form */}
            <div className="border border-[#0000a8]/20 bg-[#0000a8]/5 rounded-none p-3 flex flex-col gap-2.5">
              <div className="flex items-center justify-between">
                <span className="text-[10px] font-mono uppercase font-bold tracking-wider text-[#1c1cc8]">
                  {pairingStep === 1 ? "Step 1: Define Mailbox Identity" : "Step 2: Security & Privacy Verification"}
                </span>
                <div className="flex items-center gap-1 text-[10px] font-mono text-[#6a6f63]">
                  <span className={`size-2 rounded-none ${pairingStep === 1 ? "bg-[#0000a8]" : "bg-[#15803d]"}`} />
                  <span>Step {pairingStep} of 2</span>
                </div>
              </div>

              {pairingStep === 1 ? (
                <div className="flex flex-col gap-2">
                  <p className="text-[11px] text-[#222320]">
                    Register the address for this mailbox. Incoming mail is stored only after Cloudflare Email Routing is configured to deliver it to this Worker.
                  </p>
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                    <div>
                      <label className="text-[10px] font-mono text-[#6a6f63] block mb-1">
                        Mailbox Address *
                      </label>
                      <input
                        type="email"
                        required
                        value={newAddress}
                        onChange={(e) => setNewAddress(e.target.value)}
                        placeholder="agent@shiba.dev"
                        aria-label="Mailbox address"
                        className="w-full text-[11px] font-mono bg-[#fffef8] border border-[#e0ded5] rounded-none px-2.5 py-1.5 text-[#222320] placeholder:text-[#6a6f63] focus:outline-none focus:border-[#0000a8]"
                      />
                    </div>
                    <div>
                      <label className="text-[10px] font-mono text-[#6a6f63] block mb-1">
                        Display label (optional)
                      </label>
                      <input
                        type="text"
                        value={newLabel}
                        onChange={(e) => setNewLabel(e.target.value)}
                        placeholder="e.g. Primary Assistant"
                        aria-label="Mailbox label"
                        className="w-full text-[11px] bg-[#fffef8] border border-[#e0ded5] rounded-none px-2.5 py-1.5 text-[#222320] placeholder:text-[#6a6f63] focus:outline-none focus:border-[#0000a8]"
                      />
                    </div>
                    <div className="sm:col-span-2">
                      <label className="text-[10px] font-mono text-[#6a6f63] block mb-1">
                        Cloud agent token principal (optional)
                      </label>
                      <input
                        type="text"
                        value={newAgent}
                        onChange={(e) => setNewAgent(e.target.value)}
                        maxLength={128}
                        placeholder="e.g. claude-code (from mint-token --agent)"
                        aria-label="Cloud agent token principal"
                        className="w-full text-[11px] font-mono bg-[#fffef8] border border-[#e0ded5] rounded-none px-2.5 py-1.5 text-[#222320] placeholder:text-[#6a6f63] focus:outline-none focus:border-[#0000a8]"
                      />
                      <p className="text-[10px] text-[#6a6f63] mt-1">Leave blank for dashboard-only mail. Re-enter an existing address to assign or change its agent.</p>
                    </div>
                  </div>

                  {registerError !== null ? (
                    <p role="alert" className="text-[11px] text-[#fb2c36]">
                      {registerError}
                    </p>
                  ) : null}

                  <div className="flex justify-end gap-2 mt-1">
                    <button
                      type="button"
                      className={ACCENT_BUTTON}
                      disabled={newAddress.trim() === ""}
                      onClick={() => {
                        if (newAddress.trim() === "") {
                          setRegisterError("Please enter an email address.");
                          return;
                        }
                        setRegisterError(null);
                        setPairingStep(2);
                      }}
                    >
                      Next: Review Policies →
                    </button>
                  </div>
                </div>
              ) : (
                <div className="flex flex-col gap-2.5">
                  <div className="bg-[#fffef8] border border-[#e0ded5] rounded-none p-2.5 text-[11px] text-[#222320] flex flex-col gap-1.5">
                    <div className="flex items-center gap-2">
                      <span className="font-semibold">Selected Address:</span>
                      <span className="font-mono text-[#0000a8]">{newAddress}</span>
                      {newLabel ? <span className="text-[#6a6f63]">({newLabel})</span> : null}
                    </div>
                    <div>Cloud agent: <span className="font-mono">{newAgent.trim() || "dashboard only"}</span></div>
                    <div className="text-[10px] text-[#6a6f63] space-y-1 mt-1 border-t border-[#e0ded5] pt-1.5">
                      <p>✓ <strong>Approval-Gated Outbound:</strong> Every draft created by agents requires explicit human sign-off prior to external delivery.</p>
                      <p>✓ <strong>Zero Sandbox Secrets:</strong> Sandboxes cannot access provider credentials or SMTP servers directly.</p>
                      <p>✓ <strong>Isolated Storage:</strong> State is sealed in Cloudflare Durable Objects under sovereign tenancy.</p>
                    </div>
                  </div>

                  {registerError !== null ? (
                    <p role="alert" className="text-[11px] text-[#fb2c36]">
                      {registerError}
                    </p>
                  ) : null}

                  <div className="flex justify-end gap-2">
                    <button
                      type="button"
                      className={GHOST_BUTTON}
                      onClick={() => setPairingStep(1)}
                    >
                      ← Back
                    </button>
                    <button
                      type="button"
                      className={ACCENT_BUTTON}
                      disabled={actionBusy === "register"}
                      onClick={() => void registerMailbox()}
                    >
                      {actionBusy === "register" ? "Registering…" : "Register Mailbox"}
                    </button>
                  </div>
                </div>
              )}
            </div>
          </div>
        ) : null}

        {registerNotice !== null ? (
          <p role="status" className="mt-2 text-[11px] text-[#15803d] bg-[#15803d]/10 border border-[#15803d]/20 rounded-none px-2.5 py-1.5">
            {registerNotice}
          </p>
        ) : null}
      </section>

      <details open={mailboxes?.length === 0} className="border border-[#0000a8]/25 bg-[#0000a8]/5 p-3 text-xs text-[#222320]">
        <summary className="cursor-pointer font-semibold">First mailbox: from setup to a received message</summary>
        <ol className="mt-2 ml-4 list-decimal space-y-1.5 text-[#6a6f63]">
          <li><button type="button" onClick={() => setSettingsOpen(true)} className="text-[#0000a8] hover:underline">Register a mailbox</button> and assign the exact MCP token principal.</li>
          <li><a href="/docs/api/#email-api" className="text-[#0000a8] hover:underline">Configure Cloudflare Email Routing</a> for that address to this Worker. Registration does not configure routing.</li>
          <li><a href="/?tab=agents" className="text-[#0000a8] hover:underline">Mint and connect an agent token</a> with <code>email:read</code> (and draft/send scopes only if needed).</li>
          <li>Send a test email from another address; confirm it appears here and the agent&apos;s <code>list_emails</code> can see it.</li>
        </ol>
      </details>

      {/* Filter and Search Bar */}
      <section aria-label="Mail search and filters" className="flex flex-col gap-2">
        <div className="flex items-center gap-2 flex-wrap sm:flex-nowrap">
          {/* Mailbox Selector */}
          <div className="w-full sm:w-64 shrink-0">
            <select
              value={mailbox}
              onChange={(event) => setMailbox(event.target.value)}
              aria-label="Mailbox"
              className="w-full text-[11px] font-mono bg-[#fffef8] border border-[#e0ded5] rounded-none px-2.5 py-1.5 text-[#222320] focus:outline-none focus:border-[#0000a8]"
            >
              <option value="">All mailboxes</option>
              {(mailboxes ?? []).map((record) => (
                <option key={record.address} value={record.address}>
                  {record.label ? `${record.label} (${record.address})` : record.address}
                </option>
              ))}
            </select>
          </div>

          {/* Filter Pills */}
          <div className="flex items-center gap-1 bg-[#fffef8] border border-[#e0ded5] rounded-none p-0.5">
            <button
              type="button"
              onClick={() => setFilterView("all")}
              className={`text-[11px] px-2.5 py-1 rounded-none font-medium transition-colors ${
                filterView === "all"
                  ? "bg-[#0000a8] text-[#fffef8]"
                  : "text-[#6a6f63] hover:text-[#222320]"
              }`}
            >
              All Mail
            </button>
            <button
              type="button"
              onClick={() => setFilterView("unread")}
              className={`text-[11px] px-2.5 py-1 rounded-none font-medium transition-colors ${
                filterView === "unread"
                  ? "bg-[#0000a8] text-[#fffef8]"
                  : "text-[#6a6f63] hover:text-[#222320]"
              }`}
            >
              Unread {unreadCount > 0 ? `(${unreadCount})` : ""}
            </button>
            <button
              type="button"
              onClick={() => setFilterView("drafts")}
              className={`text-[11px] px-2.5 py-1 rounded-none font-medium transition-colors ${
                filterView === "drafts"
                  ? "bg-[#0000a8] text-[#fffef8]"
                  : "text-[#6a6f63] hover:text-[#222320]"
              }`}
            >
              Drafts {drafts.length > 0 ? `(${drafts.length})` : ""}
            </button>
          </div>

          {/* Refresh Button */}
          <button
            type="button"
            onClick={() => void loadMail()}
            title="Refresh inbox"
            className={GHOST_BUTTON}
          >
            ↻ Refresh
          </button>
        </div>

        {/* Search input */}
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void runSearch();
          }}
          className="flex items-center gap-2"
        >
          <div className="relative flex-1 min-w-0">
            <input
              type="search"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Search sender, recipient, subject, or message body…"
              aria-label="Search mail"
              className="w-full text-[11px] font-mono bg-[#fffef8] border border-[#e0ded5] rounded-none pl-3 pr-8 py-1.5 text-[#222320] placeholder:text-[#6a6f63] focus:outline-none focus:border-[#0000a8]"
            />
            {search.trim() !== "" ? (
              <button
                type="button"
                onClick={() => {
                  setSearch("");
                  void loadMail();
                }}
                className="absolute right-2.5 top-1/2 -translate-y-1/2 text-[10px] text-[#6a6f63] hover:text-[#222320]"
                title="Clear search"
              >
                ✕
              </button>
            ) : null}
          </div>
          <button type="submit" disabled={searching} className={ACCENT_BUTTON}>
            {searching ? "Searching…" : "Search"}
          </button>
        </form>
      </section>

      {/* Global Notices / Errors */}
      {notice !== null ? (
        <div
          role="status"
          className="text-[11px] text-[#15803d] bg-[#15803d]/10 border border-[#15803d]/20 rounded-none p-3 flex items-center justify-between gap-3 shadow-[2px_2px_0_var(--paper-shadow)]"
        >
          <div className="flex items-center gap-2 min-w-0">
            <span className="size-2 rounded-none bg-[#15803d] shrink-0" />
            <span className="font-medium truncate">{notice}</span>
          </div>
          <button
            type="button"
            className="text-[#1c1cc8] font-medium hover:underline shrink-0 text-xs inline-flex items-center gap-1"
            onClick={onOpenApprovals}
          >
            Approvals Queue →
          </button>
        </div>
      ) : null}

      {error !== null ? (
        <div
          role="alert"
          className="text-[11px] text-[#fb2c36] bg-[#fb2c36]/10 border border-[#fb2c36]/20 rounded-none p-3 flex items-center justify-between gap-3"
        >
          <span>{error}</span>
          <button
            type="button"
            onClick={() => setError(null)}
            className="text-[#fb2c36] hover:opacity-75"
          >
            Dismiss
          </button>
        </div>
      ) : null}

      {/* Sacred Approval Boundary Outbound Section (Drafts & Queued Sends) */}
      {(filterView === "all" || filterView === "drafts") && drafts.length > 0 ? (
        <section
          aria-label="Drafts requiring human approval"
          className="border-2 border-[#f99c00]/60 rounded-none bg-[#fffef8] p-3.5 shadow-[2px_2px_0_var(--paper-shadow)] flex flex-col gap-3"
        >
          <div className="flex items-start justify-between gap-3 flex-wrap">
            <div className="flex items-center gap-2">
              <span className="text-sm">🔒</span>
              <div>
                <h3 className="text-xs font-bold uppercase tracking-wider text-[#b45309]">
                  Approval Boundary: Outbound Transmissions
                </h3>
                <p className="text-[11px] text-[#6a6f63]">
                  All outbound emails created by agents must be confirmed by a human operator before delivery.
                </p>
              </div>
            </div>
            <button
              type="button"
              onClick={onOpenApprovals}
              className="text-[11px] text-[#1c1cc8] hover:underline font-medium ml-auto"
            >
              Open Approvals Queue →
            </button>
          </div>

          <div className="flex flex-col gap-2.5">
            {drafts.map((draft) => {
              const isQueued = draft.status === "queued";
              return (
                <article
                  key={draft.id}
                  className={`border rounded-none bg-[#f6f4ed] p-3 transition-colors ${
                    isQueued ? "border-[#0000a8]/40 bg-[#0000a8]/5" : "border-[#e0ded5]"
                  }`}
                >
                  <div className="flex items-start justify-between gap-3 mb-1.5">
                    <div className="min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="text-[10px] font-mono uppercase tracking-wider text-[#6a6f63]">To:</span>
                        <span className="font-mono text-xs text-[#222320] font-medium truncate">
                          {draft.to_addr}
                        </span>
                        {draft.mailbox ? (
                          <span className="text-[10px] font-mono text-[#6a6f63] bg-[#fffef8] border border-[#e0ded5] rounded-none px-1.5">
                            via {draft.mailbox}
                          </span>
                        ) : null}
                      </div>
                      <h4 className="text-xs font-semibold text-[#222320] mt-0.5 truncate">
                        {draft.subject}
                      </h4>
                    </div>

                    <span
                      className={`text-[10px] font-mono uppercase font-bold tracking-wider border rounded-none px-2 py-0.5 shrink-0 ${draftChipClass(
                        draft.status,
                      )}`}
                    >
                      {draft.status === "queued" ? "Queued for Approval" : draft.status}
                    </span>
                  </div>

                  <p className="text-[11px] text-[#222320] font-mono whitespace-pre-wrap bg-[#fffef8] border border-[#e0ded5] rounded-none p-2.5 mb-2.5 max-h-36 overflow-auto">
                    {draft.body_text}
                  </p>

                  <div className="flex items-center justify-between gap-3 flex-wrap">
                    <span className="text-[10px] text-[#6a6f63] font-mono">
                      Last edited {formatTimeAgo(draft.updated_at)}
                    </span>

                    {draft.status === "draft" ? (
                      <button
                        type="button"
                        className={ACCENT_BUTTON}
                        disabled={actionBusy === draft.id}
                        onClick={() => void sendDraft(draft)}
                      >
                        {actionBusy === draft.id ? "Submitting to Queue…" : "Send for approval →"}
                      </button>
                    ) : isQueued ? (
                      <div className="flex items-center gap-2">
                        <span className="text-[11px] font-medium text-[#0000a8] flex items-center gap-1">
                          <span className="size-1.5 rounded-none bg-[#0000a8] animate-pulse" />
                          Pending Human Decision
                        </span>
                        <button
                          type="button"
                          className={SECONDARY_BUTTON}
                          onClick={onOpenApprovals}
                        >
                          Review in Approvals tab
                        </button>
                      </div>
                    ) : null}
                  </div>
                </article>
              );
            })}
          </div>
        </section>
      ) : null}

      {/* Main Mail List / Feed */}
      {filterView !== "drafts" ? (
        <section aria-label="Inbox messages">
          {loading ? (
            <div className="flex flex-col items-center justify-center py-12 border border-dashed border-[#e0ded5] rounded-none bg-[#fffef8] px-4 text-center">
              <div className="size-5 border-2 border-[#0000a8] border-t-transparent rounded-none animate-spin mb-2" />
              <p className="text-[#6a6f63] text-xs font-mono">Loading mail…</p>
            </div>
          ) : displayedEmails.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-12 border border-dashed border-[#e0ded5] rounded-none bg-[#fffef8] px-4 text-center">
              <span className="text-xl mb-1 text-[#6a6f63]">✉</span>
              <p className="text-[#222320] text-xs font-medium">
                {mailboxes !== null && mailboxes.length === 0
                  ? "No mailboxes registered yet."
                  : filterView === "unread"
                  ? "No unread mail."
                  : "No mail found."}
              </p>
              <p className="text-[#6a6f63] text-[11px] mt-0.5 max-w-sm">
                {mailboxes !== null && mailboxes.length === 0
                  ? "Pair a mailbox line above so Cloudflare Email Routing can deliver agent correspondence."
                  : "Emails delivered to your paired addresses will show up here."}
              </p>
            </div>
          ) : (
            <ol className="flex flex-col gap-2">
              {displayedEmails.map((email) => {
                const expanded = expandedId === email.id;
                const isUnread = email.status === "unread";
                const isInbound = email.direction === "inbound";

                return (
                  <li
                    key={email.id}
                    className={`border rounded-none bg-[#fffef8] overflow-hidden transition-all shadow-[2px_2px_0_var(--paper-shadow)] ${
                      expanded
                        ? "border-[#0000a8] ring-1 ring-[#0000a8]/20"
                        : "border-[#e0ded5] hover:border-[#d3d2c8]"
                    }`}
                  >
                    {/* Collapsed / Row Summary Button */}
                    <button
                      type="button"
                      onClick={() => void toggleExpanded(email)}
                      aria-expanded={expanded}
                      className="w-full text-left p-3.5 hover:bg-[#fcfbf7] transition-colors flex flex-col gap-1"
                    >
                      <div className="flex items-center gap-2 min-w-0">
                        <span
                          className={`size-2 rounded-none shrink-0 ${
                            isUnread ? "bg-[#0000a8] ring-4 ring-[#0000a8]/10" : "bg-transparent"
                          }`}
                          title={isUnread ? "Unread" : "Read"}
                        />

                        <span
                          className={`text-[10px] font-mono uppercase px-1.5 py-0.2 rounded-none border shrink-0 ${
                            isInbound
                              ? "bg-[#15803d]/10 text-[#15803d] border-[#15803d]/20"
                              : "bg-[#0000a8]/10 text-[#0000a8] border-[#0000a8]/20"
                          }`}
                        >
                          {isInbound ? "Inbound" : "Outbound"}
                        </span>

                        <span
                          className={`text-xs truncate min-w-0 font-mono ${
                            isUnread ? "text-[#222320] font-bold" : "text-[#6a6f63]"
                          }`}
                        >
                          {isInbound ? email.from_addr : `to ${email.to_addr}`}
                        </span>

                        {email.mailbox ? (
                          <span className="text-[10px] font-mono text-[#6a6f63] border border-[#e0ded5] rounded-none px-1.5 bg-[#f6f4ed] shrink-0">
                            {email.mailbox}
                          </span>
                        ) : null}

                        <span className="text-[10px] text-[#6a6f63] font-mono shrink-0 ml-auto">
                          {formatTimeAgo(email.created_at)}
                        </span>
                      </div>

                      <h4
                        className={`text-xs truncate pl-4 font-medium font-serif ${
                          isUnread ? "text-[#222320]" : "text-[#4b5046]"
                        }`}
                      >
                        {email.subject || "(no subject)"}
                      </h4>
                    </button>

                    {/* Expanded Detail View */}
                    {expanded ? (
                      <div className="p-4 pt-2 border-t border-[#e0ded5] bg-[#f6f4ed]/50 flex flex-col gap-3">
                        {detailLoading ? (
                          <div className="py-4 flex items-center justify-center gap-2 text-xs font-mono text-[#6a6f63]">
                            <span className="size-3 border-2 border-[#0000a8] border-t-transparent rounded-none animate-spin" />
                            Loading message details…
                          </div>
                        ) : detail !== null ? (
                          <>
                            {/* Metadata Header */}
                            <div className="bg-[#fffef8] border border-[#e0ded5] rounded-none p-3 text-[11px] text-[#222320] flex flex-col gap-1.5 shadow-2xs">
                              <div className="flex items-center justify-between gap-2 flex-wrap">
                                <div className="space-y-0.5">
                                  <div className="flex items-center gap-2">
                                    <span className="text-[10px] font-mono uppercase text-[#6a6f63]">From:</span>
                                    <span className="font-mono font-medium">{detail.email.from_addr}</span>
                                  </div>
                                  <div className="flex items-center gap-2">
                                    <span className="text-[10px] font-mono uppercase text-[#6a6f63]">To:</span>
                                    <span className="font-mono font-medium">{detail.email.to_addr}</span>
                                  </div>
                                </div>
                                <div className="flex items-center gap-2">
                                  {email.mailbox ? (
                                    <span className="text-[10px] font-mono text-[#6a6f63] bg-[#f6f4ed] border border-[#e0ded5] rounded-none px-1.5 py-0.5">
                                      Mailbox: {email.mailbox}
                                    </span>
                                  ) : null}
                                  <span className={`text-[10px] font-mono border rounded-none px-2 py-0.5 ${emailChipClass(detail.email.status)}`}>
                                    {detail.email.status}
                                  </span>
                                </div>
                              </div>
                            </div>

                            {/* Message Body */}
                            <div className="bg-[#fffef8] border border-[#e0ded5] rounded-none p-3.5 shadow-2xs">
                              <pre className="font-mono text-xs text-[#222320] whitespace-pre-wrap break-words leading-relaxed max-h-72 overflow-auto">
                                {detail.email.body_text ?? "(no plain-text body)"}
                              </pre>
                            </div>

                            {/* Attachments */}
                            {detail.attachments.length > 0 ? (
                              <div className="flex flex-col gap-1">
                                <span className="text-[10px] font-mono uppercase text-[#6a6f63]">Attachments ({detail.attachments.length})</span>
                                <div className="flex flex-wrap gap-2">
                                  {detail.attachments.map((attachment) => (
                                    <a
                                      key={attachment.part_id}
                                      href={`/api/emails/${encodeURIComponent(detail.email.id)}/attachments/${encodeURIComponent(attachment.part_id)}`}
                                      download={attachment.filename ?? "attachment"}
                                      aria-label={`Download ${attachment.filename ?? attachment.part_id}`}
                                      className="text-[11px] font-mono text-[#222320] border border-[#e0ded5] bg-[#fffef8] rounded-none px-2.5 py-1.5 flex items-center gap-2 shadow-2xs"
                                    >
                                      <span>📎</span>
                                      <span className="font-medium">{attachment.filename ?? attachment.part_id}</span>
                                      {attachment.size !== undefined ? (
                                        <span className="text-[10px] text-[#6a6f63]">({formatBytes(attachment.size)})</span>
                                      ) : null}
                                    </a>
                                  ))}
                                </div>
                              </div>
                            ) : null}

                            {/* Action Bar */}
                            <div className="flex items-center gap-2 pt-1 flex-wrap">
                              <button
                                type="button"
                                className={GHOST_BUTTON}
                                onClick={() => void toggleThread()}
                              >
                                {threadLoading ? "Loading thread…" : thread !== null ? "Hide thread" : "View thread"}
                              </button>
                              <button
                                type="button"
                                className={ACCENT_BUTTON}
                                onClick={() => setReplyOpen((open) => !open)}
                              >
                                {replyOpen ? "Close reply draft" : "Draft reply"}
                              </button>
                            </div>

                            {/* Thread Timeline */}
                            {thread !== null ? (
                              <div className="border border-[#e0ded5] rounded-none bg-[#fffef8] p-3 flex flex-col gap-2 mt-1">
                                <h5 className="text-[10px] font-mono uppercase tracking-wider text-[#6a6f63]">
                                  Thread History ({thread.emails.length} messages)
                                </h5>
                                <ol className="flex flex-col gap-2 border-l-2 border-[#0000a8]/30 pl-3 ml-1">
                                  {thread.emails.map((item) => (
                                    <li key={item.id} className="text-[11px] font-mono">
                                      <div className="flex items-center gap-2 text-[#6a6f63]">
                                        <span className="font-medium text-[#222320]">{item.from_addr}</span>
                                        <span>·</span>
                                        <span>{formatTimeAgo(item.created_at)}</span>
                                      </div>
                                      <p className="text-[#222320] text-xs font-serif mt-0.5">{item.subject}</p>
                                    </li>
                                  ))}
                                </ol>
                              </div>
                            ) : null}

                            {/* Reply Draft Composer */}
                            {replyOpen ? (
                              <form
                                onSubmit={(e) => {
                                  e.preventDefault();
                                  void saveReply();
                                }}
                                className="border-2 border-[#0000a8]/30 bg-[#fffef8] rounded-none p-3.5 flex flex-col gap-2.5 shadow-[2px_2px_0_var(--paper-shadow)]"
                              >
                                <div className="flex items-center justify-between gap-2 border-b border-[#e0ded5] pb-2">
                                  <div className="text-[11px] font-mono">
                                    <span className="text-[#6a6f63]">Replying to: </span>
                                    <span className="font-semibold text-[#222320]">{replyAddress(detail.email)}</span>
                                    <span className="text-[#6a6f63] ml-2">from </span>
                                    <span className="font-semibold text-[#0000a8]">{replyMailbox(detail, mailbox) || "(selected mailbox)"}</span>
                                  </div>
                                  <span className="text-[10px] font-mono text-[#b45309] bg-[#f99c00]/10 border border-[#f99c00]/30 rounded-none px-2 py-0.5">
                                    🔒 Approval Gate
                                  </span>
                                </div>

                                <div className="text-[10px] text-[#6a6f63]">
                                  Subject: <span className="font-mono text-[#222320]">{replySubject(detail.email.subject)}</span>
                                </div>

                                <textarea
                                  value={replyBody}
                                  onChange={(event) => setReplyBody(event.target.value)}
                                  rows={5}
                                  placeholder="Compose reply message here. Saved drafts require human review before dispatch…"
                                  aria-label="Reply message body"
                                  className="w-full text-xs font-mono bg-[#f6f4ed]/50 border border-[#e0ded5] rounded-none p-3 text-[#222320] placeholder:text-[#6a6f63] focus:outline-none focus:border-[#0000a8] focus:bg-[#fffef8]"
                                />

                                <div className="flex items-center justify-between gap-2 pt-1">
                                  <p className="text-[10px] text-[#6a6f63]">
                                    Saving stores this in Drafts. You can then submit it to the Approvals queue.
                                  </p>
                                  <div className="flex items-center gap-2">
                                    <button
                                      type="button"
                                      className={GHOST_BUTTON}
                                      onClick={() => setReplyOpen(false)}
                                    >
                                      Cancel
                                    </button>
                                    <button
                                      type="submit"
                                      className={ACCENT_BUTTON}
                                      disabled={actionBusy === "reply" || replyBody.trim() === ""}
                                    >
                                      {actionBusy === "reply" ? "Saving…" : "Save Draft"}
                                    </button>
                                  </div>
                                </div>
                              </form>
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
        </section>
      ) : null}
    </div>
  );
}
