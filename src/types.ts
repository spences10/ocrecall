export type JsonObject = Record<string, unknown>;

export function object(value: unknown): JsonObject {
	return value !== null &&
		typeof value === 'object' &&
		!Array.isArray(value)
		? (value as JsonObject)
		: {};
}

export function string(value: unknown): string | null {
	return typeof value === 'string' ? value : null;
}

export interface RecordEntry {
	type: string;
	timestamp: number;
	ordinal: number | null;
	payload: JsonObject;
}

export interface Context {
	turn_id: string | null;
	model: string | null;
	provider: string | null;
	cwd: string | null;
}

export interface SyncResult {
	warnings: string[];
	files_scanned: number;
	files_processed: number;
	legacy_skipped: number;
	unsupported_files: number;
	malformed_records: number;
	unsupported_records: Record<string, number>;
	records_added: number;
	messages_added: number;
	usage_records_added: number;
	errors: Array<{ path: string; message: string }>;
}
