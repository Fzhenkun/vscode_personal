/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import * as fs from 'fs/promises';
import { tmpdir } from 'os';
import { join } from '../../../../base/common/path.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { findNewestCrashDump, waitForCrashDump } from '../../electron-main/crashReporter.js';

suite('Crash Reporter', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('finds the newest dump created after the crash started', () => {
		const dump = findNewestCrashDump('C:\\crashes', 1000, [
			{ name: 'old.dmp', isFile: true, mtimeMs: 900 },
			{ name: 'new.dmp', isFile: true, mtimeMs: 1200 },
			{ name: 'new.json', isFile: true, mtimeMs: 1300 },
		]);

		assert.strictEqual(dump, 'C:\\crashes\\new.dmp');
	});

	test('finds the newest crash dump from a directory', async () => {
		const directory = await fs.mkdtemp(join(tmpdir(), 'vscode-crash-reporter-'));
		try {
			const oldDump = join(directory, 'old.dmp');
			const newDump = join(directory, 'new.dmp');
			await Promise.all([fs.writeFile(oldDump, ''), fs.writeFile(newDump, '')]);
			await Promise.all([fs.utimes(oldDump, 1, 1), fs.utimes(newDump, 2, 2)]);

			assert.strictEqual(await waitForCrashDump(directory, 1500, 0), newDump);
		} finally {
			await fs.rm(directory, { recursive: true, force: true });
		}
	});
});
