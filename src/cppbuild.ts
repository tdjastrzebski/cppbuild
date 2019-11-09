#!/usr/bin/env node

/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2019 Tomasz Jastrzębski. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

'use strict';

import { IStringDictionary } from './interfaces';
import { getLatestVersion, sleep, elapsedMills, info, warn, err, head, reg, high } from './utils';
import { ToolName, ToolVersion, VscodeFolder, BuildStepsFile, PropertiesFile } from './consts';
import { CancelToken } from "@esfx/async-canceltoken";
import { isNumber } from 'util';
import { Builder } from './builder';
import { isatty } from 'tty';
import cmd from 'commander';
import * as semver from 'semver';
import * as path from 'path';

const Description = info(`Multi-step C/C++ incremental build tool version ${ToolVersion}\nhttps://github.com/tdjastrzebski/cppbuild`);
const ProcessCwd: string = process.cwd();
const Program = new cmd.Command();
const DefaultMaxTask = 4;

Program.name(ToolName)
	.version(ToolVersion, '--version', 'output the current version')
	.description(Description)
	.usage(`<configuration name> [build type] [options]`)
	.arguments('<configuration name> [build type]')
	.option('-w, --workspace-root [path]', 'VS Code workspace root path (default: the current folder)')
	.option('-b, --build-file <file>', `name of the file containing build steps definitions (default: '${VscodeFolder}/${BuildStepsFile}')`)
	.option('-p, --properties-file [file]', `name of the file containing C/C++ configurations (default: '${VscodeFolder}/${PropertiesFile}')`)
	.option('-v, --variable <name=value>', 'variable name and value - can be specified multiple times', parseVariables)
	.option('-j, --max-tasks <number>', `maximum number of tasks run in parallel (default: ${DefaultMaxTask})`)
	.option('-f, --force-rebuild', `disable incremental build`)
	.action(doTask(build));

if (process.argv.length <= 2) {
	// no arguments passed
	Program.help();
} else {
	Program.parse(process.argv);
}

function trace(message: string) {
	//console.log(magentaBright(message));
}

function doTask(task: (...args: any) => Promise<void>) {
	return async (...args: any[]) => {
		trace('doTask');
		const GetLatestTimeout = 2500;
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
			if (error) console.error(err(error.message));
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
				console.log(warn(`\nThe latest version of ${ToolName} is ${latestVersion} and you have ${ToolVersion}.`));
				console.log(reg(`Update it now: npm install -g ${ToolName}`));
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
	let maxTask: number = DefaultMaxTask;
	let forceRebuild: boolean = false;

	if (Program.workspaceRoot) {
		if (Program.workspaceRoot === true) {
			workspaceRoot = ProcessCwd;
		} else {
			workspaceRoot = Program.workspaceRoot;
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
		if (isNumber(Program.maxTasks)) {
			maxTask = Program.maxTasks;
		} else {
			console.error(warn(`Invalid maximum number of concurrent tasks - option ignored.`));
		}
	}

	if (Program.forceRebuild === true) forceRebuild = true;

	const cliExtraParams = Program.variable as IStringDictionary<string>;

	console.log(Description);
	console.log();
	console.log(reg('workspace root: ') + high(workspaceRoot));
	console.log(reg('build steps file: ') + high(buildFile));
	console.log(reg('C/C++ properties file: ') + high(propertiesFile || 'none'));
	console.log(reg('config name: ') + high(configName || 'none'));
	console.log(reg('build type: ') + high(buildTypeName || 'none'));
	console.log();

	const builder = new Builder();
	const start = process.hrtime();
	await builder.runBuild(workspaceRoot, propertiesFile, buildFile, configName!, buildTypeName!, cliExtraParams, maxTask, forceRebuild, logBuildOutput, logBuildError);
	const timeElapsed = elapsedMills(start) / 1000;
	console.log(info(`Build steps completed in ${timeElapsed.toFixed(2)}s`));
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
		console.error(warn('invalid variable name/value: ' + variable));
		return params;
	}
	const name = variable.substr(0, i).trim();
	const value = variable.substr(i + 1).trim();
	params[name.trim()] = value;
	return params;
}
