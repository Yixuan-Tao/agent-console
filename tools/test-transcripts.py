"""Regression checks through the collector's session entry point, using fixtures."""
import contextlib
import importlib.util
import io
import json
from pathlib import Path
import sqlite3
import sys
import tempfile
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.dont_write_bytecode = True
spec = importlib.util.spec_from_file_location("collector", ROOT / "collector.py")
collector = importlib.util.module_from_spec(spec)
spec.loader.exec_module(collector)

MARKDOWN = "## 结果\n\n| 名称 | 数值 |\n| --- | ---: |\n| 中文 | 42 |\n\n```python\nif True:\n    print('好')\n```"
OUTPUT = "first line\n    indented output\n\tfinal line\n"
DIFF = "@@ -1,2 +1,2 @@\n-old\n+new\n unchanged\n"


@contextlib.contextmanager
def database(path, schema):
    path.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(path)
    try:
        conn.executescript(schema)
        with conn:
            yield conn
    finally:
        conn.close()


def session(app, sid="fixture"):
    collector.ERRORS.clear()
    with patch.object(sys, "argv", ["collector.py", "--session", app, sid]):
        with contextlib.redirect_stdout(io.StringIO()) as output:
            collector.main()
    result = json.loads(output.getvalue())
    assert not result.get("errors"), result.get("errors")
    return result["events"]


with tempfile.TemporaryDirectory(prefix="transcript-test-", dir=ROOT) as directory:
    home = Path(directory)
    collector.HOME = str(home)
    codex = home / ".codex"
    with database(codex / "sqlite" / "codex.db", """
        CREATE TABLE local_thread_catalog (
            thread_id TEXT, display_title TEXT, cwd TEXT, source_kind TEXT, host_id TEXT
        );
    """):
        pass
    rollout = codex / "sessions" / "fixture.jsonl"
    rollout.parent.mkdir(parents=True)
    rollout.write_text(json.dumps({
        "type": "response_item",
        "payload": {"type": "message", "role": "assistant", "content": [{"text": MARKDOWN}]},
    }, ensure_ascii=False) + "\n", encoding="utf-8")
    with database(codex / "state_5.sqlite", """
        CREATE TABLE threads (
            id TEXT, rollout_path TEXT, cwd TEXT, title TEXT, first_user_message TEXT, preview TEXT
        );
    """) as conn:
        conn.execute("INSERT INTO threads VALUES (?, ?, '', 'Fixture', '', '')", ("fixture", str(rollout)))
    history = codex / "thread_history_1.sqlite"
    with database(history, """
        CREATE TABLE thread_items (
            thread_id TEXT, item_type TEXT, item_json TEXT, created_at_ms INTEGER,
            turn_id TEXT, rollout_ordinal INTEGER
        );
        CREATE TABLE thread_turns (thread_id TEXT, turn_id TEXT, duration_ms INTEGER);
    """):
        pass
    assert session("codex")[0]["text"] == MARKDOWN, "Rollout lost formatting"

    projected = [
        ("userMessage", {"content": [{"text": MARKDOWN}]}),
        ("agentMessage", {"text": MARKDOWN}),
        ("commandExecution", {"command": "python - <<'PY'\n    print(1)\nPY", "aggregatedOutput": OUTPUT}),
        ("mcpToolCall", {"server": "fixture", "tool": "read", "arguments": {"text": MARKDOWN},
                         "result": {"content": [{"text": OUTPUT}]}}),
        ("fileChange", {"changes": [{"path": "fixture.txt", "kind": "update", "diff": DIFF}]}),
    ]
    with database(history, "") as conn:
        for ordinal, (kind, payload) in enumerate(projected):
            conn.execute("INSERT INTO thread_items VALUES (?, ?, ?, ?, ?, ?)",
                         ("fixture", kind, json.dumps(payload), 1000, "turn", ordinal))
    events = session("codex")
    assert events[0]["text"] == MARKDOWN and events[1]["text"] == MARKDOWN
    assert events[2]["output"] == OUTPUT and "\n    print" in events[2]["command"]
    assert events[3]["result"] == OUTPUT and events[3]["arguments"]["text"] == MARKDOWN
    assert events[4]["changes"][0]["diff"] == DIFF

    with database(home / ".marvis" / "database" / "data.db", """
        CREATE TABLE conversations (conversation_id TEXT, title TEXT, status TEXT);
        CREATE TABLE messages (conversation_id TEXT, role TEXT, content TEXT,
                               tool_name TEXT, created_at INTEGER, message_seq INTEGER);
    """) as conn:
        conn.execute("INSERT INTO conversations VALUES ('fixture', 'Fixture', 'completed')")
        conn.execute("INSERT INTO messages VALUES ('fixture', 'assistant', ?, '', 1000, 0)", (MARKDOWN,))
        conn.execute("INSERT INTO messages VALUES ('fixture', 'tool', ?, 'shell', 2000, 1)", (OUTPUT,))
    events = session("marvis")
    assert events[0]["text"] == MARKDOWN and events[1]["output"] == OUTPUT

    workbuddy = home / ".workbuddy"
    with database(workbuddy / "workbuddy.db", """
        CREATE TABLE sessions (id TEXT, title TEXT, status TEXT, model TEXT, cwd TEXT,
                               created_at INTEGER, updated_at INTEGER, last_activity_at INTEGER);
    """) as conn:
        conn.execute("INSERT INTO sessions VALUES ('fixture', 'Fixture', 'completed', 'model', '', 0, 0, 0)")
    transcript = workbuddy / "projects" / "workspace" / "fixture.jsonl"
    transcript.parent.mkdir(parents=True)
    transcript.write_text(json.dumps({"type": "message", "role": "assistant", "content": MARKDOWN}), encoding="utf-8")
    assert session("workbuddy")[0]["text"] == MARKDOWN

    with patch.object(collector, "grok_roster", return_value={"rows": [
        {"id": "fixture", "name": "Fixture", "lastEntry": {"text": MARKDOWN}}
    ]}):
        assert session("grokbot")[0]["text"] == MARKDOWN

    assert collector.event("assistant", "message", "x" * 2000)["text"] == "x" * 2000
    assert len(collector.event("assistant", "message", "x" * 13000)["text"]) == 12000
    assert collector.clip("title\n  summary") == "title summary"

print("TRANSCRIPT TEST OK (projection, rollout, Marvis, WorkBuddy, Grok)")
