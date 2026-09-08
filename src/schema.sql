CREATE TABLE sessions (
 id TEXT PRIMARY KEY, recording_session_id TEXT, cwd TEXT, project_path TEXT,
 name TEXT, name_updated_at INTEGER, originator TEXT, source TEXT, cli_version TEXT,
 history_mode TEXT NOT NULL CHECK(history_mode = 'paginated'), git_branch TEXT,
 first_timestamp INTEGER NOT NULL, last_timestamp INTEGER NOT NULL
);
CREATE TABLE session_sources (
 path TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES sessions(id),
 root TEXT NOT NULL, codex_home TEXT NOT NULL, state TEXT NOT NULL,
 size_bytes INTEGER NOT NULL, mtime_ms REAL NOT NULL, last_seen_at INTEGER NOT NULL
);
CREATE TABLE sync_state (
 file_path TEXT PRIMARY KEY, session_id TEXT NOT NULL, byte_offset INTEGER NOT NULL,
 device TEXT NOT NULL, inode TEXT NOT NULL, mtime_ms REAL NOT NULL,
 prefix_hash TEXT NOT NULL, prefix_size INTEGER NOT NULL,
 context_json TEXT NOT NULL, parser_version INTEGER NOT NULL
);
CREATE TABLE records (
 session_id TEXT NOT NULL REFERENCES sessions(id), id TEXT NOT NULL,
 type TEXT NOT NULL, timestamp INTEGER NOT NULL, source_order INTEGER NOT NULL,
 PRIMARY KEY(session_id, id)
);
CREATE TABLE turns (
 session_id TEXT NOT NULL REFERENCES sessions(id), id TEXT NOT NULL,
 source_order INTEGER NOT NULL, model TEXT, provider TEXT, cwd TEXT,
 status TEXT, started_at INTEGER, completed_at INTEGER, rolled_back INTEGER NOT NULL DEFAULT 0,
 PRIMARY KEY(session_id, id)
);
CREATE TABLE messages (
 session_id TEXT NOT NULL REFERENCES sessions(id), id TEXT NOT NULL, turn_id TEXT,
 type TEXT NOT NULL, phase TEXT, content_text TEXT, timestamp INTEGER NOT NULL,
 source_order INTEGER NOT NULL, UNIQUE(session_id, id)
);
CREATE TABLE tool_calls (
 session_id TEXT NOT NULL REFERENCES sessions(id), id TEXT NOT NULL, turn_id TEXT,
 kind TEXT NOT NULL, tool_name TEXT NOT NULL, tool_input TEXT,
 status TEXT, timestamp INTEGER NOT NULL, source_order INTEGER NOT NULL,
 PRIMARY KEY(session_id, id)
);
CREATE TABLE tool_results (
 session_id TEXT NOT NULL REFERENCES sessions(id), tool_call_id TEXT NOT NULL,
 content TEXT, is_error INTEGER, compacted INTEGER NOT NULL DEFAULT 0,
 timestamp INTEGER NOT NULL, PRIMARY KEY(session_id, tool_call_id)
);
CREATE TABLE usage_records (
 session_id TEXT NOT NULL REFERENCES sessions(id), id TEXT NOT NULL,
 recording_session_id TEXT, turn_id TEXT, response_id TEXT, model TEXT, provider TEXT,
 timestamp INTEGER NOT NULL, input_tokens INTEGER, cached_input_tokens INTEGER,
 cache_write_input_tokens INTEGER, output_tokens INTEGER, reasoning_output_tokens INTEGER,
 total_tokens INTEGER, turn_totals TEXT, thread_totals TEXT,
 inherited INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(session_id, id)
);
CREATE TABLE model_changes (
 session_id TEXT NOT NULL REFERENCES sessions(id), id TEXT NOT NULL,
 turn_id TEXT, model TEXT, provider TEXT, timestamp INTEGER NOT NULL,
 PRIMARY KEY(session_id, id)
);
CREATE TABLE session_links (
 parent_id TEXT NOT NULL, child_id TEXT NOT NULL, kind TEXT NOT NULL,
 PRIMARY KEY(parent_id, child_id, kind)
);
CREATE TABLE session_events (
 session_id TEXT NOT NULL REFERENCES sessions(id), id TEXT NOT NULL, turn_id TEXT,
 type TEXT NOT NULL, timestamp INTEGER NOT NULL, details TEXT,
 PRIMARY KEY(session_id, id)
);
CREATE INDEX messages_session_order ON messages(session_id, source_order);
CREATE INDEX turns_session_order ON turns(session_id, source_order);
CREATE INDEX usage_response ON usage_records(response_id);
CREATE INDEX sources_session ON session_sources(session_id, state);
CREATE VIRTUAL TABLE messages_fts USING fts5(content_text, content='messages', content_rowid='rowid');
CREATE TRIGGER messages_insert AFTER INSERT ON messages BEGIN
 INSERT INTO messages_fts(rowid, content_text) VALUES(new.rowid, new.content_text);
END;
CREATE TRIGGER messages_delete AFTER DELETE ON messages BEGIN
 INSERT INTO messages_fts(messages_fts, rowid, content_text) VALUES('delete', old.rowid, old.content_text);
END;
CREATE TRIGGER messages_update AFTER UPDATE ON messages BEGIN
 INSERT INTO messages_fts(messages_fts, rowid, content_text) VALUES('delete', old.rowid, old.content_text);
 INSERT INTO messages_fts(rowid, content_text) VALUES(new.rowid, new.content_text);
END;
