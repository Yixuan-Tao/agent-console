"""Agent Console collector.

Read-only snapshot of the local AI agent apps on this Windows machine.

Modes:
  collector.py                      -> {"generatedAt", "host", "agents": [...], "errors": [...]}
  collector.py --session <app> <id> -> {"app", "id", "title", "cwd", "status", "note", "events": [...]}

Everything here is read-only: SQLite is opened with mode=ro, JSON is read, and the
process list is inspected. No application file is written.
"""

from __future__ import annotations

import ctypes
import json
import os
import re
import shutil
import sqlite3
import subprocess
import sys
import tempfile
import time
import winreg
from ctypes import wintypes
from datetime import datetime, timezone

sys.stdout.reconfigure(encoding="utf-8")

HOME = os.path.expanduser("~")
NOW_MS = int(time.time() * 1000)
ERRORS: list[dict] = []
SESSION_LIMIT = 20
CODEX_GUARDIAN_TITLE = "guardian review"


# ----------------------------------------------------------------------------- helpers
def read_json(path: str):
    with open(path, "r", encoding="utf-8-sig") as fh:
        return json.load(fh)


def iso_to_ms(value) -> int | None:
    if value is None:
        return None
    if isinstance(value, (int, float)):
        n = float(value)
        if n > 1e17:
            return int(n / 1e6)
        if n > 1e14:
            return int(n / 1e3)
        if n > 1e11:
            return int(n)
        return int(n * 1000)
    text = str(value).strip()
    if not text:
        return None
    if text.isdigit():
        return iso_to_ms(int(text))
    try:
        dt = datetime.fromisoformat(text.replace("Z", "+00:00"))
    except ValueError:
        dt = None
        for fmt in ("%Y-%m-%d %H:%M:%S.%f", "%Y-%m-%d %H:%M:%S", "%Y-%m-%dT%H:%M:%S"):
            try:
                dt = datetime.strptime(text, fmt)
                break
            except ValueError:
                dt = None
        if dt is None:
            return None
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return int(dt.timestamp() * 1000)


def clip(text, limit: int = 160) -> str:
    if text is None:
        return ""
    text = " ".join(str(text).split())
    return text if len(text) <= limit else text[: limit - 1] + "…"


def strip_extended_path(path: str | None) -> str:
    if not path:
        return ""
    return path[4:] if path.startswith("\\\\?\\") else path


def open_sqlite(path: str):
    """Read-only connection, preferring mode=ro; copies the wallet files only if ro fails."""
    if not os.path.exists(path):
        raise FileNotFoundError(path)
    uri = "file:" + path.replace("\\", "/") + "?mode=ro"
    try:
        conn = sqlite3.connect(uri, uri=True, timeout=2.0)
        conn.row_factory = sqlite3.Row
        conn.execute("select count(*) from sqlite_master").fetchone()
        return conn, None
    except Exception:
        pass
    tmpdir = tempfile.mkdtemp(prefix="agent-console-")
    base = os.path.join(tmpdir, os.path.basename(path))
    shutil.copy2(path, base)
    for suffix in ("-wal", "-shm"):
        if os.path.exists(path + suffix):
            shutil.copy2(path + suffix, base + suffix)
    conn = sqlite3.connect(base)
    conn.row_factory = sqlite3.Row
    return conn, tmpdir


def table_names(conn) -> set[str]:
    return {r[0] for r in conn.execute("select name from sqlite_master where type='table'")}


_PROC_CACHE: list[tuple[int, str]] | None = None


def processes() -> list[tuple[int, str]]:
    global _PROC_CACHE
    if _PROC_CACHE is not None:
        return _PROC_CACHE
    TH32CS_SNAPPROCESS = 0x2

    class PROCESSENTRY32W(ctypes.Structure):
        _fields_ = [
            ("dwSize", wintypes.DWORD), ("cntUsage", wintypes.DWORD),
            ("th32ProcessID", wintypes.DWORD), ("th32DefaultHeapID", ctypes.POINTER(ctypes.c_ulong)),
            ("th32ModuleID", wintypes.DWORD), ("cntThreads", wintypes.DWORD),
            ("th32ParentProcessID", wintypes.DWORD), ("pcPriClassBase", ctypes.c_long),
            ("dwFlags", wintypes.DWORD), ("szExeFile", ctypes.c_wchar * 260),
        ]

    out: list[tuple[int, str]] = []
    try:
        kernel32 = ctypes.windll.kernel32
        snap = kernel32.CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0)
        if snap and snap != -1:
            entry = PROCESSENTRY32W()
            entry.dwSize = ctypes.sizeof(PROCESSENTRY32W)
            if kernel32.Process32FirstW(snap, ctypes.byref(entry)):
                while True:
                    out.append((entry.th32ProcessID, entry.szExeFile))
                    if not kernel32.Process32NextW(snap, ctypes.byref(entry)):
                        break
            kernel32.CloseHandle(snap)
    except Exception as exc:  # pragma: no cover
        ERRORS.append({"app": "system", "message": f"process scan failed: {exc}"})
    _PROC_CACHE = out
    return out


def pids_of(*names: str) -> list[int]:
    wanted = {n.lower() for n in names}
    return [pid for pid, name in processes() if name.lower() in wanted]


def alive(pid) -> bool:
    if not pid:
        return False
    return any(p == int(pid) for p, _ in processes())


def service_running(name: str) -> bool:
    """LocalSystem services do not show up in our process snapshot; ask SCM instead."""
    try:
        out = subprocess.run(
            ["sc.exe", "query", name],
            capture_output=True, text=True, timeout=3,
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
        ).stdout
        return "RUNNING" in out
    except Exception:
        return False


def session_row(sid, title, cwd="", status="idle", step="", last=None) -> dict:
    return {
        "id": str(sid or ""),
        "title": clip(title or "(未命名会话)", 90),
        "cwd": clip(strip_extended_path(cwd), 100),
        "status": status,
        "step": clip(step, 150),
        "lastActivityAt": last,
    }


def card(app: str, display: str, **kw) -> dict:
    base = {
        "app": app,
        "displayName": display,
        "online": False,
        "busy": False,
        "session": None,
        "sessions": [],
        "lastActivityAt": None,
        "pendingApprovals": 0,
        "staleApprovals": 0,
        "canSendPrompt": False,
        "sendMode": "",
        "note": "",
        "detail": "",
    }
    base.update(kw)
    if base["sessions"] and base["session"] is None:
        base["session"] = base["sessions"][0]
    return base


# ----------------------------------------------------------------------------- Codex
def codex_dir() -> str:
    return os.path.join(HOME, ".codex")


def codex_history_connection():
    """thread_history_1 is a WAL database without sidecars; immutable=1 is the
    only reliable read mode (the app's own doctor reports it as degraded)."""
    path = os.path.join(codex_dir(), "thread_history_1.sqlite")
    uri = "file:" + path.replace("\\", "/") + "?mode=ro&immutable=1"
    conn = sqlite3.connect(uri, uri=True, timeout=3)
    conn.row_factory = sqlite3.Row
    return conn


def _mcp_result_text(result) -> str:
    if result is None:
        return ""
    if isinstance(result, str):
        return clip(result, 4000)
    if isinstance(result, dict):
        parts = []
        for part in result.get("content") or []:
            if isinstance(part, dict) and isinstance(part.get("text"), str):
                parts.append(part["text"])
        if parts:
            return clip("\n".join(parts), 4000)
        return clip(json.dumps(result, ensure_ascii=False), 4000)
    return clip(str(result), 4000)


def _event_at(ms):
    """Projection timestamps are already epoch milliseconds; never rescale them."""
    return ms


def codex_item_events(thread_id: str, limit: int = 40) -> list[dict]:
    """Reconstruct a structured transcript from the projected item table.

    This is the fallback for threads whose rollout file was archived or deleted:
    ~270 local threads still have their items here. Items keep their own shape so
    the panel can render commands, MCP calls, diffs and markdown like the app does.
    """
    items: list[dict] = []
    turn_ms: dict[str, int] = {}
    try:
        conn = codex_history_connection()
        try:
            rows = list(conn.execute(
                "select item_type, item_json, created_at_ms, turn_id from thread_items "
                "where thread_id=? order by rollout_ordinal desc limit 400",
                (thread_id,)))
            try:
                for turn in conn.execute(
                    "select turn_id, duration_ms from thread_turns where thread_id=?", (thread_id,)
                ):
                    if turn["duration_ms"] is not None:
                        turn_ms[str(turn["turn_id"])] = int(turn["duration_ms"])
            except Exception:
                turn_ms = {}
        finally:
            conn.close()
    except Exception as exc:
        ERRORS.append({"app": "codex", "message": f"thread_items: {exc}"})
        return []
    seen_turns: set[str] = set()
    for row in reversed(rows):
        try:
            payload = json.loads(row["item_json"] or "{}")
        except Exception:
            continue
        kind = row["item_type"]
        at = _event_at(row["created_at_ms"])
        found = None
        if kind == "userMessage":
            parts = [
                str(part.get("text") or "")
                for part in payload.get("content") or []
                if isinstance(part, dict) and part.get("text")
            ]
            text = "\n".join(parts)
            if text.strip():
                found = {"role": "user", "kind": "message", "text": clip(text, 8000), "at": at}
        elif kind == "agentMessage":
            text = payload.get("text") or ""
            if text.strip():
                found = {
                    "role": "assistant", "kind": "message", "text": clip(text, 12000),
                    "at": at, "phase": payload.get("phase") or "",
                }
                turn_id = str(row["turn_id"] or "")
                # One "用时 N" marker per turn, on its first assistant message.
                if turn_id and turn_id in turn_ms and turn_id not in seen_turns:
                    found["turnMs"] = turn_ms[turn_id]
                    seen_turns.add(turn_id)
        elif kind == "commandExecution":
            found = {
                "role": "assistant", "kind": "command",
                "command": clip(payload.get("command") or "", 8000),
                "output": clip(payload.get("aggregatedOutput") or "", 8000),
                "status": payload.get("status") or "",
                "exitCode": payload.get("exitCode"),
                "durationMs": payload.get("durationMs"),
                "cwd": payload.get("cwd") or "",
                "at": at,
            }
        elif kind == "mcpToolCall":
            found = {
                "role": "assistant", "kind": "mcp",
                "server": payload.get("server") or "",
                "tool": payload.get("tool") or "",
                "status": payload.get("status") or "",
                "arguments": payload.get("arguments") or {},
                "result": _mcp_result_text(payload.get("result")),
                "error": clip(payload.get("error") or "", 1000),
                "durationMs": payload.get("durationMs"),
                "at": at,
            }
        elif kind == "fileChange":
            changes = []
            for change in payload.get("changes") or []:
                if not isinstance(change, dict):
                    continue
                change_kind = change.get("kind")
                if isinstance(change_kind, dict):
                    change_kind = change_kind.get("type")
                changes.append({
                    "path": change.get("path") or "",
                    "changeType": str(change_kind or ""),
                    "diff": clip(change.get("diff") or "", 8000),
                })
            if changes:
                found = {
                    "role": "assistant", "kind": "file", "changes": changes,
                    "status": payload.get("status") or "", "at": at,
                }
        elif kind == "webSearch":
            action = payload.get("action") if isinstance(payload.get("action"), dict) else {}
            queries = [q for q in (action.get("queries") or []) if q]
            if not queries and action.get("query"):
                queries = [action.get("query")]
            if not queries and payload.get("query"):
                queries = [payload.get("query")]
            results = []
            for result in payload.get("results") or []:
                if isinstance(result, dict):
                    results.append({
                        "domain": result.get("domain") or "",
                        "snippet": clip(result.get("snippet") or "", 500),
                    })
            found = {"role": "assistant", "kind": "search", "queries": queries,
                     "results": results[:6], "at": at}
        elif kind == "plan":
            text = payload.get("text") or ""
            if text.strip():
                found = {"role": "assistant", "kind": "message", "text": clip(text, 12000),
                         "at": at, "phase": "plan"}
        elif kind in ("imageView", "subAgentActivity", "contextCompaction"):
            label = {
                "imageView": "查看图片",
                "subAgentActivity": "子代理活动",
                "contextCompaction": "上下文压缩",
            }[kind]
            found = {"role": "system", "kind": "event", "text": label, "at": at}
        if found:
            items.append(found)
    return items[-limit:]


def codex_thread_steps(thread_ids: list[str]) -> dict[str, str]:
    """Last agent message per thread, used as the session list's one-line step."""
    steps: dict[str, str] = {}
    if not thread_ids:
        return steps
    try:
        conn = codex_history_connection()
        try:
            for tid in thread_ids:
                row = conn.execute(
                    "select item_json from thread_items where thread_id=? and item_type='agentMessage' "
                    "order by created_at_ms desc limit 1", (tid,)).fetchone()
                if not row:
                    continue
                try:
                    payload = json.loads(row["item_json"] or "{}")
                except Exception:
                    continue
                text = payload.get("text") or ""
                if text.strip():
                    steps[tid] = clip(text, 150)
        finally:
            conn.close()
    except Exception as exc:
        ERRORS.append({"app": "codex", "message": f"thread steps: {exc}"})
    return steps


def collect_codex() -> dict:
    root = codex_dir()
    procs = pids_of("ChatGPT.exe")
    result = card("codex", "Codex", online=bool(procs), canSendPrompt=True, sendMode="append")
    if not os.path.isdir(root):
        result["note"] = "未安装 / 无数据目录"
        return result

    active: set[str] = set()
    rows = []
    try:
        conn, tmp = open_sqlite(os.path.join(root, "sqlite", "codex.db"))
        try:
            tables = table_names(conn)
            if "active_chat_turns" in tables:
                for row in conn.execute("select thread_id, observed_at_ms from active_chat_turns"):
                    active.add(str(row["thread_id"]))
                    result["lastActivityAt"] = iso_to_ms(row["observed_at_ms"])
            if "local_thread_catalog" in tables:
                cols = {r[1] for r in conn.execute("pragma table_info(local_thread_catalog)")}
                order = "source_updated_at" if "source_updated_at" in cols else "rowid"
                extra = ", source_kind" if "source_kind" in cols else ""
                extra += ", host_id" if "host_id" in cols else ""
                rows = list(conn.execute(
                    f"select thread_id, display_title, cwd, source_updated_at{extra} "
                    f"from local_thread_catalog order by {order} desc limit 200"))
            if "inbox_items" in tables:
                result["pendingApprovals"] = int(list(conn.execute(
                    "select count(*) from inbox_items where read_at is null"))[0][0])
        finally:
            conn.close()
            if tmp:
                shutil.rmtree(tmp, ignore_errors=True)
    except Exception as exc:
        ERRORS.append({"app": "codex", "message": f"sqlite: {exc}"})

    # Local history: state_5 holds every thread the desktop ever ran, including
    # archived ones the catalog no longer lists. Their rollout may be gone, but
    # the thread_history projection still has the items.
    history = []
    try:
        conn, tmp = open_sqlite(os.path.join(root, "state_5.sqlite"))
        try:
            if "threads" in table_names(conn):
                cols = {r[1] for r in conn.execute("pragma table_info(threads)")}
                sel = "id, title, cwd, updated_at_ms, archived, thread_source"
                sel += ", first_user_message" if "first_user_message" in cols else ", null as first_user_message"
                sel += ", preview" if "preview" in cols else ", null as preview"
                history = list(conn.execute(
                    f"select {sel} from threads "
                    f"where coalesce(thread_source,'user') not in ('guardian_review','subagent')"))
        finally:
            conn.close()
            if tmp:
                shutil.rmtree(tmp, ignore_errors=True)
    except Exception as exc:
        ERRORS.append({"app": "codex", "message": f"state_5 history: {exc}"})

    catalog = {}
    for row in rows:
        sid = str(row["thread_id"])
        kind = (row["source_kind"] or "") if "source_kind" in row.keys() else ""
        host = (row["host_id"] or "") if "host_id" in row.keys() else ""
        catalog[sid] = {
            "title": (row["display_title"] or "").strip(),
            "cwd": row["cwd"] or "",
            "source": "chatgpt" if (kind == "chatgpt" or host.startswith("chatgpt:")) else "local",
            "last": iso_to_ms(row["source_updated_at"]),
        }

    sessions = []
    seen = set()
    for row in history:
        sid = str(row["id"])
        cat = catalog.get(sid, {})
        title = (row["title"] or "").strip() or cat.get("title") \
            or clip((row["first_user_message"] or row["preview"] or "").strip(), 60)
        if not title:
            cwd_hint = row["cwd"] or cat.get("cwd") or ""
            title = os.path.basename(cwd_hint.rstrip("\\/")) if cwd_hint else "(未命名会话)"
        if title.lower().startswith(CODEX_GUARDIAN_TITLE):
            continue
        item = session_row(
            sid, title, row["cwd"] or cat.get("cwd") or "",
            status="busy" if sid in active else "idle",
            step="",
            last=iso_to_ms(row["updated_at_ms"]) or cat.get("last"),
        )
        item["source"] = "local"
        item["archived"] = bool(row["archived"])
        sessions.append(item)
        seen.add(sid)
    for sid, cat in catalog.items():
        if sid in seen:
            continue
        title = cat["title"]
        if title.lower().startswith(CODEX_GUARDIAN_TITLE):
            continue
        item = session_row(
            sid, title, cat["cwd"],
            status="busy" if sid in active else "idle",
            step="", last=cat["last"],
        )
        item["source"] = cat["source"]
        item["archived"] = False
        sessions.append(item)

    def group(item):
        if item["source"] == "local":
            return 1 if item.get("archived") else 0
        return 2

    sessions.sort(key=lambda s: (
        group(s), 0 if s["status"] == "busy" else 1, -(s["lastActivityAt"] or 0)))
    recent_local = [s for s in sessions if group(s) == 0]
    archived_local = [s for s in sessions if group(s) == 1]
    cloud = [s for s in sessions if group(s) == 2]
    shown = recent_local[:20] + archived_local[:12] + cloud[:8]

    # Steps only for the threads actually shown (projection lookup per thread).
    steps = codex_thread_steps([s["id"] for s in shown])
    for item in shown:
        item["step"] = steps.get(item["id"], "")

    result["sessions"] = shown
    result["busy"] = bool(active)
    if shown:
        result["session"] = shown[0]
        result["lastActivityAt"] = result["lastActivityAt"] or shown[0]["lastActivityAt"]
        parts = [f"{len(recent_local) + len(archived_local)} 个本机会话"]
        if archived_local:
            parts.append(f"{len(archived_local)} 个已归档")
        if cloud:
            parts.append(f"{len(cloud)} 个云端")
        if result["busy"]:
            parts.insert(0, "运行中")
        result["note"] = " · ".join(parts)
    elif not result["online"]:
        result["note"] = "离线，无可用会话"
    else:
        result["note"] = "已安装并运行，当前空闲"
        fallback = newest_rollout(root)
        if fallback:
            result["lastActivityAt"] = int(os.path.getmtime(fallback) * 1000)
    result["detail"] = f"{len(procs)} 个进程"
    return result


def newest_rollout(root: str) -> str | None:
    sessions_dir = os.path.join(root, "sessions")
    newest = None
    try:
        for dirpath, _dirs, files in os.walk(sessions_dir):
            for name in files:
                if name.endswith(".jsonl"):
                    path = os.path.join(dirpath, name)
                    if newest is None or os.path.getmtime(path) > os.path.getmtime(newest):
                        newest = path
    except OSError:
        return None
    return newest


# ----------------------------------------------------------------------------- Grok Bot
def grok_dir() -> str:
    appdata = os.environ.get("APPDATA", os.path.join(HOME, "AppData", "Roaming"))
    return os.path.join(appdata, "Grok Bot")


def grok_roster() -> dict | None:
    slots = os.path.join(grok_dir(), "sand-client-persistence")
    if not os.path.isdir(slots):
        return None
    for name in os.listdir(slots):
        path = os.path.join(slots, name)
        if not os.path.isfile(path) or os.path.getsize(path) > 4 * 1024 * 1024:
            continue
        try:
            doc = read_json(path)
        except Exception:
            continue
        value = doc.get("value") if isinstance(doc, dict) else None
        if isinstance(value, dict) and isinstance(value.get("rows"), list):
            return value
    return None


def collect_grok() -> dict:
    data_dir = grok_dir()
    status_file = os.path.join(data_dir, "desktop-status.json")
    daemon_file = os.path.join(HOME, ".grokbot", "local-exec-daemon.json")
    result = card("grokbot", "Grok Bot", canSendPrompt=True, sendMode="ui-automation")
    online = False
    if os.path.exists(status_file):
        try:
            status = read_json(status_file)
            online = alive(status.get("pid"))
            if not online:
                result["note"] = "上次运行已退出（仅本地副本可读）"
        except Exception as exc:
            ERRORS.append({"app": "grokbot", "message": f"desktop-status: {exc}"})
    # A restarted app leaves the recorded pid stale; trust the process name too.
    if not online and pids_of("Grok Bot.exe"):
        online = True
        result["note"] = ""
    if os.path.exists(daemon_file):
        try:
            daemon = read_json(daemon_file)
            online = online or alive(daemon.get("pid"))
            if int(daemon.get("inflightCount") or 0) > 0:
                result["busy"] = True
        except Exception as exc:
            ERRORS.append({"app": "grokbot", "message": f"local-exec-daemon: {exc}"})
    result["online"] = online

    roster = grok_roster()
    if roster:
        rows = [r for r in (roster.get("rows") or []) if isinstance(r, dict)]
        sessions = []
        for row in rows:
            entry = row.get("lastEntry") or {}
            text = entry.get("text") if isinstance(entry, dict) else entry
            last = iso_to_ms(row.get("lastActivityAt"))
            sessions.append(session_row(
                row.get("id"), row.get("name"), "",
                status="waiting" if row.get("awaitingUserResponse") else "idle",
                step=text, last=last,
            ))
        sessions.sort(key=lambda s: -(s["lastActivityAt"] or 0))
        result["sessions"] = sessions
        if sessions:
            result["session"] = sessions[0]
            result["lastActivityAt"] = sessions[0]["lastActivityAt"]
        result["pendingApprovals"] = sum(1 for s in sessions if s["status"] == "waiting")
        result["note"] = f"共 {len(sessions)} 个 Bot · 云优先，仅本地副本"
        if online:
            result["note"] += " · 在线"
    elif online:
        result["note"] = "已运行，但未读到 roster 快照"
    result["detail"] = "sand-client-persistence" if roster else "无本地副本"
    return result


# ----------------------------------------------------------------------------- Marvis
def marvis_db() -> str:
    return os.path.join(HOME, ".marvis", "database", "data.db")


DONE_CONVERSATION = {"completed", "cancelled", "canceled", "failed", "archived"}
STALE_APPROVAL_MS = 7 * 24 * 3600 * 1000


def marvis_approval_state(conn) -> tuple[dict, dict, int, int]:
    """Split pending approval rows into actionable vs stale.

    Marvis leaves `status='pending'` rows behind after a conversation ends: the
    agent moved on (the conversation completed) but the row was never written
    back. Its own UI only shows approvals inside a live run, so a raw
    `status='pending'` count reports approvals the user cannot act on.

    Returns (actionable_by_conversation, stale_by_conversation, actionable, stale).
    """
    actionable: dict[str, int] = {}
    stale: dict[str, int] = {}
    try:
        rows = list(conn.execute(
            "select a.approval_id, a.conversation_id, a.status, a.created_at, "
            "c.status as conv_status, c.updated_at as conv_updated "
            "from approvals a left join conversations c on c.conversation_id = a.conversation_id"
        ))
    except Exception:
        return actionable, stale, 0, 0
    for row in rows:
        if (row["status"] or "").lower() != "pending":
            continue
        conv = str(row["conversation_id"] or "")
        conv_status = (row["conv_status"] or "").lower()
        created = iso_to_ms(row["created_at"])
        too_old = bool(created) and (NOW_MS - created) > STALE_APPROVAL_MS
        if conv_status in DONE_CONVERSATION or not conv_status or too_old:
            stale[conv] = stale.get(conv, 0) + 1
        else:
            actionable[conv] = actionable.get(conv, 0) + 1
    return actionable, stale, sum(actionable.values()), sum(stale.values())


def collect_marvis() -> dict:
    gui = pids_of("Marvis.exe", "MarvisAgent.exe")
    svc = pids_of("MarvisSvr.exe")
    # The auto-start service keeps running after the client is closed; it does not
    # mean the user has Marvis open, so it never counts as "on duty".
    result = card(
        "marvis", "Marvis",
        online=bool(gui),
        canSendPrompt=True,
        sendMode="ui-automation",
    )
    if not os.path.exists(marvis_db()):
        result["note"] = "未找到数据目录"
        return result
    try:
        conn, tmp = open_sqlite(marvis_db())
        try:
            tables = table_names(conn)
            actionable, stale, pending, stale_count = marvis_approval_state(conn) \
                if "approvals" in tables else ({}, {}, 0, 0)
            sessions = []
            if "conversations" in tables:
                has_act = "agent_activities" in tables
                act_sql = (
                    "(select a.content from agent_activities a where a.conversation_id=c.conversation_id "
                    "order by a.activity_time desc limit 1)" if has_act else "''"
                )
                for row in conn.execute(
                    f"select c.conversation_id, c.title, c.status, c.updated_at, {act_sql} as act "
                    f"from conversations c order by c.updated_at desc limit ?",
                    (SESSION_LIMIT,),
                ):
                    item = session_row(
                        row["conversation_id"], row["title"], "",
                        status="idle" if (row["status"] or "") in ("completed", "failed", "") else (row["status"] or "idle"),
                        step=row["act"] or "", last=iso_to_ms(row["updated_at"]),
                    )
                    conv = str(row["conversation_id"])
                    item["pending"] = actionable.get(conv, 0)
                    item["stalePending"] = stale.get(conv, 0)
                    sessions.append(item)
            usage = None
            if "llm_token_usage" in tables:
                row = conn.execute("select sum(total_tokens), count(*) from llm_token_usage").fetchone()
                usage = (row[0], row[1]) if row else None
            result["sessions"] = sessions
            if sessions:
                result["session"] = sessions[0]
                result["lastActivityAt"] = sessions[0]["lastActivityAt"]
            result["pendingApprovals"] = pending
            result["staleApprovals"] = stale_count
            bits = []
            if gui:
                bits.append("客户端运行中")
            elif service_running("MarvisSvr"):
                bits.append("客户端已关闭（常驻服务 MarvisSvr 在跑）")
            else:
                bits.append("未运行")
            if pending:
                bits.append(f"{pending} 项待你确认")
            if stale_count:
                bits.append(f"{stale_count} 项历史待确认（会话已结束）")
            if usage and usage[0]:
                bits.append(f"累计 {usage[0]:,} tokens")
            result["note"] = " · ".join(bits) or "未运行"
            result["detail"] = f"data.db · {len(sessions)} 个会话"
        finally:
            conn.close()
            if tmp:
                shutil.rmtree(tmp, ignore_errors=True)
    except Exception as exc:
        ERRORS.append({"app": "marvis", "message": f"sqlite: {exc}"})
        result["note"] = "数据库读取失败（可能正被占用）"
    return result


# ----------------------------------------------------------------------------- WorkBuddy
DONE_STATUS = {"completed", "failed", "canceled", "cancelled", "archived"}


def workbuddy_root() -> str:
    return os.path.join(HOME, ".workbuddy")


def collect_workbuddy() -> dict:
    root = workbuddy_root()
    db_path = os.path.join(root, "workbuddy.db")
    result = card("workbuddy", "WorkBuddy", canSendPrompt=True, sendMode="new-run")
    result["online"] = bool(pids_of("WorkBuddy.exe"))

    sessions_dir = os.path.join(root, "sessions")
    newest_beat = 0
    if os.path.isdir(sessions_dir):
        for name in os.listdir(sessions_dir):
            if not name.endswith(".json"):
                continue
            try:
                beat = read_json(os.path.join(sessions_dir, name))
            except Exception:
                continue
            if isinstance(beat, dict) and beat.get("lastHeartbeat") and alive(beat.get("pid")):
                newest_beat = max(newest_beat, iso_to_ms(beat["lastHeartbeat"]) or 0)
    if newest_beat and NOW_MS - newest_beat < 90_000:
        result["online"] = True
        result["busy"] = True

    if not os.path.exists(db_path):
        result["note"] = result["note"] or "未找到 workbuddy.db"
        return result
    try:
        conn, tmp = open_sqlite(db_path)
        try:
            tables = table_names(conn)
            sessions = []
            if "sessions" in tables:
                cols = {r[1] for r in conn.execute("pragma table_info(sessions)")}
                where = "where deleted_at is null " if "deleted_at" in cols else ""
                for row in conn.execute(
                    f"select id, title, status, model, last_activity_at, cwd from sessions {where}"
                    f"order by last_activity_at desc limit ?",
                    (SESSION_LIMIT,),
                ):
                    status = (row["status"] or "idle").lower()
                    sessions.append(session_row(
                        row["id"], row["title"], row["cwd"],
                        status="busy" if status not in DONE_STATUS else status,
                        step=f"{row['model'] or '?'} · {row['status'] or '?'}",
                        last=iso_to_ms(row["last_activity_at"]),
                    ))
            automations = 0
            if "automations" in tables:
                automations = int(list(conn.execute(
                    "select count(*) from automations" + (" where deleted_at is null" if "deleted_at" in {r[1] for r in conn.execute('pragma table_info(automations)')} else "")))[0][0])
            usage = None
            if "session_usage" in tables:
                row = conn.execute("select sum(used), sum(size) from session_usage").fetchone()
                usage = (row[0], row[1]) if row else None
            result["sessions"] = sessions
            if sessions:
                result["session"] = sessions[0]
                result["lastActivityAt"] = sessions[0]["lastActivityAt"]
            if any(s["status"] == "busy" for s in sessions):
                result["busy"] = True
            bits = []
            if automations:
                bits.append(f"{automations} 个定时任务")
            if usage and usage[0]:
                bits.append(f"用量 {usage[0]:,}")
            if not result["online"]:
                bits.append("未运行")
            result["note"] = result["note"] if result["note"] and result["note"] != "" else " · ".join(bits)
            result["detail"] = "workbuddy.db"
        finally:
            conn.close()
            if tmp:
                shutil.rmtree(tmp, ignore_errors=True)
    except Exception as exc:
        ERRORS.append({"app": "workbuddy", "message": f"sqlite: {exc}"})
    return result


# ----------------------------------------------------------------------------- detail mode
def event(role: str, kind: str, text: str, at=None) -> dict:
    return {"role": role, "kind": kind, "text": clip(text, 1500), "at": at}


def tail_lines(path: str, max_bytes: int = 400_000) -> list[str]:
    size = os.path.getsize(path)
    with open(path, "rb") as fh:
        if size > max_bytes:
            fh.seek(size - max_bytes)
            fh.readline()  # drop the partial first line
        data = fh.read()
    return data.decode("utf-8", "replace").splitlines()


def find_rollout(thread_id: str) -> tuple[str | None, bool]:
    """Locate a thread's rollout file by name. Returns (path, compressed)."""
    root = os.path.join(codex_dir(), "sessions")
    compressed = None
    if not os.path.isdir(root):
        return None, False
    for dirpath, _dirs, files in os.walk(root):
        for name in files:
            if thread_id not in name:
                continue
            path = os.path.join(dirpath, name)
            if name.endswith(".jsonl"):
                return path, False
            if name.endswith(".jsonl.zst"):
                compressed = path
    return (compressed, True) if compressed else (None, False)


def codex_catalog_meta(thread_id: str) -> tuple[str, str, str]:
    """(title, cwd, source) from the catalog; source is 'chatgpt' for cloud threads."""
    try:
        conn, tmp = open_sqlite(os.path.join(codex_dir(), "sqlite", "codex.db"))
        try:
            if "local_thread_catalog" not in table_names(conn):
                return "", "", "local"
            cols = {r[1] for r in conn.execute("pragma table_info(local_thread_catalog)")}
            sel = "display_title, cwd"
            sel += ", source_kind" if "source_kind" in cols else ", '' as source_kind"
            sel += ", host_id" if "host_id" in cols else ", '' as host_id"
            row = conn.execute(
                f"select {sel} from local_thread_catalog where thread_id=? limit 1",
                (thread_id,)).fetchone()
            if not row:
                return "", "", "local"
            kind = str(row["source_kind"] or "")
            host = str(row["host_id"] or "")
            source = "chatgpt" if (kind == "chatgpt" or host.startswith("chatgpt:")) else "local"
            return (row["display_title"] or "", row["cwd"] or "", source)
        finally:
            conn.close()
            if tmp:
                shutil.rmtree(tmp, ignore_errors=True)
    except Exception:
        return "", "", "local"


def detail_codex(session_id: str) -> dict:
    title, cwd, source = codex_catalog_meta(session_id)
    rollout = None
    first_user = preview = ""
    try:
        conn, tmp = open_sqlite(os.path.join(codex_dir(), "state_5.sqlite"))
        try:
            if "threads" in table_names(conn):
                row = conn.execute(
                    "select rollout_path, cwd, title, first_user_message, preview from threads "
                    "where id=? limit 1", (session_id,)).fetchone()
                if row:
                    rollout = row["rollout_path"] or None
                    cwd = row["cwd"] or cwd
                    title = row["title"] or title
                    first_user = row["first_user_message"] or ""
                    preview = row["preview"] or ""
        finally:
            conn.close()
            if tmp:
                shutil.rmtree(tmp, ignore_errors=True)
    except Exception as exc:
        ERRORS.append({"app": "codex", "message": f"state_5: {exc}"})

    compressed = False
    if not rollout or not os.path.exists(rollout):
        rollout, compressed = find_rollout(session_id)

    baseline = {
        "app": "codex", "id": session_id,
        "title": clip(title or "(会话)", 120), "cwd": strip_extended_path(cwd),
        "status": "", "source": source,
    }

    # Structured items first: they carry command output, MCP results and diffs,
    # which the panel renders as cards instead of raw text.
    structured = codex_item_events(session_id)
    if structured:
        baseline["note"] = "来自 thread_history 投影（结构化条目）"
        baseline["events"] = structured[-40:]
        return baseline

    if compressed and rollout and os.path.exists(rollout):
        return {
            **baseline, "events": [],
            "compressed": True, "path": rollout,
            "compressedBytes": os.path.getsize(rollout),
            "note": "rollout 已压缩且无投影，交由 Host 流式解压读取",
        }

    events: list[dict] = []
    note = ""
    if rollout and os.path.exists(rollout):
        try:
            for line in tail_lines(rollout)[-400:]:
                line = line.strip()
                if not line:
                    continue
                try:
                    obj = json.loads(line)
                except Exception:
                    continue
                kind = obj.get("type")
                payload = obj.get("payload") or {}
                stamp = obj.get("timestamp")
                if kind == "response_item":
                    ptype = payload.get("type")
                    if ptype == "message":
                        content = payload.get("content") or []
                        parts = []
                        for part in content:
                            if not isinstance(part, dict):
                                continue
                            text = part.get("text") or part.get("content") or ""
                            if isinstance(text, str):
                                parts.append(text)
                        text = "".join(parts)
                        role = payload.get("role") or "assistant"
                        if text.strip():
                            events.append(event("system" if role == "developer" else role,
                                                "message", clip(text, 12000), stamp))
                    elif ptype in ("function_call", "custom_tool_call"):
                        raw = payload.get("arguments") or payload.get("input") or ""
                        if not isinstance(raw, str):
                            raw = json.dumps(raw, ensure_ascii=False)
                        events.append({
                            "role": "assistant", "kind": "tool",
                            "tool": payload.get("name") or "tool",
                            "input": clip(raw, 8000), "at": stamp,
                        })
                    elif ptype == "agent_message":
                        text = payload.get("message") or payload.get("text") or ""
                        if text:
                            events.append(event("assistant", "message", clip(text, 12000), stamp))
                elif kind == "event_msg" and payload.get("type") in ("task_started", "task_complete", "turn_aborted"):
                    events.append(event("system", "event", payload.get("type"), stamp))
        except Exception as exc:
            ERRORS.append({"app": "codex", "message": f"rollout: {exc}"})
        if events:
            note = "来自 rollout 事件流（尾部 400 行）"

    if not events:
        text = (first_user or preview or "").strip()
        if text:
            events = [event("user", "message", text, None)]
            note = "正文已不在本地，仅恢复了首条消息（来自会话元数据）"
        elif source == "chatgpt":
            note = "ChatGPT 云端会话：正文保存在账号侧，本机只有标题与时间；可在 ChatGPT/Codex 客户端里打开"
        else:
            note = "本地没有该会话的正文记录（rollout 与投影都不存在）"

    baseline["note"] = note
    baseline["events"] = events[-40:]
    return baseline



def detail_marvis(session_id: str) -> dict:
    title = status = note = ""
    events = []
    try:
        conn, tmp = open_sqlite(marvis_db())
        try:
            tables = table_names(conn)
            if "conversations" in tables:
                row = conn.execute(
                    "select title, status from conversations where conversation_id=? limit 1",
                    (session_id,)).fetchone()
                if row:
                    title, status = row["title"], row["status"]
            if "messages" in tables:
                rows = list(conn.execute(
                    "select role, content, tool_name, created_at from messages "
                    "where conversation_id=? order by message_seq desc limit 40",
                    (session_id,)))
                for row in reversed(rows):
                    role = (row["role"] or "assistant").lower()
                    text = row["content"] or ""
                    at = row["created_at"]
                    if role == "tool" or row["tool_name"]:
                        events.append({
                            "role": "assistant", "kind": "tool",
                            "tool": row["tool_name"] or "tool",
                            "output": clip(text, 8000), "at": at,
                        })
                    else:
                        events.append(event(role, "message", clip(text, 8000), at))
            if "agent_activities" in tables:
                for row in conn.execute(
                    "select agent_name, content, status, activity_time from agent_activities "
                    "where conversation_id=? order by activity_time desc limit 5",
                    (session_id,),
                ):
                    events.append(event("system", "activity",
                                        f"{row['agent_name']} · {row['status']}: {row['content']}",
                                        row["activity_time"]))
            stale_here = 0
            if "approvals" in tables:
                conv_status = (status or "").lower()
                done = conv_status in DONE_CONVERSATION
                for row in conn.execute(
                    "select tool_name, status, created_at, decided_at from approvals "
                    "where conversation_id=? order by created_at desc limit 10",
                    (session_id,),
                ):
                    raw = (row["status"] or "").lower()
                    label = raw
                    if raw == "pending" and done:
                        label = "pending（历史残留：会话已结束，Marvis 界面不再展示）"
                        stale_here += 1
                    events.append(event("system", "approval",
                                        f"{row['tool_name']} · {label}", row["created_at"]))
            note = "来自 Marvis messages / agent_activities"
            if stale_here:
                note += f" · 该会话有 {stale_here} 条 pending 审批记录，但会话已结束，属于数据库残留"
        finally:
            conn.close()
            if tmp:
                shutil.rmtree(tmp, ignore_errors=True)
    except Exception as exc:
        ERRORS.append({"app": "marvis", "message": f"detail: {exc}"})
        note = "读取失败"
    events.sort(key=lambda e: iso_to_ms(e["at"]) or 0)
    return {"app": "marvis", "id": session_id, "title": clip(title, 120), "cwd": "",
            "status": status or "", "note": note, "events": events[-40:]}


def detail_grok(session_id: str) -> dict:
    roster = grok_roster()
    title = note = ""
    events = []
    if roster:
        for row in roster.get("rows") or []:
            if str(row.get("id")) != str(session_id):
                continue
            title = row.get("name") or ""
            entry = row.get("lastEntry") or {}
            text = entry.get("text") if isinstance(entry, dict) else entry
            if text:
                events.append(event("assistant", "message", text, iso_to_ms(row.get("lastActivityAt"))))
            note = "本机只缓存每个 Bot 的最后一条消息与元数据；完整会话在 Grok 云端。"
            break
    return {"app": "grokbot", "id": session_id, "title": clip(title, 120), "cwd": "",
            "status": "", "note": note or "未找到该 Bot 的本地副本", "events": events}


def detail_workbuddy(session_id: str) -> dict:
    title = status = cwd = ""
    note = ""
    events = []
    try:
        conn, tmp = open_sqlite(os.path.join(workbuddy_root(), "workbuddy.db"))
        try:
            if "sessions" in table_names(conn):
                row = conn.execute(
                    "select title, status, model, cwd, created_at, updated_at, last_activity_at "
                    "from sessions where id=? limit 1", (session_id,)).fetchone()
                if row:
                    title, status, cwd = row["title"] or "", row["status"] or "", row["cwd"] or ""
                    note = f"model={row['model']} · created={row['created_at']} · updated={row['updated_at']}"
        finally:
            conn.close()
            if tmp:
                shutil.rmtree(tmp, ignore_errors=True)
    except Exception as exc:
        ERRORS.append({"app": "workbuddy", "message": f"detail: {exc}"})

    # The CLI writes the session's task list under tasks/<session id>/N.json.
    tasks_dir = os.path.join(workbuddy_root(), "tasks", session_id)
    if os.path.isdir(tasks_dir):
        files = [f for f in os.listdir(tasks_dir) if f.endswith(".json")]
        files.sort(key=lambda f: (len(f), f))
        for name in files:
            try:
                task = read_json(os.path.join(tasks_dir, name))
            except Exception:
                continue
            subject = (task or {}).get("subject") or ""
            state = (task or {}).get("status") or ""
            if subject:
                events.append(event("system", "todo", f"{state}: {subject}", None))

    # Conversation body: projects/<cwd-slug>/<session id>.jsonl (preferred source).
    transcript = None
    projects = os.path.join(workbuddy_root(), "projects")
    if os.path.isdir(projects):
        for slug in os.listdir(projects):
            candidate = os.path.join(projects, slug, f"{session_id}.jsonl")
            if os.path.isfile(candidate):
                transcript = candidate
                break
    if transcript:
        try:
            for line in tail_lines(transcript)[-400:]:
                line = line.strip()
                if not line:
                    continue
                try:
                    obj = json.loads(line)
                except Exception:
                    continue
                kind = obj.get("type")
                stamp = obj.get("timestamp")
                if kind == "ai-title" and obj.get("aiTitle"):
                    title = title or obj["aiTitle"]
                    continue
                if kind != "message":
                    continue
                role = obj.get("role") or "assistant"
                content = obj.get("content") or []
                parts = []
                if isinstance(content, str):
                    parts.append(content)
                elif isinstance(content, list):
                    for part in content:
                        if isinstance(part, dict):
                            text = part.get("text") or part.get("content") or ""
                            if isinstance(text, str):
                                parts.append(text)
                        elif isinstance(part, str):
                            parts.append(part)
                text = "".join(parts)
                if text.strip():
                    events.append(event(role, "message", text, stamp))
        except Exception as exc:
            ERRORS.append({"app": "workbuddy", "message": f"transcript: {exc}"})

    # Fallback: session-facing log lines that mention the session id.
    if not transcript and os.path.isdir(os.path.join(workbuddy_root(), "logs")):
        logs_root = os.path.join(workbuddy_root(), "logs")
        for dirpath, _dirs, files in os.walk(logs_root):
            for name in files:
                if not name.endswith(".log") or session_id[:8] not in name:
                    continue
                path = os.path.join(dirpath, name)
                try:
                    for line in tail_lines(path, 200_000)[-120:]:
                        try:
                            obj = json.loads(line)
                        except Exception:
                            continue
                        for key in ("text", "content", "message"):
                            value = obj.get(key)
                            if isinstance(value, str) and value.strip():
                                events.append(event(obj.get("role") or "system", "log",
                                                    f"{obj.get('scope', '')} {value}",
                                                    obj.get("time") or obj.get("timestamp")))
                                break
                except Exception:
                    continue
    if transcript:
        note = (note + " · " if note else "") + "正文来自 projects 会话日志"
    elif not events:
        note = (note + " · " if note else "") + "该客户端未把对话正文以可读格式落盘"
    return {"app": "workbuddy", "id": session_id, "title": clip(title, 120),
            "cwd": strip_extended_path(cwd), "status": status,
            "note": note or "仅会话元数据",
            "events": events[-40:]}


DETAILS = {
    "codex": detail_codex,
    "grokbot": detail_grok,
    "marvis": detail_marvis,
    "workbuddy": detail_workbuddy,
}


# ----------------------------------------------------------------------------- discovery
# Other AI agent apps on this machine. They get a card with install/data locations
# and liveness, but no sessions or send channel until someone writes an adapter.
AGENT_KEYWORDS = (
    "codex", "chatgpt", "openai", "claude", "anthropic", "cursor", "windsurf",
    "copilot", "gemini", "aider", "cline", "continue", "opencode", "qwen",
    "tongyi", "kimi", "moonshot", "doubao", "yuanbao", "marvis", "workbuddy",
    "codebuddy", "grok", "perplexity", "chatbox", "lobe-chat", "cherry studio",
    "ollama", "lm studio", "lmstudio", "dify", "coze", "trae", "qoder",
    "comate", "lingma", "通义", "千问", "文心", "豆包", "元宝", "智谱",
)

# Vendor container dirs (OpenAI\Codex, Anthropic\Claude CLI state) and the Tencent
# CodeBuddy extension belong to agents that already have explicit adapters.
KNOWN_ADAPTER_KEYS = (
    "codex", "chatgpt", "openai", "grok", "marvis", "workbuddy", "codebuddy",
    "anthropic", "claude", "deepseek harness",
)

UNINSTALL_ROOTS = (
    (winreg.HKEY_LOCAL_MACHINE, r"SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall"),
    (winreg.HKEY_LOCAL_MACHINE, r"SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall"),
    (winreg.HKEY_CURRENT_USER, r"SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall"),
)

PROCESS_ALIASES = {
    "copilot": "Copilot.exe",
    "gemini": "Gemini.exe",
    "doubao": "Doubao.exe",
    "claude": "Claude.exe",
    "cursor": "Cursor.exe",
}

DISCOVER_LIMIT = 10


def _slugify(name: str) -> str:
    slug = re.sub(r"[^a-z0-9]+", "-", name.lower()).strip("-")
    return (slug or "app")[:40]


def _matches_agent(name: str) -> bool:
    low = name.lower()
    if not any(keyword in low for keyword in AGENT_KEYWORDS):
        return False
    return not any(keyword in low for keyword in KNOWN_ADAPTER_KEYS)


def _dir_activity(path: str) -> int | None:
    try:
        latest = os.stat(path).st_mtime
    except OSError:
        return None
    try:
        for entry in os.scandir(path):
            try:
                latest = max(latest, entry.stat().st_mtime)
            except OSError:
                continue
    except OSError:
        pass
    return int(latest * 1000)


def discover_agents() -> list[dict]:
    candidates: dict[str, dict] = {}

    def remember(display: str, install: str = "", data: str = "", source: str = "") -> None:
        display = " ".join(str(display).split())
        if not display or not _matches_agent(display):
            return
        slug = _slugify(display)
        entry = candidates.setdefault(slug, {"display": display, "install": "", "data": set(), "sources": set()})
        if install and not entry["install"]:
            entry["install"] = install
        if data:
            entry["data"].add(data)
        if source:
            entry["sources"].add(source)

    # 1) Installed programs (registry uninstall entries).
    for hive, sub in UNINSTALL_ROOTS:
        try:
            root_key = winreg.OpenKey(hive, sub)
        except OSError:
            continue
        try:
            count = winreg.QueryInfoKey(root_key)[0]
        except OSError:
            count = 0
        for index in range(count):
            try:
                child = winreg.EnumKey(root_key, index)
                with winreg.OpenKey(root_key, child) as item:
                    display = winreg.QueryValueEx(item, "DisplayName")[0]
                    try:
                        location = winreg.QueryValueEx(item, "InstallLocation")[0]
                    except OSError:
                        location = ""
                remember(str(display), install=str(location or ""), source="registry")
            except OSError:
                continue

    # 2) Per-user program folders and app data folders (install or state).
    for base, prefix, source in (
        (os.path.join(os.environ.get("LOCALAPPDATA", ""), "Programs"), "", "programs"),
        (os.environ.get("APPDATA", ""), "", "roaming"),
        (os.environ.get("LOCALAPPDATA", ""), "", "local"),
        (HOME, ".", "home"),
    ):
        if not base or not os.path.isdir(base):
            continue
        try:
            names = os.listdir(base)
        except OSError:
            continue
        for name in names:
            display = name[1:].replace("-", " ") if prefix and name.startswith(prefix) else name
            if not _matches_agent(display):
                continue
            path = os.path.join(base, name)
            if not os.path.isdir(path):
                continue
            remember(display, install=path if source == "programs" else "", data=path, source=source)

    process_names = {name.lower() for _pid, name in processes()}
    cards: list[dict] = []
    for slug, entry in candidates.items():
        display = entry["display"]
        install = entry["install"]
        data_dirs = sorted(entry["data"])
        if install and install not in data_dirs:
            activity = _dir_activity(install)
        else:
            activity = None
        for path in data_dirs:
            value = _dir_activity(path)
            if value and (activity is None or value > activity):
                activity = value

        exe_candidates = {
            f"{display}.exe".lower(),
            f"{display.replace(' ', '')}.exe".lower(),
        }
        alias = PROCESS_ALIASES.get(slug.split("-")[0])
        if alias:
            exe_candidates.add(alias.lower())
        online = bool(process_names & exe_candidates)

        bits = ["已发现"]
        if online:
            bits.append("运行中")
        if install:
            install_name = os.path.basename(install.rstrip("\\"))
            if install_name.lower() in ("application", "app", "resources", "current", "bin"):
                parent = os.path.basename(os.path.dirname(install.rstrip("\\")))
                install_name = parent or install_name
            bits.append(f"安装于 {install_name}")
        if data_dirs:
            bits.append(f"{len(data_dirs)} 个数据目录")
        if not install and not data_dirs:
            bits.append("未定位到安装/数据目录")

        item = card(
            slug, display,
            online=online,
            lastActivityAt=activity,
            note=" · ".join(bits),
            detail="discovered",
        )
        item["discovered"] = True
        item["installDir"] = install
        item["dataDirs"] = data_dirs[:3]
        item["sources"] = sorted(entry["sources"])
        cards.append(item)

    cards.sort(key=lambda c: (0 if c["online"] else 1, -(c["lastActivityAt"] or 0), c["displayName"]))
    return cards[:DISCOVER_LIMIT]


def main() -> None:
    argv = sys.argv[1:]
    if len(argv) >= 3 and argv[0] == "--session":
        app, session_id = argv[1], argv[2]
        handler = DETAILS.get(app)
        if not handler:
            print(json.dumps({"app": app, "id": session_id, "title": "", "status": "",
                              "note": "该 Agent 暂无详情视图", "events": []}, ensure_ascii=False))
            return
        try:
            detail = handler(session_id)
        except Exception as exc:
            detail = {"app": app, "id": session_id, "title": "", "cwd": "", "status": "",
                      "note": f"detail failed: {exc}", "events": []}
        detail["errors"] = ERRORS
        print(json.dumps(detail, ensure_ascii=False))
        return

    agents = []
    for fn in (collect_codex, collect_grok, collect_marvis, collect_workbuddy):
        try:
            agents.append(fn())
        except Exception as exc:
            ERRORS.append({"app": fn.__name__.replace("collect_", ""), "message": repr(exc)})
    try:
        agents.extend(discover_agents())
    except Exception as exc:
        ERRORS.append({"app": "discovery", "message": repr(exc)})
    print(json.dumps({
        "generatedAt": NOW_MS,
        "host": os.environ.get("COMPUTERNAME", ""),
        "agents": agents,
        "errors": ERRORS,
    }, ensure_ascii=False))


if __name__ == "__main__":
    main()
