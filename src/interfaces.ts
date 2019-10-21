/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2019 Tomasz Jastrzębski. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

'use strict';

export interface IStringDictionary<V> {
	[name: string]: V;
}

export interface BuildConfigurations {
	version: number;
	configurations: BuildConfiguration[];
	params?: { [key: string]: string | string[] };
}

export interface BuildConfiguration {
	name: string;
	problemMatchers?: string[];
	buildTypes?: BuildType[];
	buildSteps: BuildStep[];
	params?: { [key: string]: string | string[] };
}

export interface BuildType {
	name: string;
	params?: { [key: string]: string | string[] };
}

export interface BuildStep {
	name: string;
	filePattern?: string;
	fileList?: string;
	outputDirectory?: string;
	command: string;
	params?: { [key: string]: string | string[] };
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
