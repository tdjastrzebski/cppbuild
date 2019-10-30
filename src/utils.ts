'use strict';

import glob from 'glob';
import * as fs from 'fs';
import * as cp from 'child_process';
import * as jsonc from 'jsonc-parser';
import { SpawnAsyncResult, spawnAsync, SpawnAsyncError } from './spawnAsync';
import { IStringDictionary } from './interfaces';
import { resolveVariables } from './cpptools';

export async function getLatestVersion(name: string): Promise<string> {
	const result = await execCmd(`npm show ${name} version`, {});
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

export function makeDirectory(dirPath: string, options: fs.MakeDirectoryOptions): Promise<void> {
	return new Promise((resolve, reject) => {
		fs.mkdir(dirPath, options, err => {
			if (err) {
				reject(err);
			}
			else {
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

export function execCmd(command: string, options: cp.ExecOptions): Promise<ExecCmdResult> {
	return new Promise<ExecCmdResult>((resolve, reject) => {
		const proc: cp.ChildProcess = cp.exec(command, options, (error, stdout, stderr) => {
			if (error) {
				reject({ stdout, stderr, error });
			} else {
				resolve({ stdout, stderr });
			}
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
