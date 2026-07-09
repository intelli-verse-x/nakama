import { useEffect, useMemo, useRef, useState } from "react";
import { useChat } from "@ai-sdk/react";
import { DefaultChatTransport } from "ai";
import ReactMarkdown from "react-markdown";
import { AnimatePresence, motion } from "framer-motion";
import {
  AreaChart,
  Bot,
  BookOpen,
  ChevronDown,
  Copy,
  ExternalLink,
  Ear,
  Loader2,
  Mic,
  MicOff,
  Plus,
  Send,
  ShieldAlert,
  Square,
  Volume2,
  VolumeX,
  Wrench,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { useAdminAuth } from "@/auth/admin-auth";
import { Button, Select } from "@/components/ui";
import { useVoice } from "@/hooks/use-voice";
import {
  COPILOT_MODELS,
  COPILOT_SKILLS,
  DEFAULT_COPILOT_MODEL,
  STARTER_PROMPTS,
} from "../../server/copilot-skills.mjs";

const CHAT_API = "/admin-dashboard/api/chat";
const MODEL_PREF_KEY = "nakama-copilot-model";

const WELCOME =
  "**IX Agency** — your Nakama LiveOps copilot. Ask about players, retention, revenue, the economy, " +
  "or launch liveops. I call the game-ops tools directly; writes always need your " +
  "confirmation first.";

/* ── Tool-call chip: collapsible args + result ─────────────────────────── */

interface ToolPartLike {
  type: string;
  toolName?: string;
  state?: string;
  input?: unknown;
  output?: unknown;
  errorText?: string;
}

/* ── Server-side write gate: confirmation_required tool results ──────────
   Write-classified tools do NOT execute on first call; the server returns a
   JSON result with status "confirmation_required" and a signed single-use
   token. Only the Confirm button below can authorize it — the token must
   travel in the top-level `confirmations` request-body field, which the
   model cannot set. */

interface ConfirmationRequest {
  tool: string;
  humanSummary: string;
  confirmToken: string;
}

type ConfirmationResolution = "confirmed" | "cancelled";

function extractConfirmationRequest(output: unknown): ConfirmationRequest | null {
  let obj: unknown = output;
  if (typeof output === "string") {
    const s = output.trim();
    if (!s.includes("confirmation_required")) return null;
    try {
      obj = JSON.parse(s);
    } catch {
      return null;
    }
  }
  if (!obj || typeof obj !== "object") return null;
  const o = obj as Record<string, unknown>;
  if (o.status !== "confirmation_required") return null;
  if (typeof o.tool !== "string" || typeof o.confirmToken !== "string") return null;
  return {
    tool: o.tool,
    humanSummary: typeof o.humanSummary === "string" ? o.humanSummary : o.tool,
    confirmToken: o.confirmToken,
  };
}

/* Inline viz artifacts: viz-mcp (via the admin-mcp gateway) returns
   {viz:true, type, url} — render the hosted artifact inline. */

interface VizArtifact {
  type: "html" | "image" | "video" | "dashboard";
  url: string;
  title?: string;
  imageUrl?: string;
}

const VIZ_TYPES = new Set(["html", "image", "video", "dashboard"]);

function collectVizArtifacts(node: unknown, out: VizArtifact[], depth = 0): void {
  // Depth 12: gateway artifacts arrive double-wrapped (tool output → gateway
  // JSON-RPC text → downstream JSON-RPC text → artifact JSON), ~8 levels deep.
  if (!node || depth > 12 || out.length >= 4) return;
  if (typeof node === "string") {
    const s = node.trim();
    if (!s.includes("viz") || !s.includes("url")) return;
    try {
      collectVizArtifacts(JSON.parse(s), out, depth + 1);
      return;
    } catch {
      /* not bare JSON — scan for the escaped artifact object below */
    }
    // Gateway responses nest artifact JSON inside content[].text with escaped
    // quotes; unescape and scan for the flat {viz:true,...} object.
    const un = s.replace(/\\n/g, "\n").replace(/\\"/g, '"');
    const matches = un.match(/\{[^{}]*"viz"\s*:\s*true[^{}]*\}/g);
    for (const m of matches ?? []) {
      try {
        collectVizArtifacts(JSON.parse(m), out, depth + 1);
      } catch {
        /* skip malformed fragment */
      }
    }
    return;
  }
  if (Array.isArray(node)) {
    for (const item of node) collectVizArtifacts(item, out, depth + 1);
    return;
  }
  if (typeof node === "object") {
    const o = node as Record<string, unknown>;
    if (
      o.viz === true &&
      typeof o.url === "string" &&
      /^https:\/\//.test(o.url) &&
      typeof o.type === "string" &&
      VIZ_TYPES.has(o.type)
    ) {
      if (!out.some((a) => a.url === o.url)) {
        out.push({
          type: o.type as VizArtifact["type"],
          url: o.url,
          title: typeof o.title === "string" ? o.title : undefined,
          imageUrl: typeof o.imageUrl === "string" ? o.imageUrl : undefined,
        });
      }
      return;
    }
    for (const v of Object.values(o)) collectVizArtifacts(v, out, depth + 1);
  }
}

function extractVizArtifacts(output: unknown): VizArtifact[] {
  const out: VizArtifact[] = [];
  try {
    collectVizArtifacts(output, out);
  } catch {
    /* never let artifact detection break the chip */
  }
  return out;
}

function VizArtifactCard({ artifact }: { artifact: VizArtifact }) {
  const [copied, setCopied] = useState(false);
  const label =
    artifact.title ||
    (artifact.type === "dashboard"
      ? "Dashboard"
      : artifact.type === "video"
        ? "Video"
        : artifact.type === "image"
          ? "Chart"
          : "Visualization");
  const copy = () => {
    void navigator.clipboard?.writeText(artifact.url).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  };
  return (
    <div className="my-2 overflow-hidden rounded-lg border border-primary/25 bg-background">
      <div className="flex items-center gap-2 border-b border-border/60 px-3 py-1.5 text-xs text-primary">
        <AreaChart className="h-3.5 w-3.5" aria-hidden />
        <span className="min-w-0 truncate font-medium">{label}</span>
        <span className="ml-auto flex items-center gap-1">
          <button
            type="button"
            onClick={copy}
            title="Copy link"
            aria-label="Copy artifact link"
            className="rounded p-1 hover:bg-primary/10"
          >
            {copied ? <span className="px-0.5 text-[10px]">Copied</span> : <Copy className="h-3.5 w-3.5" aria-hidden />}
          </button>
          <a
            href={artifact.url}
            target="_blank"
            rel="noopener noreferrer"
            title="Open in new tab"
            aria-label="Open artifact in new tab"
            className="rounded p-1 hover:bg-primary/10"
          >
            <ExternalLink className="h-3.5 w-3.5" aria-hidden />
          </a>
        </span>
      </div>
      {artifact.type === "image" ? (
        <img src={artifact.url} alt={label} className="max-h-[420px] w-full bg-black object-contain" loading="lazy" />
      ) : artifact.type === "video" ? (
        <video src={artifact.url} controls playsInline preload="metadata" className="max-h-[420px] w-full bg-black" poster={artifact.imageUrl} />
      ) : (
        <iframe
          src={artifact.url}
          title={label}
          // Scripts only (Chart.js/GSAP need them) — no same-origin, forms,
          // popups or top-navigation from hosted artifacts.
          sandbox="allow-scripts"
          referrerPolicy="no-referrer"
          loading="lazy"
          className="h-[420px] w-full border-0 bg-black"
        />
      )}
    </div>
  );
}

function ToolChip({
  part,
  resolution,
  onConfirm,
  onCancel,
  busy,
}: {
  part: ToolPartLike;
  resolution?: ConfirmationResolution;
  onConfirm?: (req: ConfirmationRequest) => void;
  onCancel?: (req: ConfirmationRequest) => void;
  busy?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const name = part.toolName ?? part.type.replace(/^tool-/, "");
  const done = part.state === "output-available" || part.state === "output-error";
  const failed = part.state === "output-error";
  const confirmation = useMemo(
    () => (done && !failed ? extractConfirmationRequest(part.output) : null),
    [done, failed, part.output],
  );
  const artifacts = useMemo(
    () => (done && !failed ? extractVizArtifacts(part.output) : []),
    [done, failed, part.output],
  );
  return (
    <div
      className={cn(
        "my-1 rounded-lg border text-xs",
        failed
          ? "border-destructive/40 bg-destructive/10"
          : "border-primary/25 bg-primary/5",
      )}
    >
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className={cn(
          "flex w-full items-center gap-2 rounded-lg px-3 py-1.5 text-left",
          failed ? "text-destructive" : "text-primary",
        )}
      >
        {done ? (
          <Wrench className="h-3 w-3 shrink-0" aria-hidden />
        ) : (
          <Loader2 className="h-3 w-3 shrink-0 animate-spin" aria-hidden />
        )}
        <span className="min-w-0 truncate font-mono" translate="no">
          {name}
        </span>
        <span className="ml-auto shrink-0 text-[10px] uppercase tracking-wide opacity-70">
          {failed ? "error" : done ? "done" : "running"}
        </span>
        <ChevronDown
          className={cn("h-3 w-3 shrink-0 transition-transform", open && "rotate-180")}
          aria-hidden
        />
      </button>
      {open ? (
        <div className="space-y-1.5 border-t border-border/60 px-3 py-2">
          {part.input !== undefined ? (
            <div>
              <p className="mb-0.5 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                Arguments
              </p>
              <pre className="max-h-40 overflow-auto whitespace-pre-wrap break-words rounded bg-muted/60 p-2 text-[11px]">
                {JSON.stringify(part.input, null, 2)}
              </pre>
            </div>
          ) : null}
          {done ? (
            <div>
              <p className="mb-0.5 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                {failed ? "Error" : "Result"}
              </p>
              <pre className="max-h-60 overflow-auto whitespace-pre-wrap break-words rounded bg-muted/60 p-2 text-[11px]">
                {failed
                  ? part.errorText ?? "tool call failed"
                  : typeof part.output === "string"
                    ? part.output
                    : JSON.stringify(part.output, null, 2)}
              </pre>
            </div>
          ) : null}
        </div>
      ) : null}
      {confirmation ? (
        <div className="border-t border-border/60 px-3 py-2">
          <p className="flex items-center gap-1.5 text-[11px] font-semibold text-foreground">
            <ShieldAlert className="h-3.5 w-3.5 shrink-0 text-primary" aria-hidden />
            Write action needs your approval
          </p>
          <p className="mt-1 break-words rounded bg-muted/60 p-2 font-mono text-[11px]">
            {confirmation.humanSummary}
          </p>
          {resolution ? (
            <p className="mt-1.5 text-[11px] font-medium text-muted-foreground">
              {resolution === "confirmed" ? "Confirmed — executing…" : "Cancelled — not executed."}
            </p>
          ) : (
            <div className="mt-2 flex gap-2">
              <Button
                type="button"
                variant="brand"
                size="sm"
                disabled={busy}
                onClick={() => onConfirm?.(confirmation)}
              >
                Confirm
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                disabled={busy}
                onClick={() => onCancel?.(confirmation)}
              >
                Cancel
              </Button>
            </div>
          )}
        </div>
      ) : null}
      {artifacts.length > 0 ? (
        <div className="px-2 pb-1">
          {artifacts.map((a) => (
            <VizArtifactCard key={a.url} artifact={a} />
          ))}
        </div>
      ) : null}
    </div>
  );
}

/* ── Page ──────────────────────────────────────────────────────────────── */

export default function CopilotPage() {
  const { session } = useAdminAuth();
  const [input, setInput] = useState("");
  const [interim, setInterim] = useState("");
  const [model, setModel] = useState<string>(() => {
    try {
      const stored = localStorage.getItem(MODEL_PREF_KEY);
      if (stored && COPILOT_MODELS.some((m) => m.id === stored)) return stored;
    } catch {
      /* ignore */
    }
    return DEFAULT_COPILOT_MODEL;
  });
  const [skillId, setSkillId] = useState<string | null>(null);
  const [copiedMsgId, setCopiedMsgId] = useState<string | null>(null);
  // confirmToken → confirmed/cancelled, so each Confirm/Cancel pair is one-shot.
  const [confirmationResolutions, setConfirmationResolutions] = useState<
    Record<string, ConfirmationResolution>
  >({});
  const bottomRef = useRef<HTMLDivElement>(null);

  // Latest picks for the transport (its callbacks close over the first render).
  const tokenRef = useRef(session?.token ?? "");
  tokenRef.current = session?.token ?? "";
  const modelRef = useRef(model);
  modelRef.current = model;
  const skillRef = useRef(skillId);
  skillRef.current = skillId;
  // Tokens approved via the Confirm button, riding the NEXT request only.
  // This top-level body field is the sole authorization channel — the model
  // cannot populate it, so it cannot approve its own writes.
  const confirmationsRef = useRef<string[]>([]);

  const transport = useMemo(
    () =>
      new DefaultChatTransport({
        api: CHAT_API,
        prepareSendMessagesRequest: ({ messages, headers }) => {
          const confirmations = confirmationsRef.current;
          confirmationsRef.current = []; // tokens are single-use — one request only
          return {
            headers: {
              ...(headers instanceof Headers ? Object.fromEntries(headers.entries()) : headers),
              Authorization: `Bearer ${tokenRef.current}`,
            },
            body: {
              messages,
              model: modelRef.current,
              skillId: skillRef.current,
              ...(confirmations.length > 0 ? { confirmations } : {}),
            },
          };
        },
      }),
    [],
  );

  const { messages, sendMessage, status, stop, setMessages, error } = useChat({ transport });
  const isLoading = status === "streaming" || status === "submitted";

  const submit = (text: string) => {
    const trimmed = text.trim();
    if (!trimmed || isLoading) return;
    setInput("");
    void sendMessage({ text: trimmed });
  };
  const submitRef = useRef(submit);
  submitRef.current = submit;

  const confirmWrite = (req: ConfirmationRequest) => {
    if (isLoading || confirmationResolutions[req.confirmToken]) return;
    setConfirmationResolutions((cur) => ({ ...cur, [req.confirmToken]: "confirmed" }));
    confirmationsRef.current = [...confirmationsRef.current, req.confirmToken];
    void sendMessage({ text: `Confirmed — proceed with ${req.tool}.` });
  };

  const cancelWrite = (req: ConfirmationRequest) => {
    if (isLoading || confirmationResolutions[req.confirmToken]) return;
    setConfirmationResolutions((cur) => ({ ...cur, [req.confirmToken]: "cancelled" }));
    void sendMessage({ text: "Cancel that action — do not execute it." });
  };

  const voice = useVoice({
    onFinalTranscript: (text) => submitRef.current(text),
    onInterimTranscript: setInterim,
  });

  // Speak each newly finished assistant reply when TTS is on. The counter
  // starts at the current count so toggling TTS mid-chat doesn't replay history.
  const spokenCountRef = useRef<number | null>(null);
  useEffect(() => {
    const assistantCount = messages.filter((m) => m.role === "assistant").length;
    if (!voice.speakEnabled) {
      spokenCountRef.current = assistantCount;
      return;
    }
    if (spokenCountRef.current === null) spokenCountRef.current = assistantCount;
    if (isLoading || assistantCount <= spokenCountRef.current) return;
    spokenCountRef.current = assistantCount;
    const last = [...messages].reverse().find((m) => m.role === "assistant");
    if (!last) return;
    const text = last.parts
      .filter((p): p is { type: "text"; text: string } => p.type === "text")
      .map((p) => p.text)
      .join(" ");
    if (text) voice.speak(text);
  }, [messages, isLoading, voice]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [messages, isLoading]);

  const pickModel = (id: string) => {
    setModel(id);
    try {
      localStorage.setItem(MODEL_PREF_KEY, id);
    } catch {
      /* ignore */
    }
  };

  const activeSkill = skillId ? COPILOT_SKILLS.find((s) => s.id === skillId) : undefined;
  const starterPrompts = useMemo(() => STARTER_PROMPTS.slice(0, 8), []);

  return (
    <div className="flex h-[calc(100vh-7rem)] flex-col lg:h-[calc(100vh-8rem)]">
      {/* Toolbar: model + skills + voice toggles */}
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <Select
          value={model}
          onChange={(e) => pickModel(e.target.value)}
          aria-label="IX Agency model"
          className="h-8 w-auto min-w-[180px] text-xs"
        >
          {COPILOT_MODELS.map((m) => (
            <option key={m.id} value={m.id}>
              {m.label}
            </option>
          ))}
        </Select>

        <div className="mx-1 hidden h-5 w-px bg-border sm:block" />

        <div className="flex min-w-0 flex-1 items-center gap-1.5 overflow-x-auto pb-0.5">
          <BookOpen className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden />
          {COPILOT_SKILLS.map((s) => (
            <button
              key={s.id}
              type="button"
              title={s.blurb}
              aria-pressed={skillId === s.id}
              onClick={() => setSkillId((cur) => (cur === s.id ? null : s.id))}
              className={cn(
                "shrink-0 rounded-full border px-2.5 py-1 text-[11px] font-medium transition-colors",
                skillId === s.id
                  ? "border-primary bg-primary/10 text-primary"
                  : "border-border text-muted-foreground hover:border-primary/40 hover:text-foreground",
              )}
            >
              {s.label}
            </button>
          ))}
        </div>

        <div className="flex items-center gap-1">
          {voice.ttsSupported ? (
            <Button
              variant={voice.speakEnabled ? "secondary" : "ghost"}
              size="icon"
              onClick={voice.toggleSpeakEnabled}
              title={voice.speakEnabled ? "Spoken replies: on" : "Spoken replies: off"}
              aria-pressed={voice.speakEnabled}
            >
              {voice.speakEnabled ? (
                <Volume2 className="h-4 w-4" />
              ) : (
                <VolumeX className="h-4 w-4" />
              )}
            </Button>
          ) : null}
          {voice.supported ? (
            <Button
              variant={voice.handsFree ? "secondary" : "ghost"}
              size="icon"
              onClick={voice.toggleHandsFree}
              title={
                voice.handsFree
                  ? "Hands-free conversation: on (mic re-opens after each reply)"
                  : "Hands-free conversation: off"
              }
              aria-pressed={voice.handsFree}
            >
              <Ear className="h-4 w-4" />
            </Button>
          ) : null}
          {messages.length > 0 ? (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                if (isLoading) stop();
                voice.stopSpeaking();
                setMessages([]);
                setConfirmationResolutions({});
                confirmationsRef.current = [];
              }}
              leftIcon={<Plus className="h-3.5 w-3.5" />}
            >
              New chat
            </Button>
          ) : null}
        </div>
      </div>

      {/* Messages */}
      <div className="min-h-0 flex-1 overflow-y-auto rounded-xl border border-border bg-surface/50 p-4">
        <div className="mx-auto flex max-w-3xl flex-col gap-4">
          <div className="flex gap-3">
            <span className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full brand-gradient text-white">
              <Bot className="h-4 w-4" aria-hidden />
            </span>
            <div className="copilot-md rounded-2xl rounded-tl-sm border border-border bg-card px-4 py-3 text-sm shadow-soft">
              <ReactMarkdown>{WELCOME}</ReactMarkdown>
              {activeSkill ? (
                <p className="mt-1.5 text-xs text-muted-foreground">
                  Active skill: <span className="font-medium text-primary">{activeSkill.label}</span>{" "}
                  — {activeSkill.blurb}
                </p>
              ) : null}
            </div>
          </div>

          {messages.length === 0 ? (
            <div className="grid gap-2 pl-10 sm:grid-cols-2">
              {starterPrompts.map((p) => (
                <button
                  key={`${p.skillId}:${p.prompt}`}
                  type="button"
                  onClick={() => {
                    setSkillId(p.skillId);
                    skillRef.current = p.skillId;
                    submit(p.prompt);
                  }}
                  className="group rounded-xl border border-border bg-card px-3.5 py-3 text-left text-sm shadow-soft transition-all hover:-translate-y-0.5 hover:border-primary/40 hover:shadow-soft-lg"
                >
                  <span className="mb-1 block text-[10px] font-semibold uppercase tracking-wide text-primary">
                    {p.label}
                  </span>
                  <span className="text-foreground/90">{p.prompt}</span>
                </button>
              ))}
            </div>
          ) : null}

          <AnimatePresence initial={false}>
            {messages.map((msg) => (
              <motion.div
                key={msg.id}
                initial={{ opacity: 0, y: 8 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.18 }}
                className={cn("flex gap-3", msg.role === "user" && "justify-end")}
              >
                {msg.role === "assistant" ? (
                  <span className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full brand-gradient text-white">
                    <Bot className="h-4 w-4" aria-hidden />
                  </span>
                ) : null}
                <div
                  className={cn(
                    "min-w-0 max-w-[85%] rounded-2xl px-4 py-3 text-sm",
                    msg.role === "user"
                      ? "rounded-tr-sm bg-primary text-primary-foreground shadow-soft"
                      : "rounded-tl-sm border border-border bg-card shadow-soft",
                  )}
                >
                  {msg.parts.map((part, i) => {
                    if (part.type === "text") {
                      if (!part.text) return null;
                      return (
                        <div
                          key={i}
                          className={cn(
                            "copilot-md break-words",
                            msg.role === "user" && "copilot-md-inverted",
                          )}
                        >
                          <ReactMarkdown>{part.text}</ReactMarkdown>
                        </div>
                      );
                    }
                    if (part.type.startsWith("tool-") || part.type === "dynamic-tool") {
                      const toolPart = part as unknown as ToolPartLike;
                      const pending = extractConfirmationRequest(
                        toolPart.state === "output-available" ? toolPart.output : undefined,
                      );
                      return (
                        <ToolChip
                          key={i}
                          part={toolPart}
                          resolution={
                            pending ? confirmationResolutions[pending.confirmToken] : undefined
                          }
                          onConfirm={confirmWrite}
                          onCancel={cancelWrite}
                          busy={isLoading}
                        />
                      );
                    }
                    return null;
                  })}
                  {msg.role === "assistant" &&
                  !(isLoading && msg.id === messages[messages.length - 1]?.id) ? (
                    <div className="mt-1.5 flex justify-end">
                      <button
                        type="button"
                        onClick={() => {
                          const md = msg.parts
                            .filter(
                              (p): p is { type: "text"; text: string } => p.type === "text",
                            )
                            .map((p) => p.text)
                            .join("\n\n");
                          void navigator.clipboard.writeText(md).then(() => {
                            setCopiedMsgId(msg.id);
                            setTimeout(
                              () => setCopiedMsgId((v) => (v === msg.id ? null : v)),
                              2000,
                            );
                          });
                        }}
                        className="flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                      >
                        <Copy className="h-3 w-3" aria-hidden />
                        {copiedMsgId === msg.id ? "Copied!" : "Copy"}
                      </button>
                    </div>
                  ) : null}
                </div>
              </motion.div>
            ))}
          </AnimatePresence>

          {isLoading ? (
            <div
              className="flex items-center gap-2 pl-10 text-xs text-muted-foreground"
              role="status"
            >
              <Loader2 className="h-3 w-3 animate-spin" aria-hidden /> Thinking…
            </div>
          ) : null}
          {error ? (
            <p className="pl-10 text-xs text-destructive">
              {error.message || "The IX Agency request failed. Try again."}
            </p>
          ) : null}
          <div ref={bottomRef} />
        </div>
      </div>

      {/* Composer */}
      <form
        className="mt-3"
        onSubmit={(e) => {
          e.preventDefault();
          submit(input);
        }}
      >
        <div className="mx-auto flex max-w-3xl items-end gap-2">
          <div className="relative flex-1">
            <textarea
              value={voice.listening && interim ? interim : input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  submit(input);
                }
              }}
              rows={2}
              placeholder={
                voice.listening
                  ? "Listening… speak your command"
                  : "Ask about players, retention, revenue, economy… (Enter to send)"
              }
              className={cn(
                "w-full resize-none rounded-xl border border-input bg-background px-3.5 py-2.5 pr-11 text-sm shadow-sm outline-none transition-all placeholder:text-muted-foreground/60 focus:border-primary/60 focus:ring-4 focus:ring-primary/15",
                voice.listening && "border-primary/60 ring-4 ring-primary/15",
              )}
            />
            {voice.supported ? (
              <button
                type="button"
                onClick={voice.toggleListening}
                title={voice.listening ? "Stop listening" : "Speak a command"}
                aria-pressed={voice.listening}
                className={cn(
                  "absolute bottom-2.5 right-2.5 flex h-8 w-8 items-center justify-center rounded-lg transition-colors",
                  voice.listening
                    ? "animate-pulse bg-destructive text-destructive-foreground"
                    : "text-muted-foreground hover:bg-accent hover:text-foreground",
                )}
              >
                {voice.listening ? <MicOff className="h-4 w-4" /> : <Mic className="h-4 w-4" />}
              </button>
            ) : null}
          </div>
          {isLoading ? (
            <Button
              type="button"
              variant="destructive"
              size="icon"
              onClick={() => stop()}
              title="Stop generating"
              className="h-11 w-11 rounded-xl"
            >
              <Square className="h-4 w-4" />
            </Button>
          ) : (
            <Button
              type="submit"
              variant="brand"
              size="icon"
              disabled={!input.trim()}
              title="Send"
              className="h-11 w-11 rounded-xl"
            >
              <Send className="h-4 w-4" />
            </Button>
          )}
        </div>
      </form>
    </div>
  );
}
