/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2019 Tomasz Jastrzębski. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

'use strict';

// child_process.spawnSync(command[, args][, options])
// https://nodejs.org/api/child_process.html#child_process_child_process_spawnsync_command_args_options

//Node.js Child Processes: Everything you need to know
// https://www.freecodecamp.org/news/node-js-child-processes-everything-you-need-to-know-e69498fe970a/

import * as cp from 'child_process';
import { LineDecoder } from './decoders';

export interface SpawnAsyncResult {
	stdout: string[];
	stderr: string[];
}

export interface SpawnAsyncError extends SpawnAsyncResult {
	message: string;
	code: number;
	stack?: string;
}

export function spawnAsync(process: string, args?: readonly string[], cwd?: string, shell?: boolean | string, timeout?: number): Promise<SpawnAsyncResult> {
	// inspired by VsCode AbstractProcess<TProgressData>.start() for VSCode task runner implementation [src/vs/base/node/processes.ts]
	// TODO: add proc KILL feature using CancellationToken (?)
	return new Promise<SpawnAsyncResult>((resolve, reject) => {
		const stdoutDecoder: LineDecoder = new LineDecoder();
		const stderrDecoder: LineDecoder = new LineDecoder();
		const stdoutLines: string[] = [];
		const stderrLines: string[] = [];
		const options: cp.SpawnOptionsWithoutStdio = { cwd: cwd, timeout: timeout, shell: shell };
		let child: cp.ChildProcess | undefined;
		let timer: NodeJS.Timer;
		let error: Error;

		try {
			child = cp.spawn(process, args, options);
			if (!child || child.pid === undefined) throw new Error('Failed to launch script process.');
		} catch (error) {
			// this will be captured in child.on('error') event
		}

		if (timeout) {
			// timeout the process if no response is received to ensure this Promise resolves/rejects
			timer = setTimeout(() => {
				error = new Error(`${process} failed to finish within ${timeout / 1000}s.`);
			}, timeout);
		}

		if (child!.stdout) child!.stdout.on('data', (data) => {
			const lines: string[] = stdoutDecoder.write(data);
			lines.forEach(line => stdoutLines.push(line));
		});

		if (child!.stderr) child!.stderr.on('data', (data) => {
			const lines: string[] = stderrDecoder.write(data);
			lines.forEach(line => stderrLines.push(line));
		});

		/* not needed
		child.on('exit', (code: number, signal: string) => {
			clearInterval(timer);
			exitCode = code;
		});
		*/

		child!.on('error', (e: Error) => {
			clearInterval(timer);
			error = e;
		});

		child!.on('close', (code: number, signal: string) => {
			clearInterval(timer);
			let line: string | null = stdoutDecoder.end();
			if (line) stdoutLines.push(line);
			line = stderrDecoder.end();
			if (line) stderrLines.push(line);

			if (code !== 0) {
				error = error || new Error(`${process} exited with error code ${code}.`);
				reject({ message: error.message, code: code, stdout: stdoutLines, stderr: stderrLines, stack: error.stack });
			} else {
				resolve({ stdout: stdoutLines, stderr: stderrLines });
			}
		});
	});
}
