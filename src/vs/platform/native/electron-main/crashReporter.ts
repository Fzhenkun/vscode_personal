/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as fs from 'fs';
import { join } from '../../../base/common/path.js';

export interface ICrashDumpEntry {
	readonly name: string;
	readonly isFile: boolean;
	readonly mtimeMs: number;
}

export function findNewestCrashDump(directory: string, after: number, entries: readonly ICrashDumpEntry[]): string | undefined {
	let newest: ICrashDumpEntry | undefined;

	for (const entry of entries) {
		if (!entry.isFile || !entry.name.endsWith('.dmp') || entry.mtimeMs < after || entry.mtimeMs <= (newest?.mtimeMs ?? -Infinity)) {
			continue;
		}

		newest = entry;
	}

	return newest ? join(directory, newest.name) : undefined;
}

export async function waitForCrashDump(directory: string, after: number, timeoutMs = 10_000, intervalMs = 250): Promise<string | undefined> {
	const deadline = Date.now() + timeoutMs;

	while (Date.now() <= deadline) {
		const dump = findNewestCrashDump(directory, after, await readCrashDumpEntries(directory));
		if (dump) {
			return dump;
		}

		await new Promise<void>(resolve => setTimeout(resolve, intervalMs));
	}

	return undefined;
}

async function readCrashDumpEntries(directory: string): Promise<ICrashDumpEntry[]> {
	try {
		const directoryEntries = await fs.promises.readdir(directory, { withFileTypes: true });
		const entries = await Promise.all(directoryEntries.map(async entry => {
			if (!entry.isFile()) {
				return undefined;
			}

			try {
				return { name: entry.name, isFile: true, mtimeMs: (await fs.promises.stat(join(directory, entry.name))).mtimeMs };
			} catch {
				return undefined;
			}
		}));
		return entries.filter((entry): entry is ICrashDumpEntry => entry !== undefined);
	} catch {
		return [];
	}
}
