import { createReadStream } from 'node:fs';
import { object, string, type RecordEntry } from './types.ts';

/** Yield complete records only. Offsets are bytes, including the newline. */
export async function* read_lines(
	path: string,
	start = 0,
	end?: number,
) {
	if (end !== undefined && end <= start) return;
	const stream = createReadStream(path, {
		start,
		...(end === undefined ? {} : { end: end - 1 }),
	});
	let pending = Buffer.alloc(0);
	let offset = start;
	try {
		for await (const chunk of stream) {
			pending = Buffer.concat([pending, chunk as Buffer]);
			let newline: number;
			while ((newline = pending.indexOf(10)) !== -1) {
				const next = offset + newline + 1;
				yield {
					line: pending.subarray(0, newline).toString('utf8'),
					start: offset,
					end: next,
				};
				pending = pending.subarray(newline + 1);
				offset = next;
			}
		}
	} finally {
		stream.destroy();
	}
}

export function parse_entry(line: string): RecordEntry | null {
	try {
		const value = object(JSON.parse(line));
		const timestamp = Date.parse(string(value.timestamp) ?? '');
		if (
			!string(value.type) ||
			!Number.isFinite(timestamp) ||
			!value.payload ||
			Array.isArray(value.payload) ||
			typeof value.payload !== 'object'
		)
			return null;
		return {
			type: value.type as string,
			timestamp,
			ordinal: Number.isSafeInteger(value.ordinal)
				? (value.ordinal as number)
				: null,
			payload: object(value.payload),
		};
	} catch {
		return null;
	}
}

export async function read_header(path: string, end: number) {
	for await (const record of read_lines(path, 0, end))
		return parse_entry(record.line);
	return null;
}
