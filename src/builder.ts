/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2019-2020 Tomasz Jastrzębski. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

'use strict';

import { BuildStepsFileSchema, PropertiesFileSchema } from "./consts";
import { GlobalConfiguration, BuildConfiguration, BuildType, CppParams, BuildStep, BuilderOptions, ParamsDictionary, ExpandPathsOption, CompilerType, Logger } from "./interfaces";
import { getJsonObject, ExecCmdResult, execCmd, getFileMTime, getFileStatus, elapsedMills, iColor, makeDirectory, dColor, escapeTemplateText, unescapeTemplateText, eColor, kColor, sColor } from "./utils";
import { getCppConfigParams, validateJsonFile, createOutputDirectory, expandTemplate, expandTemplates, expandMultivalues } from "./processor";
import { checkFileExists, ConfigurationJson, checkDirectoryExists, isArrayOfString, resolveVariables } from "./cpptools";
import { AsyncSemaphore } from "@esfx/async-semaphore";
import { CancelToken } from "@esfx/async-canceltoken";
import { AsyncMutex } from "@esfx/async-mutex";
import { deepClone } from "./vscode";
import * as path from 'path';
import * as fs from 'fs';
import { IncludesTrimmer } from "./trimmers";
import { PredefinedVariables as PV } from "./interfaces";
import uniq from 'lodash.uniq';
import { setPriority } from "os";

export class Builder {
	/** @returns [totalFilesProcessed, totalFilesSkipped, totalErrorsEncountered] */
	async runBuild(workspaceRoot: string, propertiesPath: string | undefined, buildStepsPath: string, configName: string, buildTypeName: string, cliParams: ParamsDictionary, options: BuilderOptions, logOutput: Logger, logError: Logger): Promise<[number, number, number]> {
		const workspaceRootFolderName = path.basename(workspaceRoot);
		const variables: ParamsDictionary[] = [];
		const cppVariables: ParamsDictionary = {};
		const globalVariables: ParamsDictionary = {};

		globalVariables[PV.workspaceRoot] = escapeTemplateText(workspaceRoot);
		globalVariables[PV.workspaceFolder] = escapeTemplateText(workspaceRoot);
		globalVariables[PV.workspaceRootFolderName] = escapeTemplateText(workspaceRootFolderName);
		globalVariables[PV.configName] = escapeTemplateText(configName);
		variables.push(globalVariables);

		if (buildTypeName) globalVariables[PV.buildTypeName] = buildTypeName;

		if (!configName) {
			throw new Error('Configuration name argument must be provided.');
		}

		if (options.maxTasks < 1) {
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

			// resolve 'includePath', 'forcedInclude' and 'defines' variables using cpptools resolver first
			// since special chars in variables from cpp properties are not escaped
			const additionalEnvironment: ParamsDictionary = {};
			additionalEnvironment[PV.workspaceRoot] = workspaceRoot;
			additionalEnvironment[PV.workspaceFolder] = workspaceRoot;
			additionalEnvironment[PV.workspaceRootFolderName] = workspaceRootFolderName;
			cppVariables[PV.includePath] = escapeTemplateText(resolveVariables(cppParams.includePath, additionalEnvironment));
			cppVariables[PV.forcedInclude] = escapeTemplateText(resolveVariables(cppParams.forcedInclude, additionalEnvironment));
			cppVariables[PV.defines] = escapeTemplateText(resolveVariables(cppParams.defines, additionalEnvironment));
		} else {
			// make sure 'includePath', 'forcedInclude' and 'defines' are always present, even not passed from properties file
			cppVariables[PV.includePath] = [];
			cppVariables[PV.forcedInclude] = [];
			cppVariables[PV.defines] = [];
		}

		variables.push(cppVariables);

		if (await checkFileExists(buildStepsPath) === false) {
			throw new Error(`Build steps file '${buildStepsPath}' not found.`);
		}

		let errors = validateJsonFile(buildStepsPath, BuildStepsFileSchema);
		if (errors) {
			throw new Error(`'${buildStepsPath}' file schema validation error(s).\n${(<string[]>errors).join('\n\n')}`);
		}

		const globalConfig: GlobalConfiguration | undefined = getJsonObject(buildStepsPath);

		if (!globalConfig) {
			throw new Error(`No build steps defined in file '${buildStepsPath}'.`);
		}

		const buildConfig: BuildConfiguration | undefined = globalConfig!.configurations.filter(c => c.name == configName)[0];

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

		// apply global variables
		if (globalConfig.params) variables.push(globalConfig.params);
		// apply config variables
		if (buildConfig.params) variables.push(buildConfig.params);
		// apply build type variables
		if (buildType?.params) variables.push(buildType.params);

		let totalFilesProcessed = 0;
		let totalFilesSkipped = 0;
		let totalErrorsEncountered = 0;

		// run build steps
		for (const buildStep of buildConfig.buildSteps) {
			if (!buildStep.params) buildStep.params = {};
			// apply step variables
			variables.push(buildStep.params);
			// TODO: check if any of the following step param is already set, throw error if so or resolve these variables ..
			if (buildStep.name) buildStep.params[PV.stepName] = buildStep.name;
			if (buildStep.filePattern) buildStep.params[PV.filePattern] = buildStep.filePattern;
			if (buildStep.fileList) buildStep.params[PV.fileList] = buildStep.fileList;
			if (buildStep.outputDirectory) buildStep.params[PV.outputDirectory] = buildStep.outputDirectory;
			if (buildStep.outputFile) buildStep.params[PV.outputFile] = buildStep.outputFile;

			// apply command line params last
			if (cliParams) variables.push(cliParams);

			if (buildStep.filePattern && buildStep.fileList) {
				throw new Error(`Build step '${buildStep.name}' has both filePattern and fileList variables defined.`);
			}

			try {
				const start = process.hrtime();
				const result = await this.runBuildStep(workspaceRoot, buildStep, variables, options, logOutput, logError);
				const filesProcessed = result[0];
				const filesSkipped = result[1];
				const errorsEncountered = result[2];

				totalFilesSkipped += filesSkipped;
				totalErrorsEncountered += errorsEncountered;
				const errorsColor = errorsEncountered > 0 ? eColor : kColor;
				if (filesProcessed == -1) {
					logOutput(iColor(`${buildStep.name}: step completed, ` + errorsColor(`${errorsEncountered} error(s) encountered.`)));
				} else {
					const elapsed = elapsedMills(start) / 1000;
					logOutput(iColor(`${buildStep.name}: build step completed in ${elapsed.toFixed(2)}s, ${filesProcessed} file(s) processed, ${filesSkipped} file(s) skipped, ` + errorsColor(`${errorsEncountered} error(s) encountered.`)));
					totalFilesProcessed += filesProcessed;
				}

				if (!options.continueOnError && errorsEncountered > 0) break;
			} catch (e) {
				throw new Error(`An error occurred during '${buildStep.name}' step - terminating.\n${e.message}`);
			}
		}

		return [totalFilesProcessed, totalFilesSkipped, totalErrorsEncountered];
	}

	/** @returns [filesProcessedCount, filesSkipped, errorsEncountered] */
	async runBuildStep(workspaceRoot: string, buildStep: BuildStep, variables: ParamsDictionary[], options: BuilderOptions, logOutput: Logger, logError: Logger): Promise<[number, number, number]> {
		const cancelSource = CancelToken.source();
		const stepVariableValues: Map<string, string[]> = new Map<string, string[]>();
		const stepVariableResolver = (name: string, expandOption: ExpandPathsOption) => { return this.resolveVariable(workspaceRoot, name, variables, expandOption, stepVariableValues); };

		// resolve 'includePaths'
		let stepIncludePaths = stepVariableResolver(PV.includePath, ExpandPathsOption.directoriesOnly);
		stepIncludePaths = expandMultivalues(workspaceRoot, stepIncludePaths, stepVariableResolver, ExpandPathsOption.directoriesOnly);

		let trimmer: IncludesTrimmer | undefined = undefined;
		let errorsEncountered = 0;
		let filesSkipped = 0;

		if ((buildStep.trimIncludePaths || options.trimIncludePaths) && isArrayOfString(stepIncludePaths)) {
			trimmer = new IncludesTrimmer(workspaceRoot);
			await trimmer.enlistFiles(stepIncludePaths);
		}

		if (buildStep.filePattern) {
			// run command for each file
			let filePaths = stepVariableResolver(PV.filePattern, ExpandPathsOption.filesOnly);
			filePaths = expandMultivalues(workspaceRoot, buildStep.filePattern, stepVariableResolver, ExpandPathsOption.filesOnly);

			const semaphore: AsyncSemaphore = new AsyncSemaphore(options.maxTasks);
			let filesProcessed = 0;

			const tasks: Promise<void>[] = filePaths.map(async (filePath) => {
				// run for each file
				if (cancelSource.token.signaled) return;
				await semaphore.wait();

				try {
					const fullInputFilePath = path.isAbsolute(filePath) ? filePath : path.join(workspaceRoot, filePath);
					if (!fullInputFilePath) throw new Error(`Incorrect file path: '${filePath}.'`);
					if (!await checkFileExists(fullInputFilePath)) throw new Error(`File '${filePath}' does not exist.`);

					const stepVariables = deepClone(variables); // copy variables before modifying since files may be processed in parallel
					const cmdVariables: ParamsDictionary = {};
					stepVariables.push(cmdVariables);

					const fileDirectory: string = path.dirname(filePath);
					const fileExtension: string = path.extname(filePath);
					const fullFileName: string = path.basename(filePath);
					const fileName: string = fullFileName.substr(0, fullFileName.length - fileExtension.length);
					// set file-specific command-level variables
					cmdVariables[PV.fileDirectory] = escapeTemplateText(fileDirectory == '.' ? '' : fileDirectory);
					cmdVariables[PV.filePath] = escapeTemplateText(filePath);
					cmdVariables[PV.fileName] = escapeTemplateText(fileName);
					cmdVariables[PV.fullFileName] = escapeTemplateText(fullFileName);
					cmdVariables[PV.fileExtension] = escapeTemplateText(fileExtension.length > 0 ? fileExtension.substr(1) : "");

					if (buildStep.outputFile) {
						const outputFilePath = this.resolveVariable(workspaceRoot, PV.outputFile, stepVariables, ExpandPathsOption.noExpand);
						if (isArrayOfString(outputFilePath)) throw new Error(`Template '${buildStep.outputFile}' resolves to multiple values.`);

						const inputFileDate: Date = await getFileMTime(fullInputFilePath);
						let fullOutputFilePath = outputFilePath;
						if (!path.isAbsolute(fullOutputFilePath)) fullOutputFilePath = path.join(workspaceRoot, outputFilePath);

						if (!options.forceRebuild && await checkFileExists(fullOutputFilePath) === true) {
							const outputFileStats = await getFileStatus(fullOutputFilePath);
							if (outputFileStats.mtime > inputFileDate) {
								// input file has not been modified since output file modified - skip this file build
								filesSkipped++;
								return;
							}
						}
						cmdVariables[PV.outputFile] = escapeTemplateText(outputFilePath);
						const outputFileDirectory = path.dirname(outputFilePath);
						await createOutputDirectory(workspaceRoot, outputFileDirectory);
					}
					
					if (cancelSource.token.signaled) return;

					if (buildStep.outputDirectory) {
						const outputDirectory = this.resolveVariable(workspaceRoot, PV.outputDirectory, stepVariables, ExpandPathsOption.directoriesOnly);
						if (isArrayOfString(outputDirectory)) throw new Error(`'${PV.outputDirectory}' variable has multiple values.`);
						cmdVariables[PV.outputDirectory] = outputDirectory;
						await createOutputDirectory(workspaceRoot, outputDirectory);
					}

					// create new resolver with new cache
					const cmdVariableValues: Map<string, string[]> = new Map<string, string[]>();
					const cmdVariableResolver = (name: string, expandOption: ExpandPathsOption) => { return this.resolveVariable(workspaceRoot, name, stepVariables, expandOption, cmdVariableValues); };

					// resolve 'forcedInclude'
					let forcedInclude = cmdVariableResolver(PV.forcedInclude, ExpandPathsOption.filesOnly);
					forcedInclude = expandMultivalues(workspaceRoot, forcedInclude, cmdVariableResolver, ExpandPathsOption.filesOnly);
					cmdVariables[PV.forcedInclude] = forcedInclude;
					cmdVariableValues.set(PV.forcedInclude, forcedInclude); // prevent resolving forcedInclude again

					// resolve 'includePaths'
					let cmdIncludePaths = cmdVariableResolver(PV.includePath, ExpandPathsOption.directoriesOnly);
					cmdIncludePaths = expandMultivalues(workspaceRoot, cmdIncludePaths, cmdVariableResolver, ExpandPathsOption.directoriesOnly);
					
					if (cancelSource.token.signaled) return;

					if (trimmer) {
						// includePaths trimming is enabled
						// enlist additional files from path resolved on command level
						await trimmer.enlistFiles(cmdIncludePaths); // enlist files from additional paths
						forcedInclude.unshift(filePath); // add the file being processed at index 0
						forcedInclude.forEach((e, i, a) => { a[i] = unescapeTemplateText(e); });
						// get includePaths for the file being processed and any forcedInclude files
						cmdIncludePaths = await this.getIncludes(workspaceRoot, trimmer, forcedInclude);
						cmdIncludePaths.forEach((e, i, a) => { a[i] = escapeTemplateText(e); });
						forcedInclude.shift(); // remove file being processed
						forcedInclude.forEach((e, i, a) => { a[i] = escapeTemplateText(e); });
					}

					cmdVariables[PV.includePath] = cmdIncludePaths;
					cmdVariableValues.set(PV.includePath, cmdIncludePaths); // prevent resolving includePaths again

					const command = expandTemplate(workspaceRoot, buildStep.command, cmdVariableResolver);
					const actionName = buildStep.name + ': ' + filePath;
					if (cancelSource.token.signaled) return;
					const result = await this.execCommand(workspaceRoot, command, actionName, logOutput, logError, cancelSource.token, options.debug);
					if (cancelSource.token.signaled) return;
					
					if (result) {
						if (result.error) {
							errorsEncountered++;
							if (!options.continueOnError) cancelSource.cancel();
						} else {
							filesProcessed++;
						}
					}
				} catch (e) {
					cancelSource.cancel();
					throw e;
				} finally {
					semaphore.release();
				}
			});

			try {
				await Promise.all(tasks);
				return [filesProcessed, filesSkipped, errorsEncountered];
			} catch (e) {
				cancelSource.cancel();
				throw e;
			}
		} else {
			// run build step just once
			const stepVariables = deepClone(variables);
			const cmdVariables: ParamsDictionary = {};
			stepVariables.push(cmdVariables);

			if (buildStep.fileList) {
				let cmdFilePaths = stepVariableResolver(PV.fileList, ExpandPathsOption.filesOnly);
				cmdFilePaths = expandMultivalues(workspaceRoot, cmdFilePaths, stepVariableResolver, ExpandPathsOption.filesOnly);
				const fileDirectories: string[] = [];
				const fileNames: string[] = [];
				const fullFileNames: string[] = [];
				const fileExtensions: string[] = [];

				cmdFilePaths.forEach(filePath => {
					const fileDirectory = path.dirname(filePath);
					fileDirectories.push(fileDirectory == '.' ? '' : fileDirectory);
					let fileExtension: string = path.extname(filePath);
					const fullFileName: string = path.basename(filePath);
					fileNames.push(fullFileName.substr(0, fullFileName.length - fileExtension.length));
					fullFileNames.push(fullFileName);
					fileExtensions.push(fileExtension.length > 0 ? fileExtension.substr(1) : "");
				});
				// set fileList-specific command-level variables
				cmdVariables[PV.fileDirectory] = escapeTemplateText(fileDirectories);
				cmdVariables[PV.filePath] = escapeTemplateText(cmdFilePaths);
				cmdVariables[PV.fileName] = escapeTemplateText(fileNames);
				cmdVariables[PV.fullFileName] = escapeTemplateText(fullFileNames);
				cmdVariables[PV.fileExtension] = escapeTemplateText(fileExtensions);
			}

			// create new resolver with new cache
			const cmdVariableResolver = (name: string, expandOption: ExpandPathsOption) => { return this.resolveVariable(workspaceRoot, name, stepVariables, expandOption, cmdVariableValues); };
			const cmdVariableValues: Map<string, string[]> = new Map<string, string[]>();

			// resolve 'forcedInclude'
			let forcedInclude = cmdVariableResolver(PV.forcedInclude, ExpandPathsOption.filesOnly);
			forcedInclude = expandMultivalues(workspaceRoot, forcedInclude, cmdVariableResolver, ExpandPathsOption.filesOnly);
			cmdVariables[PV.forcedInclude] = forcedInclude;
			cmdVariableValues.set(PV.forcedInclude, forcedInclude); // prevent resolving forcedInclude again

			// resolve 'includePaths'
			let cmdIncludePaths = cmdVariableResolver(PV.includePath, ExpandPathsOption.directoriesOnly);
			cmdIncludePaths = expandMultivalues(workspaceRoot, cmdIncludePaths, cmdVariableResolver, ExpandPathsOption.directoriesOnly);
			cmdVariables[PV.includePath] = cmdIncludePaths;
			cmdVariableValues.set(PV.includePath, cmdIncludePaths); // prevent resolving includePaths again

			if (buildStep.outputDirectory) {
				const outputDirectory = cmdVariableResolver(PV.outputDirectory, ExpandPathsOption.directoriesOnly);
				cmdVariables[PV.outputDirectory] = outputDirectory;
				if (isArrayOfString(outputDirectory)) throw new Error(`'${PV.outputDirectory}' variable has multiple values.`);
				await createOutputDirectory(workspaceRoot, outputDirectory);
			}

			cmdVariables[PV.command] = buildStep.command;

			let commands = cmdVariableResolver(PV.command, ExpandPathsOption.expandAll);
			//commands = expandMultivalues(workspaceRoot, commands, cmdVariableResolver, ExpandPathsOption.filesOnly); / DO NOT!
			if (!isArrayOfString(commands)) commands = [commands];
			commands = unescapeTemplateText(commands);

			// TODO: consider trimming paths as well
			const actionName = buildStep.name;
			let errorsEncountered = 0;

			for (const command of commands) {
				const result = await this.execCommand(workspaceRoot, command, actionName, logOutput, logError, cancelSource.token, options.debug);
				if (result && result.error) {
					errorsEncountered++;
					if (!options.continueOnError) {
						cancelSource.cancel();
						return [-1, 0, errorsEncountered]; // [filesProcessedCount, filesSkipped, errorsEncountered]
					}
				}
			}

			return [-1, 0, errorsEncountered]; // [filesProcessedCount, filesSkipped, errorsEncountered]
		}
	}

	/*
	resolveVariables(workspaceRoot: string, variables: ParamsDictionary[], expandOption: ExpandPathsOption = ExpandPathsOption.expandAll): ParamsDictionary {
		const variableNames: Set<string> = new Set<string>();
		const newVariables: ParamsDictionary = {};
		const resolvedValues = new Map<string, string | string[]>();

		variables.forEach(dictionary => {
			Object.keys(dictionary).forEach(name => {
				if (!variableNames.has(name)) variableNames.add(name);
			});
		});
		variableNames.forEach(name => {
			const value = this.resolveVariable(workspaceRoot, name, variables, expandOption, resolvedValues);
			newVariables[name] = value;
		});
		return newVariables;
	}
	*/

	resolveVariable(workspaceRoot: string, variableName: string, variables: ParamsDictionary[], expandOption: ExpandPathsOption, resolvedValues?: Map<string, string | string[]>): string[] | string {
		if (!resolvedValues) resolvedValues = new Map<string, string | string[]>();
		let currentValue = resolvedValues.get(variableName);
		if (currentValue !== undefined) return currentValue; // value has been already resolved

		if (variableName.startsWith('~')) {
			const home = (process.platform === 'win32') ? process.env.USERPROFILE : process.env.HOME;
			currentValue = path.join(home || '', variableName.substr(1));
			currentValue = escapeTemplateText(currentValue);
		} else if (variableName.startsWith('env:')) {
			const envNameVariable = variableName.substr('env:'.length);
			currentValue = process.env[envNameVariable];
			if (currentValue) currentValue = escapeTemplateText(currentValue);
		} else {
			variables.forEach(dictionary => {
				let newValue = dictionary[variableName];
				if (newValue === undefined) return; // variable not found at this level

				const resolver = (name: string) => {
					if (name == variableName) {
						if (currentValue) {
							return currentValue;
						} else {
							throw Error(`Unable to resolve variable '${variableName}'.`);
						}
					}
					let value = resolvedValues!.get(variableName);
					if (value !== undefined) return value;
					value = this.resolveVariable(workspaceRoot, name, variables, expandOption, resolvedValues);
					return value;
				};

				if (isArrayOfString(newValue)) {
					let newValues: string[] = [];
					newValue.forEach(value => {
						const values = expandTemplates(workspaceRoot, value, resolver, true, expandOption);
						if (isArrayOfString(values)) {
							newValues = uniq([...newValues, ...values]);
						} else {
							newValues = uniq([...newValues, values]);
						}
					});
					newValue = newValues;
				} else {
					newValue = expandTemplates(workspaceRoot, newValue, resolver, true, expandOption);
				}
				currentValue = newValue;
			});
		}

		if (currentValue === undefined) {
			throw new Error(`Unable to resolve variable '${variableName}'.`);
		}

		resolvedValues.set(variableName, currentValue);
		return currentValue;
	}

	async getIncludes(workspaceRoot: string, trimmer: IncludesTrimmer, filePaths: string[]): Promise<string[]> {
		let includes: string[] = [];
		for (const filePath of filePaths) {
			const fullFilePath = path.isAbsolute(filePath) ? filePath : path.join(workspaceRoot, filePath);
			const fullFileDirectory = path.dirname(fullFilePath);
			const fullFileName = path.basename(fullFilePath);
			let moreIncludes = await trimmer.getIncludes(fullFileDirectory, fullFileName);
			moreIncludes = moreIncludes ?? [];
			includes = uniq([...includes, ...moreIncludes]);
		}
		return includes;
	}

	private readonly _mutex: AsyncMutex = new AsyncMutex();

	async execCommand(rootPath: string, commandLine: string, actionName: string, logOutput: Logger, logError: Logger, token: CancelToken, isDebug: boolean): Promise<ExecCmdResult | undefined> {
		let result: ExecCmdResult | undefined = undefined;
		let output: string | undefined;
		let error: string | undefined;

		try {
			result = await execCmd(commandLine, { cwd: rootPath }, token);
		} catch (e) {
			result = e as ExecCmdResult;
		} finally {
			if (result) {
				output = result.stdout;
				output = output?.trimRight();
				if (result.error?.message) {
					error = result.error?.message;
				} else {
					error = result?.stderr;
				}
				error = error?.trimRight();
			}
			if (!token.signaled) {
				await this._mutex.lock();

				try {
					logOutput(iColor(actionName));
					if (isDebug) logOutput(dColor(commandLine));
					if (output) logOutput(output);
					if (error) logError(eColor(error));
				} finally {
					this._mutex.unlock();
				}
			}
		}

		return result;
	}
}

/**
 * @configParams e.g. use to define includePath, defines & forcedInclude variables
 */
export async function setSampleBuildConfig(buildStepsPath: string, configName: string, compilerType: CompilerType, configParams?: ParamsDictionary) {
	let command: string;
	const bSteps: BuildStep[] = [];
	const bTypes: BuildType[] = [];
	const problemMatchers: string[] = [];

	switch (compilerType) {
		case 'gcc-x64':
			bTypes.push({ name: 'debug', params: { buildTypeParams: '-O0 -g', defines: ["$${defines}", "$${debugDefines}"] } });
			bTypes.push({ name: 'release', params: { buildTypeParams: '-O2 -g0' } });
			command = 'g++ -c -std=c++17 ${buildTypeParams} (-I[$${includePath}]) (-D$${defines}) (-include [$${forcedInclude}]) [${filePath}] -o [${outputFile}]';
			bSteps.push({ name: 'C++ Compile Sample Step', filePattern: '**/*.cpp', outputFile: "${buildOutput}/${fileDirectory}/${fileName}.o", command: command, trimIncludePaths: true });
			command = 'g++ [$${filePath}] -o [${buildOutput}/main.exe]';
			bSteps.push({ name: 'C++ Link Sample Step', fileList: '${buildOutput}/**/*.o', command: command });
			problemMatchers.push('$gcc');
			break;
		case 'clang-x64':
			bTypes.push({ name: 'debug', params: { buildTypeParams: '-O0 -g', defines: ["$${defines}", "$${debugDefines}"] } });
			bTypes.push({ name: 'release', params: { buildTypeParams: '-O2 -g0' } });
			command = 'clang++ -c -std=c++17 ${buildTypeParams} (/I[$${libPaths}]) (-I[$${includePath}]) (-D$${defines}) (-include [$${forcedInclude}]) [${filePath}] -o [${outputFile}]';
			bSteps.push({ name: 'C++ Compile Sample Step', filePattern: '**/*.cpp', outputFile: "${buildOutput}/${fileDirectory}/${fileName}.o", command: command, trimIncludePaths: true });
			command = 'clang++ -c [$${filePath}] -o [${buildOutput}/main.bin]';
			bSteps.push({ name: 'C++ Link Sample Step', fileList: '${buildOutput}/**/*.o', command: command });
			problemMatchers.push('$gcc');
			break;
		case 'msvc-x64':
			if (!configParams) configParams = {};
			configParams['scopeCppSDK'] = 'C:/Program Files \\(x86\\)/Microsoft Visual Studio/2019/Community/SDK/ScopeCppSDK';
			const libPaths = getParamsArray(configParams, 'libPaths');
			libPaths.push('${scopeCppSDK}/VC/include');
			libPaths.push('${scopeCppSDK}/SDK/include/ucrt');
			const linkLibPaths = getParamsArray(configParams, 'linkLibPaths');
			linkLibPaths.push('${scopeCppSDK}/VC/lib');
			linkLibPaths.push('${scopeCppSDK}/SDK/lib');
			bTypes.push({ name: 'debug', params: { buildTypeParams: '/MDd /Od /RTCsu /Zi /Fd[${buildOutput}/main.pdb]', linkTypeParams: '/DEBUG', defines: ["$${defines}", "$${debugDefines}"] } });
			bTypes.push({ name: 'release', params: { buildTypeParams: '/MD /Ox', linkTypeParams: '' } });
			command = '[${scopeCppSDK}/VC/bin/cl.exe] ${buildTypeParams} /nologo /EHs /GR /GF /W3 /EHsc /FS /c (/I[$${libPaths}]) (/I[$${includePath}]) (/D\"$${defines}\") (/FI[$${forcedInclude}]) [${filePath}] /Fo[${outputFile}]';
			bSteps.push({ name: 'C++ Compile Sample Step', filePattern: '**/*.cpp', outputFile: "${buildOutput}/${fileDirectory}/${fileName}.o", command: command });
			command = '[${scopeCppSDK}/VC/bin/link.exe] /NOLOGO ${linkTypeParams} [$${filePath}] /OUT:[${buildOutput}/main.exe] (/LIBPATH:[$${linkLibPaths}])';
			bSteps.push({ name: 'C++ Link Sample Step', fileList: '${buildOutput}/**/*.o', command: command });
			problemMatchers.push('$msCompile');
			break;
		default:
			throw new Error(`Unsupported compiler type: ${compilerType}.`);
	}

	const bConfig: BuildConfiguration = { name: configName, params: configParams, buildTypes: bTypes, buildSteps: bSteps, problemMatchers: problemMatchers };
	const dir = path.dirname(buildStepsPath);

	if (!await checkDirectoryExists(dir)) {
		try {
			await makeDirectory(dir, { recursive: true });
		} catch (e) {
			throw new Error(`Error creating ${dir} folder.\n${e.message}`);
		}
	}

	let configs: GlobalConfiguration | undefined;

	if (await checkFileExists(buildStepsPath)) {
		// file already exists
		configs = getJsonObject(buildStepsPath);
		if (!configs) {
			throw new Error('Unable to parse build configuration file.');
		}
		const bConfigs: BuildConfiguration[] = configs.configurations;
		const i = bConfigs.findIndex(c => c.name == configName);

		if (i != -1) {
			// configuration in file already exists
			bConfigs[i] = bConfig; // swap existing configuration
		} else {
			bConfigs.push(bConfig); // add new configuration
		}
	} else {
		// file does not yet exist
		const bConfigs: BuildConfiguration[] = [];
		configs = { version: 1, params: {}, configurations: bConfigs };
		bConfigs.push(bConfig);
	}

	if (!configs.params) configs.params = {};
	const gParams = configs.params;
	gParams['buildDir'] = 'build';
	gParams['buildOutput'] = '${buildDir}/${configName}/${buildTypeName}';
	gParams['defines'] = ["$${defines}", "UNICODE", "_UNICODE"];
	gParams['debugDefines'] = ["_DEBUG", "DEBUG"];
	gParams['includePath'] = ["$${includePath}", "${workspaceFolder}/**"];

	const text = JSON.stringify(configs, null, '\t');

	try {
		fs.writeFileSync(buildStepsPath, text);
	} catch (e) {
		throw new Error(`Error writing ${buildStepsPath} file.\n${e.message}`);
	}
}

/** Gets array of values, creates value if it does not exist or converts from string to string[] if required */
function getParamsArray(params: ParamsDictionary, name: string): string[] {
	const values = params[name];
	let array: string[];
	if (values) {
		if (isArrayOfString(values)) {
			return values;
		} else {
			array = [values];
			params[name] = array;
			return array;
		}
	} else {
		array = [];
		params[name] = array;
		return array;
	}
}