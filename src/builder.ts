/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2019 Tomasz Jastrzębski. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

'use strict';

import { IStringDictionary, checkFileExists, resolveVariables, ConfigurationJson, BuildStepsFileSchema, PropertiesFileSchema } from "./main";
import { BuildConfigurations, BuildConfiguration, BuildType } from "./interfaces";
import { globAsync, getJsonObject, ExecCmdResult, execCmd, addToDictionary } from "./utils";
import { getCppConfigParams, validateJsonFile, createOutputDirectory, buildCommand } from "./processor";
import { AsyncSemaphore } from "@esfx/async-semaphore";
import { hasMagic } from "glob";
import * as path from 'path';
import { deepClone } from "./vscode";

export class Builder {
	// TODO: improve, it is kinda 'poor man's approach', use prex CancellationToken?
	private _aborting: boolean = false;

	async runBuild(workspaceRoot: string, propertiesPath: string, buildStepsPath: string, configName: string, buildTypeName: string, cliExtraParams: IStringDictionary<string | string[]>, maxTaskCount: number, logOutput: (text: string) => void, logError: (text: string) => void) {
		const workspaceRootFolderName = path.basename(workspaceRoot);
		const extraParams: IStringDictionary<string | string[]> = { 'workspaceRoot': workspaceRoot, 'workspaceFolder': workspaceRoot, 'workspaceRootFolderName': workspaceRootFolderName, 'configName': configName };

		if (buildTypeName) extraParams['buildTypeName'] = buildTypeName;

		let errors = validateJsonFile(buildStepsPath, BuildStepsFileSchema);
		if (errors) {
			throw new Error(`'${buildStepsPath}' file schema validation error(s).\n${(<string[]>errors).join('\n\n')}`);
		}

		errors = validateJsonFile(propertiesPath, PropertiesFileSchema);
		if (errors) {
			throw new Error(`'${propertiesPath}' file schema validation error(s).\n${(<string[]>errors).join('\n\n')}`);
		}

		if (!configName) {
			throw new Error('Configuration name argument must be provided.');
		}

		if (maxTaskCount < 1) {
			throw new Error('Maximum number of concurrent tasks must be greater than 0.');
		}

		if (await checkFileExists(propertiesPath) === false) {
			throw new Error(`C/C++ properties file '${propertiesPath}' not found.`);
		}

		if (await checkFileExists(buildStepsPath) === false) {
			throw new Error(`Build steps file '${buildStepsPath}' not found.`);
		}

		const configurationJson: ConfigurationJson | undefined = getJsonObject(propertiesPath);

		if (!configurationJson) {
			throw new Error(`Configuration '${configName}' not found in '${propertiesPath}' file.`);
		}

		if (configurationJson.version !== 4) {
			throw new Error(`Unsupported C/C++ properties file version '${configurationJson.version}'.`);
		}

		const cppParams = getCppConfigParams(configurationJson, configName);

		if (!cppParams) {
			throw new Error(`Configuration name '${configName}' not found in '${propertiesPath}' file.`);
		}

		const buildConfigs: BuildConfigurations | undefined = getJsonObject(buildStepsPath);

		if (!buildConfigs) {
			throw new Error(`No build steps defined in file '${buildStepsPath}'.`);
		}

		const buildConfig: BuildConfiguration | undefined = buildConfigs!.configurations.filter(c => c.name == configName)[0];

		if (!buildConfig) {
			throw new Error(`Build configuration '${configName}' not found in file '${buildStepsPath}'.`);
		}

		if (buildTypeName) {
			// build type specified
			if (buildConfig.buildTypes == undefined) {
				throw new Error(`No build types defined for configuration '${configName}'.`);
			}

			const buildTypes = buildConfig.buildTypes.filter(t => t.name == buildTypeName);

			if (buildTypes.length == 0) {
				throw new Error(`Build type '${buildTypeName}' not defined for configuration '${configName}'.`);
			} else if (buildTypes.length > 1) {
				throw new Error(`Build type '${buildTypeName}' defined more than once for configuration '${configName}'.`);
			}

			const buildType: BuildType = buildTypes[0];
			if (buildType.params) addToDictionary(buildType.params, extraParams);
		}

		// fix/expand includePaths and forcedInclude - since paths may contain '**' wildcards
		if (cppParams.includePath) cppParams.includePath = await this.expandPaths(workspaceRoot, extraParams, cppParams.includePath);
		extraParams['includePath'] = cppParams.includePath || [];

		if (cppParams.forcedInclude) cppParams.forcedInclude = await this.expandPaths(workspaceRoot, extraParams, cppParams.forcedInclude);
		extraParams['forcedInclude'] = cppParams.forcedInclude || [];

		extraParams['defines'] = cppParams.defines || [];

		// apply command line params last - they override build file params
		if (cliExtraParams) addToDictionary(cliExtraParams, extraParams);

		// run build steps
		for (const buildStep of buildConfig.buildSteps) {
			if (buildStep.filePattern) buildStep.filePattern = resolveVariables(buildStep.filePattern, extraParams);
			if (buildStep.fileList) buildStep.fileList = resolveVariables(buildStep.fileList, extraParams);

			try {
				await this.runBuildStep(workspaceRoot, buildStep.command, extraParams, buildStep.name, maxTaskCount, logOutput, logError, buildStep.filePattern, buildStep.fileList, buildStep.outputDirectory);
			} catch (e) {
				throw new Error(`An error occurred during '${buildStep.name}' step - terminating.\n${e.message}`);
			}
		}
	}

	// TODO: consider adding a flag to allow to continue on errors
	async runBuildStep(workspaceRoot: string, commandTmpl: string, extraParams: IStringDictionary<string | string[]>, label: string, maxTaskCount: number, logOutput: (text: string) => void, logError: (text: string) => void, filePattern?: string, fileList?: string, outputDirectoryTmpl?: string) {
		if (filePattern) {
			// run command for each file
			const filePaths: string[] = await globAsync(filePattern, { cwd: workspaceRoot });
			// TODO: first create list of existing files
			// TODO: implement better throttling - the problem with Semaphore approach is thread is started and then awaited
			const semaphore: AsyncSemaphore = new AsyncSemaphore(maxTaskCount);

			const tasks: Promise<void>[] = filePaths.map(async (filePath) => {
				if (this._aborting) return; // TODO: use @esfx/async-canceltoken
				await semaphore.wait();
				try {
					if (false === await checkFileExists(path.join(workspaceRoot, filePath))) return;
					const params = deepClone(extraParams);
					// run for each file
					const actionName: string = label + ': ' + filePath;
					const fileDirectory: string = path.dirname(filePath);
					const extName: string = path.extname(filePath);
					const fullFileName: string = path.basename(filePath);
					const fileName: string = fullFileName.substr(0, fullFileName.length - extName.length);
					params['fileDirectory'] = fileDirectory == '.' ? '' : fileDirectory;
					params['filePath'] = filePath;
					params['fileName'] = fileName;

					if (outputDirectoryTmpl) {
						params['outputDirectory'] = await createOutputDirectory(workspaceRoot, outputDirectoryTmpl, params);
					}

					let command: string = buildCommand(commandTmpl, params);
					const result = await this.execCommand(command, workspaceRoot, actionName, logOutput, logError);
					if (result && result.error) throw result.error;
				} catch (e) {
					this._aborting = true;
					throw e;
				} finally {
					semaphore.release();
				}
			});

			try {
				await Promise.all(tasks);
			} catch (e) {
				this._aborting = true;
				throw e;
			}
		} else {
			extraParams = deepClone(extraParams);

			if (fileList) {
				const filePaths: string[] = await globAsync(fileList, { cwd: workspaceRoot });
				const fileDirectories: string[] = [];
				const fileNames: string[] = [];

				filePaths.map(filePath => {
					const fileDirectory = path.dirname(filePath);
					fileDirectories.push(fileDirectory == '.' ? '' : fileDirectory);
					const extName: string = path.extname(filePath);
					const fullFileName: string = path.basename(filePath);
					fileNames.push(fullFileName.substr(0, fullFileName.length - extName.length));
				});

				extraParams['fileDirectory'] = fileDirectories;
				extraParams['filePath'] = filePaths;
				extraParams['fileName'] = fileNames;
			}

			if (outputDirectoryTmpl) {
				extraParams['outputDirectory'] = await createOutputDirectory(workspaceRoot, outputDirectoryTmpl, extraParams);
			}

			let command: string = buildCommand(commandTmpl, extraParams);
			const result = await this.execCommand(command, workspaceRoot, label, logOutput, logError);
			if (result && result.error) throw result.error;
		}
	}

	/** fix/expand includePaths and forcedInclude - since they may contain '**' wildcards */
	async expandPaths(workspaceRoot: string, extraParams: IStringDictionary<string | string[]>, includePaths: string[]): Promise<string[]> {
		const expandedPaths: string[] = [];

		for (const p of includePaths) {
			let pattern = p.trim();

			pattern = resolveVariables(pattern, extraParams);
			pattern = resolveVariables(pattern, extraParams);

			if (pattern.endsWith('/*')) pattern = pattern.substr(0, pattern.length - 1);
			if (pattern.endsWith('\\*')) pattern = pattern.substr(0, pattern.length - 2);
			if (!pattern.endsWith('/')) pattern += '/'; // causes to match directories only

			if (hasMagic(pattern)) {
				const cwd = path.isAbsolute(pattern) ? '/' : workspaceRoot;
				const filePaths = await globAsync(pattern, { cwd: cwd });

				if (filePaths.length > 0) {
					filePaths.forEach(filePath => {
						const trim = filePath.endsWith('/') || filePath.endsWith('\\');
						if (trim) filePath = filePath.substr(0, filePath.length - 1);
						if (!expandedPaths.includes(filePath)) expandedPaths.push(filePath);
					});
				}
			} else {
				// pattern ends with '/' - trim
				pattern = pattern.substr(0, pattern.length - 1);
				if (!expandedPaths.includes(pattern)) expandedPaths.push(pattern);
			}
		}

		return expandedPaths;
	}

	async execCommand(commandLine: string, rootPath: string, actionName: string, logOutput: (line: string) => void, logError: (line: string) => void): Promise<ExecCmdResult | undefined> {
		let result: ExecCmdResult | undefined = undefined;

		await execCmd(commandLine, { cwd: rootPath }).then(res => {
			if (!this._aborting) logOutput(actionName);
			result = res;
		}).catch(e => {
			if (!this._aborting) logError('action: ' + actionName);
			if (!this._aborting) logError('command: ' + commandLine);

			result = e as ExecCmdResult;

			// if (result.error) {
			// 	logError('error msg: ' + result.error.message);
			// 	logError('error code: ' + result.error.code);
			// } else {
			// 	throw e; // unexpected exception
			// }
		}).finally(() => {
			if (result) {
				if (!this._aborting) logOutput(result.stdout);
				if (!this._aborting) logError(result.stderr);
			}
		});

		return result;
	}
}
