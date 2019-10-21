/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2019 Tomasz Jastrzębski. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

'use strict';

import * as path from 'path';
import { getBuildInfos, validateJsonFile } from './processor';
import { getJsonObject } from './utils';
import ajv from 'ajv';

export { BuildConfigurations, BuildConfiguration, BuildType, BuildStep, BuildInfo, IStringDictionary } from "./interfaces";
export { resolveVariables, checkFileExists, checkDirectoryExists, readDirectory, ConfigurationJson, Configuration, Browse, KnownCompiler } from "./cpptools";
export { getJsonObject } from "./utils";
export { getBuildInfos } from "./processor";
export { Builder } from "./builder";

export const ToolVersion: string = '1.1.0';
export const ToolName: string = 'cppbuild';
export const PropertiesFolder: string = '.vscode';
export const PropertiesFile: string = 'c_cpp_properties.json';
export const BuildStepsFile: string = 'c_cpp_build.json';
export const BuildStepsFileSchema: string = 'c_cpp_build.schema.json';
export const PropertiesFileSchema: string = 'c_cpp_properties.schema.json';

/* test only
let errors = validateJsonFile('c_cpp_build.json', BuildStepsFileSchema);
if (errors) {
	console.log(`XX file schema validation error(s).\n${(<string[]>errors).join('\n\n')}`);
} else { console.log('no errors'); }

errors = validateJsonFile('c_cpp_properties.json', PropertiesFileSchema);
if (errors) {
	console.log(`XX file schema validation error(s).\n${(<string[]>errors).join('\n\n')}`);
} else { console.log('no errors'); }

*/

/* test only
const rootPath: string = process.cwd();
const propertiesPath: string = path.join(rootPath, PropertiesFile);
const buildStepsPath: string = path.join(rootPath, BuildStepsFile);
(async () => {
	try {
		const infos = await getBuildInfos(propertiesPath, buildStepsPath);
		infos.forEach(i => {
			console.info(i.name);
		});
	} catch (e) {
		const error = e as Error;
		console.error(error.message);
	}
	console.log('done');
})();
*/