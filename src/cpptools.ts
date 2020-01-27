/*------------------------------------------- START OF LICENSE -----------------------------------------
vscode-cpptools 

Copyright (c) Microsoft Corporation

All rights reserved.

MIT License

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the Software), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED *AS IS*, WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
----------------------------------------------- END OF LICENSE ------------------------------------------*/

// Source https://github.com/microsoft/vscode-cpptools

'use strict';

import * as assert from 'assert';
import * as path from 'path';
import * as fs from 'fs';

//export let extensionPath: string;

/*
export let extensionContext: vscode.ExtensionContext;
export let rootUri: vscode.Uri;
let rootfs: string|null = null;
let configurationJson: ConfigurationJson|null = null;

export function setExtensionContext(context: vscode.ExtensionContext): void {
	extensionContext = context;
	extensionPath = extensionContext.extensionPath;
}

export function setExtensionPath(path: string): void {
	extensionPath = path;
}

export type Environment = { [key: string]: string | string[] };
*/

/*
function getExtendedEnvironment(): Environment {
	let result: Environment = {};
	if (configurationJson.env) {
		Object.assign(result, configurationJson.env);
	}

	result["workspaceFolderBasename"] = rootUri ? path.basename(rootUri.fsPath) : "";
	return result;
}

private get ExtendedEnvironment(): Environment {
	let result: Environment = {};
	if (this.configurationJson.env) {
		Object.assign(result, this.configurationJson.env);
	}

	result["workspaceFolderBasename"] = this.rootUri ? path.basename(this.rootUri.fsPath) : "";
	return result;
}
*/
export function resolveVariables(input: string | undefined, additionalEnvironment: { [key: string]: string | string[] }): string;
export function resolveVariables(input: string[] | undefined, additionalEnvironment: { [key: string]: string | string[] }): string[];
export function resolveVariables(input: string | string[] | undefined, additionalEnvironment: { [key: string]: string | string[] }): any {
	if (!additionalEnvironment) additionalEnvironment = {};
	if (isArrayOfString(input)) {
		const tmpArray: string[] = [];
		if (!input) return tmpArray;
		input.forEach(val => {
			tmpArray.push(resolveVariables(val, additionalEnvironment));
		});
		return tmpArray;
	}
	if (!input) return '';
	// Replace environment and configuration variables.
	let regexp: () => RegExp = () => /\$\{((env|config|workspaceFolder)(\.|:))?(.*?)\}/g;
	let ret: string = input;
	let cycleCache: Set<string> = new Set();

	while (!cycleCache.has(ret)) {
		cycleCache.add(ret);
		ret = ret.replace(regexp(), (match: string, ignored1: string, varType: string, ignored2: string, name: string) => {
			// Historically, if the variable didn't have anything before the "." or ":"
			// it was assumed to be an environment variable
			if (varType === undefined) {
				varType = "env";
			}

			let newValue: string | undefined = undefined;

			switch (varType) {
				case "env": {
					let v: string | string[] = additionalEnvironment[name];
					if (isString(v)) {
						newValue = v;
					} else if (input === match && isArrayOfString(v)) {
						newValue = v.join(";");
					}
					if (!isString(newValue)) {
						newValue = process.env[name];
					}
					break;
				}
				/*
                case "config": {
					let config: vscode.WorkspaceConfiguration = vscode.workspace.getConfiguration();
					if (config) {
						newValue = config.get<string>(name);
					}
					break;
				}
				case "workspaceFolder": {
					// Only replace ${workspaceFolder:name} variables for now.
					// We may consider doing replacement of ${workspaceFolder} here later, but we would have to update the language server and also
					// intercept messages with paths in them and add the ${workspaceFolder} variable back in (e.g. for light bulb suggestions)
					if (name && vscode.workspace && vscode.workspace.workspaceFolders) {
						let folder: vscode.WorkspaceFolder|undefined = vscode.workspace.workspaceFolders.find(folder => folder.name.toLocaleLowerCase() === name.toLocaleLowerCase());
						if (folder) {
							newValue = folder.uri.fsPath;
						}
					}
					break;
                }
                */
				default: { assert.fail("unknown varType matched"); }
			}
			return (isString(newValue)) ? newValue : match;
		});
	}

	// Resolve '~' at the start of the path.
	regexp = () => /^\~/g;
	ret = ret.replace(regexp(), (match: string, name: string) => {
		let newValue: string | undefined = (process.platform === 'win32') ? process.env.USERPROFILE : process.env.HOME;
		return (newValue) ? newValue : match;
	});

	return ret;
}

export function isString(input: any): input is string {
	return typeof (input) === "string";
}

export function isArrayOfString(input: any): input is string[] {
	return isArray(input) && input.every(isString);
}

export function isArray(input: any): input is any[] {
	return input instanceof Array;
}

let vcpkgRoot: string;
function getVcpkgRoot(): string {
	if (!vcpkgRoot && vcpkgRoot !== "") {
		vcpkgRoot = "";
		// Check for vcpkg instance.
		if (fs.existsSync(getVcpkgPathDescriptorFile())) {
			let vcpkgRootTemp: string = fs.readFileSync(getVcpkgPathDescriptorFile()).toString();
			vcpkgRootTemp = vcpkgRootTemp.trim();
			if (fs.existsSync(vcpkgRootTemp)) {
				vcpkgRoot = path.join(vcpkgRootTemp, "/installed").replace(/\\/g, "/");
			}
		}
	}
	return vcpkgRoot;
}

function getVcpkgPathDescriptorFile(): string {
	if (process.platform === 'win32') {
		return path.join(process.env.LOCALAPPDATA!, "vcpkg/vcpkg.path.txt");
	} else {
		return path.join(process.env.HOME!, ".vcpkg/vcpkg.path.txt");
	}
}

export function touchFolder(folderPath: string): Promise<void> {
	return new Promise<void>((resolve, reject) => {
		fs.utimes(path.resolve(folderPath, ".."), new Date(Date.now()), new Date(Date.now()), (err) => {
			if (err) {
				reject(err);
			} else {
				resolve();
			}
		});
	});
}

/** Test whether a file exists */
export function checkFileExists(filePath: string): Promise<boolean> {
	return new Promise((resolve, reject) => {
		fs.stat(filePath, (err, stats) => {
			if (stats && stats.isFile()) {
				resolve(true);
			} else {
				resolve(false);
			}
		});
	});
}

/** Test whether a directory exists */
export function checkDirectoryExists(dirPath: string): Promise<boolean> {
	return new Promise((resolve, reject) => {
		fs.stat(dirPath, (err, stats) => {
			if (stats && stats.isDirectory()) {
				resolve(true);
			} else {
				resolve(false);
			}
		});
	});
}

export function checkFileExistsSync(filePath: string): boolean {
	try {
		return fs.statSync(filePath).isFile();
	} catch (e) {
	}
	return false;
}

/** Test whether a directory exists */
export function checkDirectoryExistsSync(dirPath: string): boolean {
	try {
		return fs.statSync(dirPath).isDirectory();
	} catch (e) {
	}
	return false;
}

/** Read the files in a directory */
export function readDirectory(dirPath: string): Promise<string[]> {
	return new Promise((resolve) => {
		fs.readdir(dirPath, (err, list) => {
			resolve(list);
		});
	});
}

/** copied from https://github.com/microsoft/vscode-cpptools */
export interface ConfigurationJson {
	configurations: Configuration[];
	env?: { [key: string]: string | string[] };
	version: number;
	enableConfigurationSquiggles?: boolean;
}

/** copied from https://github.com/microsoft/vscode-cpptools */
export interface Configuration {
	name: string;
	compilerPath?: string;
	knownCompilers?: KnownCompiler[];
	cStandard?: string;
	cppStandard?: string;
	includePath?: string[];
	macFrameworkPath?: string[];
	windowsSdkVersion?: string;
	defines?: string[];
	intelliSenseMode?: string;
	compileCommands?: string;
	forcedInclude?: string[];
	configurationProvider?: string;
	browse?: Browse;
}

/** copied from https://github.com/microsoft/vscode-cpptools */
export interface Browse {
	path?: string[];
	limitSymbolsToIncludedHeaders?: boolean | string;
	databaseFilename?: string;
}

/** copied from https://github.com/microsoft/vscode-cpptools */
export interface KnownCompiler {
	path: string;
	isC: boolean;
}
