/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2019 Tomasz Jastrzębski. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

'use strict';

import { BuildStepsFileSchema, PropertiesFileSchema } from "./consts";
import { BuildConfigurations, BuildConfiguration, BuildType, CppParams, BuildStep, IStringDictionary } from "./interfaces";
import { globAsync, getJsonObject, ExecCmdResult, execCmd, addToDictionary, getFileMTime, getFileStatus, resolveVariablesTwice, elapsedMills, info } from "./utils";
import { getCppConfigParams, validateJsonFile, createOutputDirectory, buildCommand } from "./processor";
import { checkFileExists, ConfigurationJson, resolveVariables } from "./cpptools";
import { AsyncSemaphore } from "@esfx/async-semaphore";
import { AsyncMutex } from "@esfx/async-mutex";
import { hasMagic } from "glob";
import { deepClone } from "./vscode";
import * as path from 'path';

export class Builder {
	// TODO: improve, it is kinda 'poor man's approach', use prex CancellationToken?
	private _aborting: boolean = false;

	async runBuild(workspaceRoot: string, propertiesPath: string | undefined, buildStepsPath: string, configName: string, buildTypeName: string, cliExtraParams: IStringDictionary<string | string[]>, maxTaskCount: number, forceRebuild: boolean, logOutput: (text: string) => void, logError: (text: string) => void) {
		const workspaceRootFolderName = path.basename(workspaceRoot);
		const extraParams: IStringDictionary<string | string[]> = { 'workspaceRoot': workspaceRoot, 'workspaceFolder': workspaceRoot, 'workspaceRootFolderName': workspaceRootFolderName, 'configName': configName };

		if (buildTypeName) extraParams['buildTypeName'] = buildTypeName;

		if (!configName) {
			throw new Error('Configuration name argument must be provided.');
		}

		if (maxTaskCount < 1) {
			throw new Error('Maximum number of concurrent tasks must be greater than 0.');
		}

		if (propertiesPath && await checkFileExists(propertiesPath) === false) {
			throw new Error(`C/C++ properties file '${propertiesPath}' not found.`);
		}

		let cppParams: CppParams | undefined;

		if (propertiesPath) {
			let errors = validateJsonFile(propertiesPath, PropertiesFileSchema);
			if (errors) {
				throw new Error(`'${propertiesPath}' file schema validation error(s).\n${(<string[]>errors).join('\n\n')}`);
			}

			const configurationJson: ConfigurationJson | undefined = getJsonObject(propertiesPath);

			if (!configurationJson) {
				throw new Error(`Configuration '${configName}' not found in '${propertiesPath}' file.`);
			}

			if (configurationJson.version !== 4) {
				throw new Error(`Unsupported C/C++ properties file version '${configurationJson.version}'.`);
			}

			cppParams = getCppConfigParams(configurationJson, configName);

			if (!cppParams) {
				throw new Error(`Configuration name '${configName}' not found in '${propertiesPath}' file.`);
			}

			// fix/expand includePaths and forcedInclude - since paths may contain '**' wildcards
			if (cppParams.includePath) cppParams.includePath = await this.expandPaths(workspaceRoot, extraParams, cppParams.includePath);
			extraParams['includePath'] = cppParams.includePath || [];

			if (cppParams.forcedInclude) cppParams.forcedInclude = await this.expandPaths(workspaceRoot, extraParams, cppParams.forcedInclude);
			extraParams['forcedInclude'] = cppParams.forcedInclude || [];

			extraParams['defines'] = cppParams.defines || [];
		}

		if (await checkFileExists(buildStepsPath) === false) {
			throw new Error(`Build steps file '${buildStepsPath}' not found.`);
		}

		let errors = validateJsonFile(buildStepsPath, BuildStepsFileSchema);
		if (errors) {
			throw new Error(`'${buildStepsPath}' file schema validation error(s).\n${(<string[]>errors).join('\n\n')}`);
		}

		const buildConfigs: BuildConfigurations | undefined = getJsonObject(buildStepsPath);

		if (!buildConfigs) {
			throw new Error(`No build steps defined in file '${buildStepsPath}'.`);
		}

		const buildConfig: BuildConfiguration | undefined = buildConfigs!.configurations.filter(c => c.name == configName)[0];

		if (!buildConfig) {
			throw new Error(`Build configuration '${configName}' not found in file '${buildStepsPath}'.`);
		}

		let buildType: BuildType | undefined;

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

			buildType = buildTypes[0];
		}

		if (buildConfigs.params) addToDictionary(buildConfigs.params, extraParams); // add global params
		if (buildConfig.params) addToDictionary(buildConfig.params, extraParams); // add config params

		// run build steps
		for (const buildStep of buildConfig.buildSteps) {
			const stepParams = deepClone(extraParams);
			if (buildStep.params) addToDictionary(buildStep.params, stepParams); // add step params
			if (buildType && buildType.params) addToDictionary(buildType.params, stepParams); // add build type params
			// apply command line params last - they override any other params
			if (cliExtraParams) addToDictionary(cliExtraParams, stepParams);

			if (buildStep.filePattern && buildStep.fileList) {
				throw new Error(`Build step '${buildStep.name}' has both filePattern and fileList variables defined.`);
			}
			if (buildStep.filePattern) buildStep.filePattern = resolveVariablesTwice(buildStep.filePattern, stepParams);
			if (buildStep.fileList) buildStep.fileList = resolveVariablesTwice(buildStep.fileList, stepParams);

			try {
				const start = process.hrtime();
				const fileCount = await this.runBuildStep(workspaceRoot, buildStep, stepParams, maxTaskCount, forceRebuild, logOutput, logError);
				if (fileCount < 0) {
					// do nothing
				} else if (fileCount == 0) {
					logOutput(info(`${buildStep.name}: nothing to do`));
				} else {
					const elapsed = elapsedMills(start)/1000;
					logOutput(info(`${buildStep.name}: ${fileCount} file(s) processed in ${elapsed.toFixed(2)}s`));
				}
			} catch (e) {
				throw new Error(`An error occurred during '${buildStep.name}' step - terminating.\n${e.message}`);
			}
		}
	}

	// TODO: consider async file existence check
	async getVerifiedFilePaths(workspaceRoot: string, pattern: string): Promise<string[]> {
		const filePaths: string[] = await globAsync(pattern, { cwd: workspaceRoot });
		const verifiedFilePaths: string[] = [];

		const tasks: Promise<void>[] = filePaths.map(async (filePath) => {
			const fullInputFilePath = path.join(workspaceRoot, filePath);
			if (false === await checkFileExists(fullInputFilePath)) {
				return;
			} else {
				verifiedFilePaths.push(filePath);
			}
		});
		
		await Promise.all(tasks);
		return verifiedFilePaths;
	}

	// TODO: consider adding a flag to allow to continue on errors
	async runBuildStep(workspaceRoot: string, buildStep: BuildStep, extraParams: IStringDictionary<string | string[]>, maxTaskCount: number, forceRebuild: boolean, logOutput: (text: string) => void, logError: (text: string) => void): Promise<number> {
		if (buildStep.filePattern) {
			// run command for each file
			const filePaths = await this.getVerifiedFilePaths(workspaceRoot, buildStep.filePattern);
			const semaphore: AsyncSemaphore = new AsyncSemaphore(maxTaskCount);
			let filesProcessedCount = 0;

			const tasks: Promise<void>[] = filePaths.map(async (filePath) => {
				if (this._aborting) return; // TODO: use @esfx/async-canceltoken
				await semaphore.wait();
				
				try {
					const fullInputFilePath = path.join(workspaceRoot, filePath);
					const params = deepClone(extraParams);
					// run for each file
					const actionName: string = info(buildStep.name + ': ' + filePath);
					const fileDirectory: string = path.dirname(filePath);
					const fileExtension: string = path.extname(filePath);
					const fullFileName: string = path.basename(filePath);
					const fileName: string = fullFileName.substr(0, fullFileName.length - fileExtension.length);
					params['fileDirectory'] = fileDirectory == '.' ? '' : fileDirectory;
					params['filePath'] = filePath;
					params['fileName'] = fileName;
					params['fullFileName'] = fullFileName;
					params['fileExtension'] = fileExtension.length > 0 ? fileExtension.substr(1) : "";

					if (buildStep.outputFile) {
						let outputFilePath: string = resolveVariablesTwice(buildStep.outputFile, params);

						const inputFileDate: Date = await getFileMTime(fullInputFilePath);
						let fullOutputFilePath = outputFilePath;
						if (!path.isAbsolute(fullOutputFilePath)) fullOutputFilePath = path.join(workspaceRoot, outputFilePath);

						if (!forceRebuild && await checkFileExists(fullOutputFilePath) === true) {
							const outputFileStats = await getFileStatus(fullOutputFilePath);
							if (outputFileStats.mtime > inputFileDate) {
								// input file has not been modified since output file modified - skip this file build
								// TODO: add option to force build
								return;
							}
						}
						params['outputFile'] = outputFilePath;
						const outputFileDirectory = path.dirname(outputFilePath);
						await createOutputDirectory(workspaceRoot, outputFileDirectory);
					}

					if (buildStep.outputDirectory) {
						const outputDirectory = resolveVariablesTwice(buildStep.outputDirectory, params);
						params['outputDirectory'] = outputDirectory;
						await createOutputDirectory(workspaceRoot, outputDirectory);
					}

					let command: string = buildCommand(buildStep.command, params);
					const result = await this.execCommand(command, workspaceRoot, actionName, logOutput, logError);
					filesProcessedCount ++;
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
				return filesProcessedCount;
			} catch (e) {
				this._aborting = true;
				throw e;
			}
		} else {
			extraParams = deepClone(extraParams);

			if (buildStep.fileList) {
				const filePaths = await this.getVerifiedFilePaths(workspaceRoot, buildStep.fileList);
				const fileDirectories: string[] = [];
				const fileNames: string[] = [];
				const fullFileNames: string[] = [];
				const fileExtensions: string[] = [];

				filePaths.map(filePath => {
					const fileDirectory = path.dirname(filePath);
					fileDirectories.push(fileDirectory == '.' ? '' : fileDirectory);
					let fileExtension: string = path.extname(filePath);
					const fullFileName: string = path.basename(filePath);
					fileNames.push(fullFileName.substr(0, fullFileName.length - fileExtension.length));
					fullFileNames.push(fullFileName);
					fileExtensions.push(fileExtension.length > 0 ? fileExtension.substr(1) : "");
				});

				extraParams['fileDirectory'] = fileDirectories;
				extraParams['filePath'] = filePaths;
				extraParams['fileName'] = fileNames;
				extraParams['fullFileName'] = fullFileNames;
				extraParams['fileExtension'] = fileExtensions;
			}

			if (buildStep.outputDirectory) {
				const outputDirectory = resolveVariablesTwice(buildStep.outputDirectory, extraParams);
				extraParams['outputDirectory'] = outputDirectory;
				await createOutputDirectory(workspaceRoot, outputDirectory);
			}

			let command: string = buildCommand(buildStep.command, extraParams);
			const actionName = info(buildStep.name);
			const result = await this.execCommand(command, workspaceRoot, actionName, logOutput, logError);
			
			if (result && result.error) {
				throw result.error;
			} else {
				return -1;
			}
		}
	}

	/** fix/expand includePaths and forcedInclude - since they may contain '**' wildcards */
	async expandPaths(workspaceRoot: string, extraParams: IStringDictionary<string | string[]>, includePaths: string[]): Promise<string[]> {
		const expandedPaths: string[] = [];

		for (const p of includePaths) {
			let pattern = p.trim();
			pattern = resolveVariablesTwice(pattern, extraParams);

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

	_mutex: AsyncMutex = new AsyncMutex();

	async execCommand(commandLine: string, rootPath: string, actionName: string, logOutput: (line: string) => void, logError: (line: string) => void): Promise<ExecCmdResult | undefined> {
		let result: ExecCmdResult | undefined = undefined;
		let output: string = actionName;
		let error: string = '';

		try {
			result = await execCmd(commandLine, { cwd: rootPath });

			if (result) {
				if (output && result.stdout) output += '\n';
				output += result.stdout;
				output = output.trimRight();
				error += result.stderr;
				error = error.trimRight();
			}
		} catch (e) {
			error = 'Error while executing: ' + commandLine;
			result = e as ExecCmdResult;

			if (result) {
				if (output && result.stdout) output += '\n';
				output += result.stdout;
				output = output.trimRight();
			}
			// NOTE: do not log result.stderr in case of exception
			// - it is contained in the returned result and should be logged later
		} finally {
			await this._mutex.lock();

			try {
				if (output) logOutput(output);
				if (error) logError(error);
			} finally {
				this._mutex.unlock();
			}
		}

		return result;
	}
}
