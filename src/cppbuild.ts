#!/usr/bin/env node

/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2019 Tomasz Jastrzębski. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

'use strict';

import { IStringDictionary } from './interfaces';
import { getLatestVersion } from './utils';
import { ToolName, ToolVersion, VscodeFolder, BuildStepsFile, PropertiesFile, BuildStepsFileSchema, PropertiesFileSchema } from './consts';
import { isNumber } from 'util';
import { Builder } from './builder';
import * as semver from 'semver';
import * as path from 'path';
import chalk from 'chalk';
import cmd from 'commander';
import { isatty } from 'tty';

const Description = chalk.greenBright(`Multi-step C/C++ incremental build tool version ${ToolVersion}\nhttps://github.com/tdjastrzebski/cppbuild`);
const ProcessCwd: string = process.cwd();
const Program = new cmd.Command();

let _workspaceRoot: string;
let _buildFile: string | undefined;
let _propertiesFile: string | undefined;
let _configName: string | undefined;
let _buildTypeName: string | undefined;
let _maxTask: number = 4;
let _forceRebuild: boolean = false;

Program.name(ToolName)
	.version(ToolVersion, '--version', 'output the current version')
	.description(Description)
	.usage(`<configuration name> [build type] [options]`)
	.arguments('<configuration name> [build type]')
	.option('-w, --workspace-root [path]', 'VS Code workspace root path (default: the current folder)')
	.option('-b, --build-file <file>', `name of the file containing build steps definitions (default: '${VscodeFolder}/${BuildStepsFile}')`)
	.option('-p, --properties-file [file]', `name of the file containing C/C++ configurations (default: '${VscodeFolder}/${PropertiesFile}')`)
	.option('-v, --variable <name=value>', 'variable name and value - can be specified multiple times', parseVariables)
	.option('-j, --max-tasks <number>', `maximum number of tasks run in parallel (default: ${_maxTask})`)
	.option('-f, --force-rebuild', `disable incremental build`)
	.action((config, build) => { _configName = config; _buildTypeName = build; });
Program.parse(process.argv);

if (Program.workspaceRoot) {
	if (Program.workspaceRoot === true) {
		_workspaceRoot = ProcessCwd;
	} else {
		_workspaceRoot = Program.workspaceRoot;
	}
	_propertiesFile = path.join(_workspaceRoot, VscodeFolder, PropertiesFile);
	_buildFile = path.join(_workspaceRoot, VscodeFolder, BuildStepsFile);
} else {
	_workspaceRoot = ProcessCwd;
}

if (Program.propertiesFile) {
	if (Program.propertiesFile === true) {
		_propertiesFile = undefined;
	} else {
		if (path.isAbsolute(Program.configurationsFile)) {
			_propertiesFile = Program.configurationsFile;
		} else {
			_propertiesFile = path.join(ProcessCwd, Program.configurationsFile);
		}
	}
}

if (Program.buildFile) {
	if (path.isAbsolute(Program.buildFile)) {
		_buildFile = Program.buildFile;
	} else {
		_buildFile = path.join(ProcessCwd, Program.buildFile);
	}
}

if (!_buildFile) {
	_buildFile = path.join(ProcessCwd, BuildStepsFile);
}

if (Program.maxTasks) {
	if (isNumber(Program.maxTasks)) {
		_maxTask = Program.maxTasks;
	} else {
		console.error(`Invalid maximum number of concurrent tasks - option ignored.`);
	}
}

if (Program.forceRebuild === true) _forceRebuild = true;

const cliExtraParams = Program.variable as IStringDictionary<string>;

console.log(Description);
console.log();
console.log('workspace root: ' + _workspaceRoot);
console.log('build steps file: ' + _buildFile);
console.log('C/C++ properties file: ' + (_propertiesFile || 'none'));
console.log('config name: ' + (_configName || 'none'));
console.log('build type: ' + (_buildTypeName || 'none'));
console.log();

const builder = new Builder();

(async () => {
	const start = process.hrtime();

	try {
		await builder.runBuild(_workspaceRoot, _propertiesFile, _buildFile, _configName!, _buildTypeName!, cliExtraParams, _maxTask, _forceRebuild, logBuildOutput, logBuildError);
	} catch (e) {
		const error = e as Error;
		if (error) console.error(error.message);
		await newVersionInfo();
		process.exit(1);
		return;
	}

	const end = process.hrtime(start);
	const timeElapsed = end[0] + end[1] / 1000000000;
	console.log(`Build steps completed in ${timeElapsed.toFixed(2)}s`);
	await newVersionInfo();
})();

async function newVersionInfo() {
	let latestVersion: string | undefined;

	if (isatty(1)) {
		try {
			latestVersion = await getLatestVersion(ToolName);
		} catch {
			// ignore errors;
		}
	}

	if (latestVersion && semver.gt(latestVersion, ToolVersion)) {
		console.log(chalk.yellow(`\nThe latest version of ${ToolName} is ${latestVersion} and you have ${ToolVersion}.\nUpdate it now: npm install -g ${ToolName}`));
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
		console.error('invalid variable name/value: ' + variable);
		return params;
	}
	const name = variable.substr(0, i).trim();
	const value = variable.substr(i + 1).trim();
	params[name.trim()] = value;
	return params;
}
