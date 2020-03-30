#!/usr/bin/env node

/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2019-2020 Tomasz Jastrzębski. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

'use strict';

import { getLatestVersion, sleep, elapsedMills, iColor, wColor, eColor, rColor, hColor, kColor, sColor } from './utils';
import { ToolName, ToolVersion, VscodeFolder, BuildStepsFile, PropertiesFile } from './consts';
import { BuilderOptions, CompilerType, IStringDictionary } from './interfaces';
import { Builder, setSampleBuildConfig } from './builder';
import { CancelToken } from "@esfx/async-canceltoken";
import { isatty } from 'tty';
import cmd from 'commander';
import * as semver from 'semver';
import * as path from 'path';
import { checkDirectoryExists } from './cpptools';

const Description = iColor(`Multi-step C/C++ incremental build tool version ${ToolVersion}\nhttps://github.com/tdjastrzebski/cppbuild`);
const ProcessCwd: string = process.cwd();
const Program = new cmd.Command();
const DefaultMaxTask = 4;

Program
	.name(ToolName)
	.version(ToolVersion, '--version', 'output the current version')
	.description(Description)
	.usage('<configuration name> [build type] [options]')
	.exitOverride(err => {
		if (err.exitCode != 0) {
			console.error(`Use: ${ToolName} --help for a list of available options.`);
		}
	});
Program
	.arguments('<configuration name> [build type]')
	.option('-w, --workspace-root [path]', 'VS Code workspace root path (default: the current folder)')
	.option('-b, --build-file <file>', `name of the file containing build steps definitions (default: '${VscodeFolder}/${BuildStepsFile}')`)
	.option('-p, --properties-file [file]', `name of the file containing C/C++ configurations (default: '${VscodeFolder}/${PropertiesFile}')`)
	.option('-v, --variable <name=value>', 'variable name and value - can be specified multiple times', parseVariables)
	.option('-j, --max-tasks <number>', `maximum number of tasks run in parallel (default: ${DefaultMaxTask})`)
	.option('-f, --force-rebuild', 'disable incremental build')
	.option('-d, --debug', 'display extra debug info')
	.option('-t, --trim-include-paths', 'removes unnecessary include paths')
	.option('-i, --initialize <path>', `create sample build configuration, usage: ${ToolName} <configuration name> <gcc-x64 | clang-x64 | msvc-x64> -i <path>`)
	.option('-c, --continue-on-error', 'causes build to continue on execution error')
	.action(doTask(build));

// TODO: consider defining custom help:
// Program.on('--help', () => {}

if (process.argv.length <= 2) {
	// no arguments passed
	Program.outputHelp();
} else {
	try {
		Program.parse(process.argv);
	} catch (e) {
		// ignore - handled via exitOverride()
	}
}

function trace(message: string) {
	//console.log(dColor(message));
}

async function initialize(path: string | undefined) {
	trace('initialize');
}

function doTask(task: (...args: any) => Promise<void>) {
	return async (...args: any[]) => {
		trace('doTask');
		const GetLatestTimeout = 2500; // ms
		const getLatest = CancelToken.source();
		const waitMore = CancelToken.source();
		let exitCode: number = 0;
		let latestVersion: string | undefined;

		if (isatty(1)) {
			// inquiry version right away
			const startGet = process.hrtime();
			getLatestVersion(ToolName, getLatest.token).then(version => {
				latestVersion = version;
				const elapsed = elapsedMills(startGet);
				trace(`latest obtained: ${latestVersion} in ${elapsed / 1000}s`);
			}).catch(reason => {
				trace('error getting latest');
				latestVersion = '';
				// ignore any errors
			}).finally(() => {
				trace('waitMore cancelled');
				waitMore.cancel();
			});
		}

		const start = process.hrtime();

		try {
			await task(...args);
		} catch (e) {
			exitCode = 1;
			trace('catch build error');
			const error = e as Error;
			if (error) console.error(eColor(error.message));
		} finally {
			const elapsed = elapsedMills(start);
			trace('finally ' + elapsed);

			if (latestVersion === undefined && elapsed < GetLatestTimeout) {
				// wait more to get the latest version
				trace('waiting more ' + (GetLatestTimeout - elapsed));
				await sleep(GetLatestTimeout - elapsed, waitMore.token);
			}

			getLatest.cancel(); // wait no more

			if (latestVersion && semver.gt(latestVersion, ToolVersion)) {
				console.log(wColor(`\nThe latest version of ${ToolName} is ${latestVersion} and you have ${ToolVersion}.`));
				console.log(rColor(`Update it now: npm install -g ${ToolName}`));
			}

			process.exit(exitCode);
		}
	};
}

async function build(configName: string | undefined, buildTypeName: string | undefined) {
	trace('build');
	let workspaceRoot: string;
	let buildFile: string | undefined;
	let propertiesFile: string | undefined;
	const options: BuilderOptions = { maxTasks: DefaultMaxTask, forceRebuild: false, debug: false, trimIncludePaths: false, continueOnError: false };

	if (Program.workspaceRoot) {
		if (Program.workspaceRoot === true) {
			workspaceRoot = ProcessCwd;
		} else {
			workspaceRoot = Program.workspaceRoot;
			if (!path.isAbsolute(workspaceRoot)) {
				workspaceRoot = path.join(ProcessCwd, workspaceRoot);
			}
			if (!await checkDirectoryExists(workspaceRoot)) {
				console.log(eColor(`Root folder '${workspaceRoot}' does not exist.`));
				process.exit(1);
			}
		}
		propertiesFile = path.join(workspaceRoot, VscodeFolder, PropertiesFile);
		buildFile = path.join(workspaceRoot, VscodeFolder, BuildStepsFile);
	} else {
		workspaceRoot = ProcessCwd;
	}

	if (Program.propertiesFile) {
		if (Program.propertiesFile === true) {
			propertiesFile = undefined;
		} else {
			if (path.isAbsolute(Program.configurationsFile)) {
				propertiesFile = Program.configurationsFile;
			} else {
				propertiesFile = path.join(ProcessCwd, Program.configurationsFile);
			}
		}
	}

	if (Program.buildFile) {
		if (path.isAbsolute(Program.buildFile)) {
			buildFile = Program.buildFile;
		} else {
			buildFile = path.join(ProcessCwd, Program.buildFile);
		}
	}

	if (!buildFile) {
		buildFile = path.join(ProcessCwd, BuildStepsFile);
	}

	if (Program.maxTasks) {
		const maxTasks = parseInt(Program.maxTasks);
		if (!isNaN(maxTasks)) {
			options.maxTasks = maxTasks;
		} else {
			console.error(wColor(`Invalid maximum number of concurrent tasks - option ignored.`));
		}
	}

	if (Program.forceRebuild === true) options.forceRebuild = true;
	if (Program.debug === true) options.debug = true;
	if (Program.trimIncludePaths === true) options.trimIncludePaths = true;
	if (Program.continueOnError === true) options.continueOnError = true;

	const cliExtraParams = Program.variable as IStringDictionary<string>;

	console.log(Description);
	console.log();

	if (!Program.initialize) {
		// run build steps
		console.log(rColor('workspace root: ') + hColor(workspaceRoot));
		console.log(rColor('build steps file: ') + hColor(buildFile));
		console.log(rColor('C/C++ properties file: ') + hColor(propertiesFile || 'none'));
		console.log(rColor('config name: ') + hColor(configName || 'none'));
		console.log(rColor('build type: ') + hColor(buildTypeName || 'none'));
		console.log();

		const builder = new Builder();
		const start = process.hrtime();
		const result = await builder.runBuild(workspaceRoot, propertiesFile, buildFile, configName!, buildTypeName!, cliExtraParams, options, logBuildOutput, logBuildError);
		const filesProcessed = result[0];
		const filesSkipped = result[1];
		const errorsEncountered = result[2];
		const timeElapsed = elapsedMills(start) / 1000;
		const errorsColor = errorsEncountered > 0 ? eColor : kColor;
		console.log(iColor(`Build steps completed in ${timeElapsed.toFixed(2)}s, ${filesProcessed} file(s) processed, ${filesSkipped} file(s) skipped, ` + errorsColor(`${errorsEncountered} error(s) encountered.`)));
	} else {
		// create sample config file
		const filePath = Program.initialize;
		const compilerType = buildTypeName;
		console.log(rColor('config name: ') + hColor(configName ?? 'none'));
		console.log(rColor('compiler type: ') + hColor(compilerType ?? 'none'));
		console.log(rColor('file path: ') + hColor(filePath ?? 'none'));
		console.log();

		if (configName && compilerType) {
			const stringToEnumValue = <ET, T>(enumObj: ET, str: string): T => (enumObj as any)[Object.keys(enumObj).filter(k => (enumObj as any)[k] === str)[0]];
			const cType = stringToEnumValue<typeof CompilerType, CompilerType>(CompilerType, compilerType); // convert string enum name to enum value
			if (cType) {
				await setSampleBuildConfig(filePath, configName, cType);
				console.log(kColor('success'));
			} else {
				console.log(eColor(`Unsupported compiler type: ${compilerType}.`));
				Program.outputHelp();
				process.exit(1);
			}
		} else {
			console.log(eColor('failure'));
			Program.outputHelp();
			process.exit(1);
		}
	}
}

function logBuildOutput(line: string) {
	console.log(line);
}

function logBuildError(line: string) {
	console.error(line);
}

// TODO: improve variable parsing, support multi-valued variables
function parseVariables(variable: string, params: IStringDictionary<string> = {}): IStringDictionary<string> {
	const i = variable.indexOf('=');
	if (i <= 0) {
		console.error(wColor('invalid variable name/value: ' + variable));
		return params;
	}
	const name = variable.substr(0, i).trim();
	const value = variable.substr(i + 1).trim();
	params[name.trim()] = value;
	return params;
}
