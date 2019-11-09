'use strict';

import glob from 'glob';
import chalk from 'chalk';
import * as fs from 'fs';
import * as cp from 'child_process';
import * as jsonc from 'jsonc-parser';
import { SpawnAsyncResult, spawnAsync, SpawnAsyncError } from './spawnAsync';
import { IStringDictionary } from './interfaces';
import { resolveVariables } from './cpptools';
import { CancelToken, CancelSubscription, CancelError } from "@esfx/async-canceltoken";

const ctx = new chalk.Instance({ level: 3 });

export function info(text: string) {
	return ctx.rgb(86, 156, 214)(text);
}

export function warn(text: string) {
	return ctx.rgb(205, 151, 49)(text); // 220, 220, 170
}

export function err(text: string): string {
	return ctx.rgb(224, 110, 100)(text); // 224, 135, 113
}

export function reg(text: string): string {
	return ctx.rgb(204, 204, 204)(text);
}

export function high(text: string): string {
	return ctx.rgb(181, 206, 169)(text); // 114, 157, 179
}

export function testColors() {
	console.log(chalk.rgb(224, 135, 113)('test 1'));
	console.log(chalk.rgb(205, 151, 49)('test 2'));
	console.log(chalk.rgb(220, 220, 170)('test 3'));
	console.log(chalk.rgb(206, 145, 120)('test 4'));
	console.log(chalk.rgb(156, 220, 254)('test 5'));
	console.log(chalk.rgb(78, 201, 176)('test 6'));
	console.log(chalk.rgb(197, 134, 192)('test 7'));
	console.log(chalk.rgb(204, 204, 204)('test 8'));
	console.log(chalk.rgb(224, 224, 224)('test 9'));
	console.log(chalk.rgb(86, 156, 214)('test 10'));
	console.log(chalk.rgb(114, 157, 179)('test 11'));
	console.log(chalk.rgb(181, 206, 169)('test 12'));
}

export function elapsedMills(timeSince: [number, number]) {
	const end = process.hrtime(timeSince);
	const elapsed = (end[0] * 1000) + (end[1] / 1000000);
	return elapsed;
}

export function sleep(millis: number, token = CancelToken.none): Promise<void> {
	return new Promise((resolve) => {
		let subscription: CancelSubscription | null = null;
		if (token.signaled) resolve();

		const timeout = setTimeout(() => {
			if (subscription) subscription.unsubscribe();
			resolve();
		}, millis);

		subscription = token.subscribe(() => {
			clearTimeout(timeout);
			resolve();
		});
	});
}

export async function getLatestVersion(name: string, token = CancelToken.none): Promise<string> {
	const result = await execCmd(`npm show ${name} version`, {}, token);
	return result.stdout.split(/[\r\n]/).filter(line => !!line)[0];
}

export function resolveVariablesTwice(input: string, params: { [key: string]: string | string[] }): string {
	let result: string = resolveVariables(input, params);
	result = resolveVariables(result, params);
	return result;
}

/**
 * Function creates object from json file.
 * @param jsonPath path to json file
 */
export function getJsonObject<T>(jsonPath: string): T | undefined {
	fs.exists(jsonPath, exists => {
		if (!exists) {
			console.error(`'${jsonPath}' file not found.`);
			return;
		}
	});

	const readResults: string = fs.readFileSync(jsonPath, 'utf8');

	if (readResults === "") {
		return;
	}

	const newJson: T = jsonc.parse(readResults);
	return newJson;
}

export function makeDirectory(dirPath: string, options: fs.MakeDirectoryOptions = { recursive: true }): Promise<void> {
	return new Promise((resolve, reject) => {
		fs.mkdir(dirPath, options, err => {
			if (err) {
				reject(err);
			} else {
				resolve();
			}
		});
	});
}

export function replaceAt(string: string, index: number, length: number, replacement: string): string {
	return string.substr(0, index) + replacement + string.substr(index + length);
}

export function globAsync(pattern: string, options: glob.IOptions): Promise<string[]> {
	return new Promise((resolve, reject) => {
		glob(pattern, options, (err, matches) => {
			if (err) {
				reject(err);
			} else {
				resolve(matches);
			}
		});
	});
}

export function getFileStatus(filePath: string): Promise<fs.Stats> {
	return new Promise((resolve, reject) => {
		fs.stat(filePath, (err, stats) => {
			if (err) {
				reject(err);
			} else {
				resolve(stats);
			}
		});
	});
}

export function getFileMTime(filePath: string): Promise<Date> {
	return new Promise((resolve, reject) => {
		fs.stat(filePath, (err, stats) => {
			if (err) {
				reject(err);
			} else {
				resolve(stats.mtime);
			}
		});
	});
}

export interface ExecCmdResult {
	stdout: string;
	stderr: string;
	error?: cp.ExecException;
}

export function execCmd(command: string, options: cp.ExecOptions, token = CancelToken.none): Promise<ExecCmdResult> {
	return new Promise<ExecCmdResult>((resolve, reject) => {
		let subscription: CancelSubscription | null = null;
		//token.throwIfSignaled(); // CancelError
		if (token.signaled) reject(); // already signaled

		const proc: cp.ChildProcess = cp.exec(command, options, (error, stdout, stderr) => {
			if (subscription) subscription.unsubscribe();
			if (error) {
				reject({ stdout, stderr, error });
			} else {
				resolve({ stdout, stderr });
			}
		});

		subscription = token.subscribe(() => {
			proc.kill();
			reject(); // TODO: throw CancelError ?
		});
	});
}

// gets object property by name
export function get(path: string, obj: any, fallback = `\{${path}}`): string {
	const parts: string[] = path.split('.');
	return parts.reduce((res, key) => res[key] || fallback, obj);
}

function isWinCmd(shell?: string): boolean {
	if (shell) {
		return shell.endsWith('cmd.exe');
	} else {
		return true;
	}
}

export async function spawnCommand(shell: string, commandLine: string, rootPath: string, actionName: string, logOutput: (line: string) => void, logError: (line: string) => void, showOutput?: () => void) {
	const cmdSwitch = isWinCmd(shell) ? '/s/c' : '-c';
	let result: SpawnAsyncResult;

	await spawnAsync(shell, [cmdSwitch, commandLine], rootPath, false, 10000).then(res => {
		logOutput(actionName);
		result = res;
	}).catch(e => {
		logError(actionName);
		logError(commandLine);
		logError(rootPath);
		const error: Error = e as Error;
		if (error) {
			logError('error msg: ' + error.message);
		}
		const spawnError: SpawnAsyncError = e as SpawnAsyncError;
		if (spawnError) {
			result = spawnError;
			logError('error code: ' + spawnError.code);
		}
	}).finally(() => {
		if (result) {
			result.stdout.forEach(line => logOutput(line));
			result.stderr.forEach(line => logError(line));
		}
		if (showOutput) showOutput();
	});
}

/** add elements of one dictionary to another dictionary */
export function addToDictionary(source: IStringDictionary<string | string[]>, destination: IStringDictionary<string | string[]>) {
	Object.keys(source).forEach(key => {
		let value = source[key];
		destination[key] = value;
	});
}

export function listObject(obj: any): string[] {
	const keys = Object.keys(obj);
	const values = keys.map(key => `${key}: ${Reflect.get(obj, key)}`);
	return values;
}
