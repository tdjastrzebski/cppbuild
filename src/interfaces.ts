/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2019-2020 Tomasz Jastrzębski. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

'use strict';

export interface ParamsDictionary extends IStringDictionary<string | string[]> { }
export type VariableResolver = (name: string, expandOption: ExpandPathsOption) => string | string[];
export type Logger = (Text: string) => void;

export interface IStringDictionary<V> {
	[name: string]: V;
}

export interface GlobalConfiguration {
	version: number;
	configurations: BuildConfiguration[];
	params?: ParamsDictionary;
}

export interface BuildConfiguration {
	name: string;
	problemMatchers?: string[];
	buildTypes?: BuildType[];
	buildSteps: BuildStep[];
	params?: ParamsDictionary;
}

export interface BuildType {
	name: string;
	params?: ParamsDictionary;
}

export interface BuildStep {
	name: string;
	filePattern?: string | string[];
	fileList?: string | string[];
	outputDirectory?: string;
	outputFile?: string;
	command: string;
	params?: ParamsDictionary;
	trimIncludePaths?: boolean;
}

export interface BuildInfo {
	name: string;
	buildTypes?: string[];
	problemMatchers?: string[];
}

export interface CppParams {
	forcedInclude?: string[];
	includePath?: string[];
	defines?: string[];
}

export interface BuilderOptions {
	maxTasks: number;
	forceRebuild: boolean;
	debug: boolean;
	trimIncludePaths: boolean;
	continueOnError: boolean;
}

export enum PredefinedVariables {
	stepName = 'stepName',
	fileList = 'fileList',
	fileDirectory = 'fileDirectory',
	filePath = 'filePath',
	filePattern = 'filePattern',
	fileName = 'fileName',
	fullFileName = 'fullFileName',
	fileExtension = 'fileExtension',
	includePath = 'includePath',
	forcedInclude = 'forcedInclude',
	defines = 'defines',
	buildTypeName = 'buildTypeName',
	workspaceRoot = 'workspaceRoot',
	workspaceFolder = 'workspaceFolder',
	workspaceRootFolderName = 'workspaceRootFolderName',
	configName = 'configName',
	outputFile = 'outputFile',
	outputDirectory = 'outputDirectory',
	trimIncludePaths = 'trimIncludePaths'
}

export enum ExpandPathsOption { filesOnly, directoriesOnly, noExpand, expandAll }

export enum CompilerType { gcc = 'gcc-x64', clang = 'clang-x64', msvc = 'msvc-x64' }