// Synthetic records matching the observed paginated Codex format.
export const timestamp = '2026-09-01T10:00:00.000Z';
export function entry(
	type: string,
	payload: Record<string, unknown>,
	ordinal?: number,
) {
	return JSON.stringify({
		type,
		timestamp,
		...(ordinal === undefined ? {} : { ordinal }),
		payload,
	});
}
export function item(
	id: string,
	type: string,
	extra: Record<string, unknown> = {},
	turn_id = 'turn-1',
) {
	return entry('event_msg', {
		type: 'item_completed',
		thread_id: 'session-1',
		turn_id,
		item: { id, type, ...extra },
	});
}
export function fixture(
	id = 'session-1',
	mode: string | undefined = 'paginated',
) {
	return (
		[
			entry('session_meta', {
				id,
				session_id: id,
				history_mode: mode,
				cwd: '/project',
				model_provider: 'openai',
				cli_version: '0.153.4',
			}),
			entry('event_msg', { type: 'task_started', turn_id: 'turn-1' }),
			entry('turn_context', {
				turn_id: 'turn-1',
				model: 'test-model',
				cwd: '/project',
			}),
			entry('response_item', {
				type: 'message',
				role: 'user',
				content: [
					{ type: 'input_text', text: 'Find café migrations' },
				],
			}),
			item('user-1', 'UserMessage', {
				content: [{ type: 'text', text: 'Find café migrations' }],
			}),
			entry('response_item', {
				type: 'custom_tool_call',
				call_id: 'call-1',
				name: 'exec',
				input: 'await tools.exec_command({cmd: "ls"})',
			}),
			item('operation-1', 'CommandExecution', {
				command: ['ls'],
				stdout: 'output',
				status: 'completed',
				exit_code: 0,
			}),
			entry('response_item', {
				type: 'custom_tool_call_output',
				call_id: 'call-1',
				output: 'output',
			}),
			entry('response_item', {
				type: 'message',
				role: 'assistant',
				content: [
					{ type: 'output_text', text: 'Found the migrations.' },
				],
			}),
			item('assistant-1', 'AgentMessage', {
				phase: 'final',
				content: [{ type: 'text', text: 'Found the migrations.' }],
			}),
			entry('event_msg', {
				type: 'token_count',
				info: { total_token_usage: { input_tokens: 9999 } },
			}),
			entry('token_usage_record', {
				thread_id: id,
				session_id: id,
				turn_id: 'turn-1',
				response_id: 'response-1',
				usage: {
					input_tokens: 100,
					cached_input_tokens: 60,
					cache_write_input_tokens: 0,
					output_tokens: 20,
					reasoning_output_tokens: 5,
					total_tokens: 120,
				},
				thread_token_usage: { total_tokens: 120 },
			}),
			entry('event_msg', {
				type: 'task_complete',
				turn_id: 'turn-1',
			}),
		].join('\n') + '\n'
	);
}
