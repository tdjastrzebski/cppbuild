#!/usr/bin/env node

/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2019 Tomasz Jastrzębski. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

'use strict';

import * as path from 'path';
import cmd from 'commander';
import { IStringDictionary } from './interfaces';
import { isNumber } from 'util';
import { ToolName, ToolVersion, PropertiesFolder, BuildStepsFile, PropertiesFile, BuildStepsFileSchema, PropertiesFileSchema } from './main';
import { Builder } from './builder';
import * as semver from 'semver';
import { isatty } from 'tty';
import chalk from 'chalk';
import { getLatestVersion } from './utils';

let _workspaceRoot: string = process.cwd();
let _propertiesFile: string | undefined = undefined;
let _buildFile: string;
let _configName: string | undefined = undefined;
let _buildTypeName: string | undefined = undefined;
let _maxTask: number = 4;
const _description = `Multi-step C/C++ incremental build tool version ${ToolVersion}\nhttps://github.com/tdjastrzebski/cppbuild`;
let _latestVersion: string | undefined = undefined;
let _forceRebuild: boolean = false;

const program = new cmd.Command();
program.name(ToolName)
	.version(ToolVersion, '--version', 'output the current version')
	.description(_description)
	.usage(`<configuration name> [build type] [options]`)
	.arguments('<configuration name> [build type]')
	.option('-w, --workspace-root <path>', 'workspace root path (default: the current folder)')
	.option('-b, --build-file <file>', `name of the file containing build steps definitions (default: '${PropertiesFolder}/${BuildStepsFile}')`)
	.option('-p, --properties-file [file]', `name of the file containing C/C++ configurations (default: '${PropertiesFolder}/${PropertiesFile}')`)
	.option('-v, --variable <name=value>', 'variable name and value - can be specified multiple times', parseVariables)
	.option('-j, --max-tasks <number>', `maximum number of tasks run in parallel (default: ${_maxTask})`)
	.option('-f, --force-rebuild', `disable incremental build`)
	.action((config, build) => { _configName = config; _buildTypeName = build; });
program.parse(process.argv);

if (program.workspaceRoot) _workspaceRoot = program.workspaceRoot;
_propertiesFile = path.join(_workspaceRoot, PropertiesFolder, PropertiesFile);
_buildFile = path.join(_workspaceRoot, PropertiesFolder, BuildStepsFile);

if (program.maxTasks) {
	if (isNumber(program.maxTasks)) {
		_maxTask = program.maxTasks;
	} else {
		console.error(`Invalid maximum number of concurrent tasks - option ignored.`);
	}
}

const cliExtraParams = program.variable as IStringDictionary<string>;

if (program.buildFile) {
	if (path.isAbsolute(program.buildFile)) {
		_buildFile = program.buildFile;
	} else {
		_buildFile = path.join(_workspaceRoot, program.buildFile);
	}
}

if (program.propertiesFile === true) {
	_propertiesFile = undefined;
} else if (program.propertiesFile) {
	if (path.isAbsolute(program.configurationsFile)) {
		_propertiesFile = program.configurationsFile;
	} else {
		_propertiesFile = path.join(_workspaceRoot, program.configurationsFile);
	}
}

if (program.forceRebuild === true) _forceRebuild = true;

console.log(_description);
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
		process.exit(1);
		return;
	}

	const end = process.hrtime(start);
	const timeElapsed = end[0] + end[1] / 1000000000;
	console.log(`Build steps completed in ${timeElapsed.toFixed(2)}s`);

	if (isatty(1)) {
		try {
			_latestVersion = await getLatestVersion(ToolName);
		} catch {
			// ignore errors;
		}
	}

	if (_latestVersion && semver.gt(_latestVersion, ToolVersion)) {
		console.log(chalk.yellow(`\nThe latest version of ${ToolName} is ${_latestVersion} and you have ${ToolVersion}.\nUpdate it now: npm install -g ${ToolName}`));
	}
})();

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
