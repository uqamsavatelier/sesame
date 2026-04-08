import { supa } from "./supabaseClient.js";

export const AUDIT_EVENT_TYPES = [
  "role_update",
  "loan_create",
  "loan_return",
  "key_report_missing",
  "key_report_found",
  "key_create",
  "key_move",
  "key_delete",
  "key_update",
  "keyring_create",
  "keyring_move",
  "keyring_delete",
  "keyring_update",
  "cabinet_create",
  "cabinet_delete",
  "cabinet_update",
  "suggestion_create",
  "suggestion_update",
  "system_comm_error",
];

const QUEUE_KEY = "sav_audit_queue_v1";
const HISTORY_KEY = "sav_audit_history_v1";
const LAST_DUMP_AT_KEY = "sav_audit_last_dump_at_v1";
const DUMP_PERIOD_MS = 24 * 60 * 60 * 1000;
const MAX_HISTORY = 4000;
export const AUDIT_TIMEZONE = "America/Toronto";

let syncStarted = false;
let flushInFlight = null;
let syncTimer = null;
let errorHooksInstalled = false;

function safeParse(raw, fallback) {
  try {
    const parsed = JSON.parse(raw);
    return parsed == null ? fallback : parsed;
  } catch {
    return fallback;
  }
}

function readJsonArray(key) {
  return safeParse(localStorage.getItem(key), []);
}

function writeJsonArray(key, value) {
  localStorage.setItem(key, JSON.stringify(value ?? []));
}

function nowIso() {
  return new Date().toISOString();
}

function randomId() {
  try {
    return crypto.randomUUID();
  } catch {
    return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  }
}

function normalizeType(type) {
  const raw = String(type ?? "").trim().toLowerCase();
  return raw || "system_comm_error";
}

function sanitizeText(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

function toLogRecord(input) {
  const createdAt = input?.created_at || nowIso();
  return {
    id: input?.id || randomId(),
    created_at: createdAt,
    event_type: normalizeType(input?.event_type),
    actor_id: input?.actor_id ?? null,
    actor_name: sanitizeText(input?.actor_name || "System"),
    action: sanitizeText(input?.action || input?.event_type || "unknown"),
    target: sanitizeText(input?.target || "-"),
    details: sanitizeText(input?.details || ""),
    status: sanitizeText(input?.status || "ok"),
    http_status: Number.isFinite(Number(input?.http_status)) ? Number(input.http_status) : null,
    source: sanitizeText(input?.source || "frontend"),
  };
}

function appendHistory(record) {
  const list = readJsonArray(HISTORY_KEY);
  list.push(record);
  if (list.length > MAX_HISTORY) list.splice(0, list.length - MAX_HISTORY);
  writeJsonArray(HISTORY_KEY, list);
}

function pushQueue(record) {
  const list = readJsonArray(QUEUE_KEY);
  list.push(record);
  if (list.length > MAX_HISTORY) list.splice(0, list.length - MAX_HISTORY);
  writeJsonArray(QUEUE_KEY, list);
}

function popQueueCount(count) {
  const list = readJsonArray(QUEUE_KEY);
  list.splice(0, Math.max(0, count));
  writeJsonArray(QUEUE_KEY, list);
}

function getQueue() {
  return readJsonArray(QUEUE_KEY);
}

function formatDatePart(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function formatTimePart(d) {
  const h = String(d.getHours()).padStart(2, "0");
  const m = String(d.getMinutes()).padStart(2, "0");
  const s = String(d.getSeconds()).padStart(2, "0");
  return `${h}:${m}:${s}`;
}

function formatDateTimeParts(parts) {
  const y = String(parts.year).padStart(4, "0");
  const m = String(parts.month).padStart(2, "0");
  const d = String(parts.day).padStart(2, "0");
  const h = String(parts.hour).padStart(2, "0");
  const min = String(parts.minute).padStart(2, "0");
  const s = String(parts.second).padStart(2, "0");
  return `${y}-${m}-${d} ${h}:${min}:${s}`;
}

function getZonedParts(date, timeZone = AUDIT_TIMEZONE) {
  const d = date instanceof Date ? date : new Date(date);
  if (Number.isNaN(d.valueOf())) return null;
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(d);
  const num = (type) => Number(parts.find((p) => p.type === type)?.value ?? "0");
  return {
    year: num("year"),
    month: num("month"),
    day: num("day"),
    hour: num("hour"),
    minute: num("minute"),
    second: num("second"),
  };
}

export function formatAuditDateTimeQuebec(value) {
  const parts = getZonedParts(value, AUDIT_TIMEZONE);
  if (!parts) return "0000-00-00 00:00:00";
  return formatDateTimeParts(parts);
}

export function getQuebecDateToken(value = new Date()) {
  const parts = getZonedParts(value, AUDIT_TIMEZONE);
  if (!parts) return "00000000";
  const y = String(parts.year).padStart(4, "0");
  const m = String(parts.month).padStart(2, "0");
  const d = String(parts.day).padStart(2, "0");
  return `${y}${m}${d}`;
}

export function formatAuditLine(record) {
  const d = new Date(record.created_at);
  const ts = Number.isNaN(d.valueOf()) ? "0000-00-00 00:00:00" : formatAuditDateTimeQuebec(d);
  const actor = sanitizeText(record.actor_name || "System");
  const action = sanitizeText(record.event_type || record.action || "unknown");
  const target = sanitizeText(record.target || "-");
  const details = sanitizeText(record.details || "");
  return `${ts} / ${actor} / ${action} / ${target} / ${details}`;
}

async function getCurrentActor() {
  try {
    const { data } = await supa.auth.getSession();
    const user = data?.session?.user;
    if (!user?.id) return { actor_id: null, actor_name: "System" };
    const { data: profile } = await supa
      .from("user_profiles")
      .select("display_name")
      .eq("id", user.id)
      .maybeSingle();
    return {
      actor_id: user.id,
      actor_name: sanitizeText(profile?.display_name || user.email || user.id),
    };
  } catch {
    return { actor_id: null, actor_name: "System" };
  }
}

async function ensureDailyDump() {
  const lastDumpRaw = Number(localStorage.getItem(LAST_DUMP_AT_KEY) || "0");
  const now = Date.now();
  if (Number.isFinite(lastDumpRaw) && now - lastDumpRaw < DUMP_PERIOD_MS) return;
  localStorage.setItem(LAST_DUMP_AT_KEY, String(now));
}

export async function flushAuditQueue() {
  if (flushInFlight) return flushInFlight;
  flushInFlight = (async () => {
    const queue = getQueue();
    if (!queue.length) {
      await ensureDailyDump();
      return { flushed: 0 };
    }

    try {
      const payload = queue.map((r) => ({
        id: r.id,
        created_at: r.created_at,
        event_type: r.event_type,
        actor_id: r.actor_id,
        actor_name: r.actor_name,
        action: r.action,
        target: r.target,
        details: r.details,
        status: r.status,
        http_status: r.http_status,
        source: r.source,
      }));
      const { error } = await supa.from("audit_events").insert(payload);
      if (error) throw error;
      popQueueCount(queue.length);
      await ensureDailyDump();
      return { flushed: queue.length };
    } catch {
      await ensureDailyDump();
      return { flushed: 0 };
    }
  })();

  try {
    return await flushInFlight;
  } finally {
    flushInFlight = null;
  }
}

export async function logAuditEvent(input) {
  const actor = (input?.actor_id || input?.actor_name)
    ? { actor_id: input.actor_id ?? null, actor_name: input.actor_name ?? "System" }
    : await getCurrentActor();
  const record = toLogRecord({
    ...input,
    ...actor,
  });
  appendHistory(record);
  pushQueue(record);
  ensureAuditSyncStarted();
  void flushAuditQueue();
  return record;
}

export function listLocalAuditEvents() {
  return readJsonArray(HISTORY_KEY)
    .slice()
    .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
}

export function getAllAuditTypes() {
  return [...AUDIT_EVENT_TYPES];
}

export async function listAuditEvents({ types = [], from = null, to = null, limit = 1000 } = {}) {
  const normalized = (types ?? []).map((t) => normalizeType(t));
  const fromIso = from ? new Date(from).toISOString() : null;
  const toIso = to ? new Date(to).toISOString() : null;
  const cappedLimit = Number.isFinite(Number(limit)) ? Math.max(1, Math.min(5000, Math.trunc(Number(limit)))) : 1000;
  try {
    let query = supa
      .from("audit_events")
      .select("id,created_at,event_type,actor_id,actor_name,action,target,details,status,http_status,source")
      .order("created_at", { ascending: false })
      .limit(cappedLimit);
    if (normalized.length) query = query.in("event_type", normalized);
    if (fromIso) query = query.gte("created_at", fromIso);
    if (toIso) query = query.lte("created_at", toIso);
    const { data, error } = await query;
    if (error) throw error;
    return (data ?? []).map((r) => toLogRecord(r));
  } catch {
    let local = listLocalAuditEvents();
    if (normalized.length) {
      local = local.filter((r) => normalized.includes(normalizeType(r.event_type)));
    }
    if (fromIso || toIso) {
      const fromTs = fromIso ? new Date(fromIso).valueOf() : null;
      const toTs = toIso ? new Date(toIso).valueOf() : null;
      local = local.filter((r) => {
        const ts = new Date(r.created_at).valueOf();
        if (!Number.isFinite(ts)) return false;
        if (fromTs != null && ts < fromTs) return false;
        if (toTs != null && ts > toTs) return false;
        return true;
      });
    }
    return local.slice(0, cappedLimit);
  }
}

export function ensureAuditSyncStarted() {
  if (syncStarted) return;
  syncStarted = true;
  syncTimer = setInterval(() => {
    void flushAuditQueue();
  }, 30_000);
  window.addEventListener("online", () => {
    void flushAuditQueue();
  });
}

export function installGlobalAuditErrorHooks() {
  if (errorHooksInstalled) return;
  errorHooksInstalled = true;
  ensureAuditSyncStarted();
  window.addEventListener("error", (event) => {
    const msg = event?.error?.message || event?.message || "window_error";
    void logAuditEvent({
      event_type: "system_comm_error",
      action: "window_error",
      target: event?.filename || "frontend",
      details: sanitizeText(msg),
      status: "error",
      source: "frontend",
    });
  });
  window.addEventListener("unhandledrejection", (event) => {
    const reason = event?.reason;
    const msg = typeof reason === "string" ? reason : (reason?.message || "unhandled_promise_rejection");
    void logAuditEvent({
      event_type: "system_comm_error",
      action: "unhandledrejection",
      target: "frontend",
      details: sanitizeText(msg),
      status: "error",
      source: "frontend",
    });
  });
}
