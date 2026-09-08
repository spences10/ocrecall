import { defineCommand } from 'citty';
import { readFileSync } from 'node:fs';

const { version } = JSON.parse(
	readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
) as { version: string };

export const main = defineCommand({
	meta: {
		name: 'ocrecall',
		version,
		description: 'Recall context from OpenAI Codex sessions',
	},
	run() {
		console.log(
			'ocrecall is scaffolded. Session sync and recall are not implemented yet. See PLAN.md for the implementation plan.',
		);
	},
});
