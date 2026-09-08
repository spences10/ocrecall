#!/usr/bin/env node
// Set this before loading citty so piped output stays readable.
if (!process.stdout.isTTY) {
	process.env.NO_COLOR = '1';
}

const { runMain } = await import('citty');
const { main } = await import('./cli.ts');

void runMain(main);
