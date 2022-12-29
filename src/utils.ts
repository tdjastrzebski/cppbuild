'use strict';

import glob from 'glob';
import { sync as globSync } from 'glob';
import chalk from 'chalk';
import ColorSupport from 'chalk';
import * as fs from 'fs';
import * as path from 'path';
import * as readline from 'readline';
import * as cp from 'child_process';
import * as jsonc from 'jsonc-parser';
import { SpawnAsyncResult, spawnAsync, SpawnAsyncError } from './spawnAsync';
import { ParamsDictionary, ExpandPathsOption } from './interfaces';
import { CancelToken, CancelSubscription } from "@esfx/async-canceltoken";
import { isArrayOfString } from './cpptools';
import * as xRegExp from 'xregexp';
const ctx = new chalk.Instance({ level: 3 });

function color(text: string, red: number, green: number, blue: number, color: (...text: unknown[]) => string): string {
	if (ColorSupport.level > 1) {
		return ctx.rgb(red, green, blue)(text);
	} else {
		return color(text);
	}
}

/** info */
export function iColor(text: string) {
	return ctx.rgb(86, 156, 214)(text);
}

/** warning */
export function wColor(text: string) {
	return ctx.rgb(205, 151, 49)(text);
}

/** summary */
export function sColor(text: string) {
	return ctx.rgb(205, 151, 49)(text); // same as warning
}

/** error */
export function eColor(text: string): string {
	return ctx.rgb(224, 110, 100)(text);
}

/** regular */
export function rColor(text: string): string {
	return ctx.rgb(204, 204, 204)(text);
}

/** highlight */
export function hColor(text: string): string {
	return ctx.rgb(181, 206, 169)(text);
}

/** debug */
export function dColor(text: string): string {
	return ctx.rgb(197, 134, 192)(text);
}

/** OK */
export function kColor(text: string): string {
	return ctx.rgb(78, 220, 146)(text);
}

export async function readLines(filePath: string, onLine: (line: string) => void): Promise<void> {
	const readInterface = readline.createInterface(fs.createReadStream(filePath));

	return new Promise<void>((resolve, reject) => {
		readInterface.on('close', () => {
			resolve();
		});
		readInterface.on('line', line => {
			onLine(line);
		});
	});
}

export function elapsedMills(timeSince: [number, number]) {
	const end = process.hrtime(timeSince);
	const elapsed = (end[0] * 1000) + (end[1] / 1000000);
	return elapsed;
}

export function sleep(mills: number, token = CancelToken.none): Promise<void> {
	return new Promise((resolve) => {
		let subscription: CancelSubscription | null = null;
		if (token.signaled) resolve();

		const timeout = setTimeout(() => {
			if (subscription) subscription.unsubscribe();
			resolve();
		}, mills);

		subscription = token.subscribe(() => {
			clearTimeout(timeout);
			resolve();
		});
	});
}

export async function getLatestVersion(name: string, token = CancelToken.none): Promise<string> {
	const result = await execCmd(`npm show ${name} version`, {}, token);
	var lines = result.stdout.split(/[\r\n]/).filter(line => !!line);
	
	if (lines[0].startsWith("npm WARN")) {
		return lines[1];
	} else {
		return lines[0];
	}
}

/*
export function resolveVariables(input: string, params: VariableResolver): string {
	const results = expandTemplates('', input, params, false, ExpandPathsOption.noExpand);

	if (isArrayOfString(results)) {
		throw new Error(`Template '${input}' resolves to multiple values.`);
	} else {
		return results;
	}
}
*/

/**
 * Function creates object from json file.
 * @param jsonPath path to json file
 */
export function getJsonObject<T>(jsonPath: string): T | undefined {
	if (!fs.existsSync(jsonPath)) {
		console.error(`'${jsonPath}' file not found.`);
		return;
	};

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

/* this does not work in Node.js 10, version 12+ required
export function removeDirectory(dirPath: string, options: fs.RmDirAsyncOptions = { recursive: true }): Promise<void> {
	return new Promise((resolve, reject) => {
		fs.rmdir(dirPath, options, (err) => {
			if (err) {
				reject(err);
			} else {
				resolve();
			}
		});
	});
}
*/

interface XRegExpPart { start: number; end: number; name: string; value: string; }
export interface XRegExpMatch { index: number; outerText: string; innerText: string; left: string; right: string; }

export function replaceRecursive(text: string, left: string, right: string, replacer: (match: XRegExpMatch) => string, flags: string = 'g', escapeChar?: string): string {
	const matches: XRegExpMatch[] = matchRecursive(text, left, right, flags, escapeChar);
	let offset: number = 0;

	for (const match of matches) {
		const replacement = replacer(match);
		if (replacement == match.outerText) continue;
		text = replaceAt(text, match.index + offset, match.outerText.length, replacement);
		offset += replacement.length - match.outerText.length;
	}
	return text;
}

export function matchRecursive(text: string, left: string, right: string, flags: string = 'g', escapeChar?: string): XRegExpMatch[] {
	// see: https://github.com/slevithan/xregexp#xregexpmatchrecursive
	// see: http://xregexp.com/api/#matchRecursive
	let parts: XRegExpPart[];

	try {
		parts = xRegExp.matchRecursive(text, left, right, flags, { valueNames: [null, 'left', 'match', 'right'], escapeChar: escapeChar });
	} catch (e) {
		throw new Error(`${getErrorMessage(e)}: '${text}'.`);
	}

	const matches: XRegExpMatch[] = [];
	let leftPart: XRegExpPart;
	let matchPart: XRegExpPart;

	for (const part of parts!) {
		// note: assumption is made that left, match and right parts occur in this sequence
		switch (part.name) {
			case 'left':
				leftPart = part;
				break;
			case 'match':
				matchPart = part;
				break;
			case 'right':
				matches.push({ index: leftPart!.start, innerText: matchPart!.value, outerText: leftPart!.value + matchPart!.value + part.value, left: leftPart!.value, right: part.value });
				break;
			default:
				throw new Error(`Unexpected part name: '${part.name}'.`);
		}
	}

	return matches;
}

export function replaceAt(string: string, index: number, length: number, replacement: string): string {
	return string.substr(0, index) + replacement + string.substring(index + length);
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
		let proc: cp.ChildProcess;
		//token.throwIfSignaled(); // CancelError
		if (token.signaled) reject(); // already signaled

		try {
			proc = cp.exec(command, options, (error, stdout, stderr) => {
				if (subscription) subscription.unsubscribe();
				if (error) {
					reject({ stdout, stderr, error });
				} else {
					resolve({ stdout, stderr });
				}
			});
		} catch (e) {
			reject({ stdout: undefined, stderr: undefined, error: e });
		}

		subscription = token.subscribe(() => {
			proc?.kill();
			reject(); // TODO: throw CancelError ?
		});
	});
}

// gets object property by name
export function get(path: string, obj: any, fallback = `\{${path}}`): string {
	const parts: string[] = path.split('.');
	return parts.reduce((res, key) => res[key] ?? fallback, obj);
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

export function listObject(obj: any): string[] {
	const keys = Object.keys(obj);
	const values = keys.map(key => `${key}: ${Reflect.get(obj, key)}`);
	return values;
}

export function lookUpVariable(name: string, extraParams: ParamsDictionary): string[] | string {
	let newValue: string[] | string | undefined = undefined;

	if (name.startsWith('~')) {
		const home = (process.platform === 'win32') ? process.env.USERPROFILE : process.env.HOME;
		newValue = path.join(home || '', name.substring(1));
		newValue = escapeTemplateText(newValue);
	} else if (name.startsWith('env:')) {
		name = name.substring('env:'.length);
		newValue = process.env[name];
		if (newValue) newValue = escapeTemplateText(newValue);
	} else {
		newValue = extraParams[name];
	}

	if (newValue === undefined) {
		throw new Error(`Unable to resolve variable '${name}'.`);
	}

	return newValue;
}

export function escapeTemplateText(text: string[]): string[];
export function escapeTemplateText(text: string): string;
export function escapeTemplateText(text: string | string[]): any {
	if (isArrayOfString(text)) {
		const tmpArray: string[] = [];
		text.forEach(val => {
			tmpArray.push(escapeTemplateText(val));
		});
		return tmpArray;
	}
	text = text.replace(/[\[\]\(\)\$\{\}\,\\]/g, match => {
		return '\\' + match;
	});
	return text;
}

export function unescapeTemplateText(text: string): string;
export function unescapeTemplateText(text: string[]): string[];
export function unescapeTemplateText(text: string | string[]): any {
	if (isArrayOfString(text)) {
		const tmpArray: string[] = [];
		text.forEach(val => {
			tmpArray.push(unescapeTemplateText(val));
		});
		return tmpArray;
	}
	text = text.replace(/(?:\\(.))/g, '$1'); // TODO: it works, test if it is faster, unescapes all characters
	/*
	text = text.replace(/\\[\[\]\(\)\$\{\}\,\\]/g, match => {
		return match.substr(1, 1); // return the second char only, without trailing '\'
	});
	*/
	return text;
}

/** returns escaped file/directory paths */
export function expandGlob(workspaceRoot: string, pattern: string, expandOption: ExpandPathsOption): string[] {
	if (expandOption === ExpandPathsOption.noExpand) {
		return [pattern];
	} else {
		if (expandOption === ExpandPathsOption.directoriesOnly) {
			// make sure pattern ends with '/' - this causes only directories to be matched
			if (!pattern.endsWith('/') && !pattern.endsWith('\\')) pattern += '/';
		}

		const cwd = path.isAbsolute(pattern) ? '/' : workspaceRoot; // do not return full path if at workspaceRoot
		const nodir = (expandOption === ExpandPathsOption.filesOnly);
		const paths = globSync(pattern, { cwd: cwd, nodir: nodir });

		paths.forEach((path, index, paths) => {
			if (path.endsWith('/') || path.endsWith('\\')) {
				// remove trailing \ /
				path = path.substr(0, path.length - 1);
			}
			path = escapeTemplateText(path);
			paths[index] = path;
		});
		return paths;
	}
}

/** Normalize path, always use '/' as a path separator */
export function normalizePath(p: string): string {
	return path.normalize(p).replace(/\\/g, '/');
}

export function getErrorMessage(error: unknown) {
	if (error instanceof Error) return error.message
	return String(error)
}
