import { createHash } from 'node:crypto';
import { Database } from './db.ts';
import {
	object,
	string,
	type Context,
	type RecordEntry,
} from './types.ts';

function text_blocks(value: unknown): string {
	if (typeof value === 'string') return value;
	if (!Array.isArray(value)) return '';
	return value
		.map((block) =>
			typeof block === 'string'
				? block
				: (string(object(block).text) ?? ''),
		)
		.filter(Boolean)
		.join('\n');
}
function json(value: unknown): string {
	return JSON.stringify(value ?? null, (key, v: unknown) =>
		key === 'encrypted_content' ||
		(typeof v === 'string' && v.startsWith('data:'))
			? '[omitted binary content]'
			: v,
	);
}
function number(value: unknown): number | null {
	return typeof value === 'number' &&
		Number.isFinite(value) &&
		value >= 0
		? value
		: null;
}
export function record_id(
	entry: RecordEntry,
	offset: number,
): string {
	// Ordinals are preferred; content digest prevents collision after a rewrite.
	const digest = createHash('sha256')
		.update(JSON.stringify(entry))
		.digest('hex');
	return `${entry.ordinal ?? offset}:${digest}`;
}

export function normalize(
	db: Database,
	session: string,
	entry: RecordEntry,
	order: number,
	context: Context,
): string | null {
	const p = entry.payload;
	const id = record_id(entry, order);
	const timestamp = entry.timestamp;
	const turn = string(p.turn_id) ?? context.turn_id;
	const event = (type: string, details: unknown = null) =>
		db.run(
			'INSERT OR IGNORE INTO session_events VALUES(?,?,?,?,?,?)',
			session,
			id,
			turn,
			type,
			timestamp,
			json(details),
		);
	const ensure_turn = (turn_id: string) =>
		db.run(
			`INSERT OR IGNORE INTO turns(session_id,id,source_order,model,provider,cwd,status,started_at) VALUES(?,?,?,?,?,?,?,?)`,
			session,
			turn_id,
			order,
			context.model,
			context.provider,
			context.cwd,
			'unknown',
			timestamp,
		);
	if (turn) ensure_turn(turn);
	if (entry.type === 'session_meta') return null;
	if (entry.type === 'turn_context') {
		const model = string(p.model);
		const provider = string(p.model_provider) ?? context.provider;
		if (model !== context.model || provider !== context.provider)
			db.run(
				'INSERT OR IGNORE INTO model_changes VALUES(?,?,?,?,?,?)',
				session,
				id,
				turn,
				model,
				provider,
				timestamp,
			);
		context.turn_id = turn;
		context.model = model;
		context.provider = provider;
		context.cwd = string(p.cwd) ?? context.cwd;
		if (turn)
			db.run(
				'UPDATE turns SET model=?,provider=?,cwd=? WHERE session_id=? AND id=?',
				model,
				provider,
				context.cwd,
				session,
				turn,
			);
		return null;
	}
	if (entry.type === 'token_usage_record') {
		const usage = object(p.usage);
		const response = string(p.response_id);
		const recording = string(p.session_id);
		const inherited =
			string(p.thread_id) && p.thread_id !== session ? 1 : 0;
		db.run(
			`INSERT OR IGNORE INTO usage_records VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
			session,
			response ?? id,
			recording,
			turn,
			response,
			context.model,
			context.provider,
			timestamp,
			number(usage.input_tokens),
			number(usage.cached_input_tokens),
			number(usage.cache_write_input_tokens),
			number(usage.output_tokens),
			number(usage.reasoning_output_tokens),
			number(usage.total_tokens),
			json(p.turn_token_usage),
			json(p.thread_token_usage),
			inherited,
		);
		return null;
	}
	const tool = (
		tool_id: string,
		name: string,
		input: unknown,
		kind: string,
		status: string | null,
		output?: unknown,
		error: number | null = null,
	) => {
		db.run(
			`INSERT INTO tool_calls VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(session_id,id) DO UPDATE SET status=excluded.status,tool_input=excluded.tool_input`,
			session,
			tool_id,
			turn,
			kind,
			name,
			typeof input === 'string' ? input : json(input),
			status,
			timestamp,
			order,
		);
		if (output !== undefined)
			db.run(
				`INSERT INTO tool_results(session_id,tool_call_id,content,is_error,timestamp) VALUES(?,?,?,?,?) ON CONFLICT(session_id,tool_call_id) DO UPDATE SET content=CASE WHEN tool_results.compacted=1 THEN tool_results.content ELSE excluded.content END,is_error=excluded.is_error`,
				session,
				tool_id,
				typeof output === 'string' ? output : json(output),
				error,
				timestamp,
			);
	};
	if (entry.type === 'response_item') {
		const type = string(p.type);
		if (type === 'function_call' || type === 'custom_tool_call') {
			const call = string(p.call_id);
			if (!call || !string(p.name)) return 'invalid:tool_call';
			tool(
				'call:' + call,
				p.name as string,
				p.arguments ?? p.input,
				'invocation',
				string(p.status),
			);
		} else if (
			type === 'function_call_output' ||
			type === 'custom_tool_call_output'
		) {
			if (!string(p.call_id)) return 'invalid:tool_output';
			db.run(
				`INSERT INTO tool_results(session_id,tool_call_id,content,timestamp) VALUES(?,?,?,?) ON CONFLICT(session_id,tool_call_id) DO UPDATE SET content=CASE WHEN tool_results.compacted=1 THEN tool_results.content ELSE excluded.content END`,
				session,
				'call:' + p.call_id,
				typeof p.output === 'string' ? p.output : json(p.output),
				timestamp,
			);
		} else if (!['message', 'reasoning'].includes(type ?? ''))
			return 'response_item:' + type;
		return null;
	}
	if (entry.type === 'compacted') {
		event('compacted', { message: p.message });
		return null;
	}
	if (entry.type === 'world_state') return null;
	if (entry.type === 'realtime_item') {
		if (p.type === 'transcript_segment')
			db.run(
				'INSERT OR IGNORE INTO messages VALUES(?,?,?,?,?,?,?,?)',
				session,
				string(p.id) ?? id,
				turn,
				'transcript',
				string(p.role),
				string(p.text),
				timestamp,
				order,
			);
		else event('realtime:' + p.type);
		return null;
	}
	if (entry.type !== 'event_msg') {
		event(entry.type);
		return entry.type;
	}
	const type = string(p.type) ?? 'unknown';
	if (type === 'task_started') {
		context.turn_id = turn;
		if (turn)
			db.run(
				"UPDATE turns SET status='active',started_at=? WHERE session_id=? AND id=?",
				timestamp,
				session,
				turn,
			);
		return null;
	}
	if (type === 'task_complete' || type === 'turn_aborted') {
		if (turn)
			db.run(
				'UPDATE turns SET status=?,completed_at=? WHERE session_id=? AND id=?',
				type === 'task_complete' ? 'completed' : 'aborted',
				timestamp,
				session,
				turn,
			);
		context.turn_id = null;
		return null;
	}
	if (type === 'thread_rolled_back') {
		const count = number(p.num_turns);
		if (count !== null && Number.isInteger(count))
			db.run(
				'UPDATE turns SET rolled_back=1 WHERE session_id=? AND id IN (SELECT id FROM turns WHERE session_id=? AND rolled_back=0 ORDER BY source_order DESC LIMIT ?)',
				session,
				session,
				count,
			);
		event(type, { num_turns: count });
		return null;
	}
	if (['token_count', 'user_message', 'agent_message'].includes(type))
		return null;
	if (type === 'thread_settings_applied') {
		event(type);
		return null;
	}
	if (type !== 'item_completed') {
		event(type);
		return 'event_msg:' + type;
	}
	const item = object(p.item);
	const item_id = string(item.id);
	const item_type = string(item.type);
	if (!item_id || !item_type) return 'invalid:item_completed';
	if (
		['UserMessage', 'AgentMessage', 'Reasoning'].includes(item_type)
	) {
		const content =
			item_type === 'Reasoning'
				? text_blocks(item.summary_text)
				: text_blocks(item.content);
		db.run(
			`INSERT INTO messages VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(session_id,id) DO UPDATE SET content_text=excluded.content_text,phase=excluded.phase`,
			session,
			item_id,
			turn,
			item_type === 'UserMessage'
				? 'user'
				: item_type === 'AgentMessage'
					? 'assistant'
					: 'reasoning',
			string(item.phase),
			content,
			timestamp,
			order,
		);
		return null;
	}
	if (item_type === 'ContextCompaction') {
		event('compacted');
		return null;
	}
	const known: Record<string, string> = {
		CommandExecution: 'command',
		FileChange: 'file_change',
		Extension: 'extension',
		ImageView: 'image_view',
		McpToolCall: 'mcp',
		DynamicToolCall: 'dynamic_tool',
		CollabToolCall: 'collaboration',
		WebSearch: 'web_search',
	};
	if (!known[item_type]) {
		event('item:' + item_type);
		return 'item:' + item_type;
	}
	const {
		stdout,
		stderr,
		aggregated_output,
		formatted_output,
		output,
		result,
		content,
		...input
	} = item;
	const status = string(item.status);
	const failed =
		['failed', 'error', 'declined'].includes(status ?? '') ||
		(typeof item.exit_code === 'number' && item.exit_code !== 0);
	tool(
		'item:' + item_id,
		string(item.tool) ?? string(item.kind) ?? known[item_type],
		input,
		'operation',
		status,
		aggregated_output ??
			formatted_output ??
			output ??
			result ??
			content ??
			(stdout !== undefined || stderr !== undefined
				? { stdout, stderr }
				: undefined),
		failed ? 1 : status === 'completed' ? 0 : null,
	);
	const child =
		string(item.new_thread_id) ?? string(item.newThreadId);
	if (child)
		db.run(
			'INSERT OR IGNORE INTO session_links VALUES(?,?,?)',
			session,
			child,
			'spawn',
		);
	return null;
}
