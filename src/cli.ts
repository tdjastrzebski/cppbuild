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

let _workspaceRoot: string = process.cwd();
let _propertiesPath: string;
let _buildStepsPath: string;
let _configName: string | undefined = undefined;
let _buildTypeName: string | undefined = undefined;
let _maxTaskCount: number = 4;

const program = new cmd.Command();
program.name(ToolName)
	.version(ToolVersion, '--version', 'output the current version')
	.description('VS Code C/C++ Build Tool\nhttps://github.com/tdjastrzebski/cppbuild')
	.usage(`<configuration name> [build type] [options]`)
	.arguments('<configuration name> [build type]')
	.option('-w, --workspace-root <path>', 'workspace root path - default is th current folder')
	.option('-b, --build-file <file>', `name of the file containing build configurations (default: '${PropertiesFolder}/${BuildStepsFile}')`)
	.option('-p, --properties-file <file>', `name of the file containing C/C++ configurations (default: '${PropertiesFolder}/${PropertiesFile}')`)
	.option('-v, --variable <name=value>', 'variable name and value - can be specified multiple times', parseVariables)
	.option('-j, --max-tasks <number>', `maximum number of tasks run in parallel (default: ${_maxTaskCount})`)
	.action((config, build) => { _configName = config; _buildTypeName = build; });
program.parse(process.argv);

if (program.workspaceRoot) _workspaceRoot = program.workspaceRoot;
_propertiesPath = path.join(_workspaceRoot, PropertiesFolder, PropertiesFile);
_buildStepsPath = path.join(_workspaceRoot, PropertiesFolder, BuildStepsFile);

if (program.maxTasks) {
	if (isNumber(program.maxTasks)) {
		_maxTaskCount = program.maxTasks;
	} else {
		console.error(`Invalid maximum number of concurrent tasks - option ignored.`);
	}
}

const cliExtraParams = program.variable as IStringDictionary<string>;

if (program.buildFile) {
	if (path.isAbsolute(program.buildFile)) {
		_buildStepsPath = program.buildFile;
	} else {
		_buildStepsPath = path.join(_workspaceRoot, program.buildFile);
	}
}

if (program.configurationsFile) {
	if (path.isAbsolute(program.configurationsFile)) {
		_propertiesPath = program.configurationsFile;
	} else {
		_propertiesPath = path.join(_workspaceRoot, program.configurationsFile);
	}
}

console.log('workspace root: ' + _workspaceRoot);
console.log('C/C++ configurations file: ' + _propertiesPath);
console.log('build configurations file: ' + _buildStepsPath);
console.log('config name: ' + (_configName || 'none'));
console.log('build type: ' + (_buildTypeName || 'none'));

(async () => {
	const start = process.hrtime();
	const builder = new Builder();

	try {
		await builder.runBuild(_workspaceRoot, _propertiesPath, _buildStepsPath, _configName!, _buildTypeName!, cliExtraParams, _maxTaskCount, logBuildOutput, logBuildError);
	} catch (e) {
		const error = e as Error;
		if (error) console.error(error.message);
		process.exit(1);
		return;
	}

	const end = process.hrtime(start);
	const timeElapsed = end[0] + end[1] / 1000000000;
	console.log(`Build steps completed in ${timeElapsed.toFixed(2)}s`);
})();

function logBuildOutput(line: string) {
	console.log(line);
}

function logBuildError(line: string) {
	console.error(line);
}

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
