/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2019 Tomasz Jastrzębski. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

'use strict';

import * as path from 'path';
import { AsyncMutex } from "@esfx/async-mutex";
import { Configuration, ConfigurationJson, resolveVariables, checkDirectoryExists, checkFileExists, isArrayOfString } from './cpptools';
import { replaceAt, makeDirectory, getJsonObject, listObject } from './utils';
import { CppParams, IStringDictionary, BuildConfigurations, BuildInfo } from './interfaces';
import ajv from 'ajv';
import { BuildStepsFileSchema, PropertiesFileSchema } from './main';

export function getCppConfigParams(configurationJson: ConfigurationJson, configName: string): CppParams | undefined {
	const configuration: Configuration | undefined = configurationJson!.configurations.filter((c) => c.name == configName)[0];
	if (!configuration) return undefined;

	const params = { forcedInclude: configuration.forcedInclude, includePath: configuration.includePath, defines: configuration.defines };
	return params;
}

const _mutex: AsyncMutex = new AsyncMutex();

export async function createOutputDirectory(rootPath: string, outputDirectoryPath: string) {
	// TODO: remove double \\ from path in case variable resolved to empty string
	if (false === path.isAbsolute(outputDirectoryPath)) outputDirectoryPath = path.join(rootPath, outputDirectoryPath);
	if (true === await checkDirectoryExists(outputDirectoryPath)) return outputDirectoryPath;
	const lk = await _mutex.lock(); // to prevent two threads creating the same directory
	try {
		if (false === await checkDirectoryExists(outputDirectoryPath)) { // check again!
			await makeDirectory(outputDirectoryPath, { recursive: true });
		}
	} finally {
		lk.unlock();
	}
}

function getTemplateReplacements(template: string, extraParams: IStringDictionary<string | string[]>): string[] | undefined {
	const paramString: RegExpMatchArray | null = template.match(/\$\$\{.*?\}/);
	const replacements: string[] = [];

	if (!paramString || paramString.length != 1) {
		// no params or multiply params found within ()
		return undefined;
	}

	const paramStr: string = paramString[0];
	const paramStrIdx: number | undefined = paramString.index;
	const paramName: string = removePrefixAndSuffix(paramStr, '$${', '}');
	const values: string | string[] = extraParams[paramName];

	if (!values) {
		throw new Error(`Variable '${paramStr}' is undefined.`);
	}

	if (isArrayOfString(values)) {
		// multi-value
		values.forEach(element => {
			replacements.push(replaceAt(template, paramStrIdx!, paramStr.length, element));
		});
	} else {
		// single value
		replacements.push(replaceAt(template, paramStrIdx!, paramStr.length, values));
	}

	return replacements;
}

function formatPath(pathString: string): string {
	pathString = path.normalize(pathString);
	pathString = pathString.trim();
	pathString = pathString.replace(/\\/g, '/');

	if (pathString.indexOf(' ') != -1) {
		// TODO: check for single quotes as well?
		if (pathString.substr(0, 1) != '\"' && pathString.substr(pathString.length - 1, 1) != '\"') {
			// add double quotes
			return "\"" + pathString + "\"";
		}
	}

	return pathString;
}

function removePrefixAndSuffix(text: string, prefix: string, suffix: string): string {
	text = text.substr(prefix.length, text.length - prefix.length - suffix.length);
	return text;
}

export function buildCommand(template: string, extraParams: IStringDictionary<string | string[]>): string {
	// 1. expand sub-templates containing multi-value variables: ($${name})
	let command: string = template.replace(/\(.*?\)/g, (match) => {
		const subTemplate = removePrefixAndSuffix(match, '(', ')');
		const replacements = getTemplateReplacements(subTemplate, extraParams);

		if (!replacements) {
			throw new Error(`'${match}' sub-template does not contain exactly one multi-value variable.`);
		}

		return replacements.join(' ');
	});

	// 2. expand sub-templates containing multi-value variables: [$${name}]
	command = command.replace(/\[.*?\]/g, (match) => {
		const subTemplate = removePrefixAndSuffix(match, '[', ']');
		const replacements = getTemplateReplacements(subTemplate, extraParams);
		if (!replacements) return match;
		replacements.forEach((value: string, index: number) => {
			replacements[index] = formatPath(value);
		});
		return replacements.join(' ');
	});

	// 3. expand multi-value variables $${name}
	command = command.replace(/\$\$\{.*?\}/g, (match) => {
		const paramName = removePrefixAndSuffix(match, '$${', '}');
		const values: string | string[] = extraParams[paramName];

		if (isArrayOfString(values)) {
			// multi-value
			return values.join(' ');
		} else {
			// single value
			return values;
		}
	});

	// 4. resolve variable names: ${name}
	command = resolveVariables(command, extraParams);
	command = resolveVariables(command, extraParams);

	// 5. replace [path] with OS specific path separators and add quotes if path contains whitespace
	command = command.replace(/\[.*?\]/g, (match) => {
		const subTemplate = removePrefixAndSuffix(match, '[', ']');
		return formatPath(subTemplate);
	});

	return command;
}

/**
 * Function returns build information, each with the list of build types, e.g. DEBUG or RELEASE.
 * @param propertiesPath path to C/C++ properties file, typically .vscode/c_cpp_properties.json
 * @param buildStepsPath path to build file, typically .vscode/c_cpp_build.json
 */
export async function getBuildInfos(buildStepsPath: string, propertiesPath?: string): Promise<BuildInfo[]> {
	const configs: BuildInfo[] = [];

	if (false === await checkFileExists(buildStepsPath)) {
		throw new Error(`'${buildStepsPath}' file not found.`);
	}

	let configurationJson: ConfigurationJson | undefined;

	if (propertiesPath) {
		if (false === await checkFileExists(propertiesPath)) {
			throw new Error(`'${propertiesPath}' file not found.`);
		}

		const errors = validateJsonFile(propertiesPath, PropertiesFileSchema);

		if (errors) {
			throw new Error(`'${propertiesPath}' file schema validation error(s).\n${(<string[]>errors).join('\n\n')}`);
		}

		configurationJson = getJsonObject(propertiesPath);

		if (!configurationJson) {
			throw new Error(`'${propertiesPath}' file read problem.`);
		}

		if (configurationJson.version != 4) {
			throw new Error(`Unsupported '${propertiesPath}' config file version`);
		}
	}

	const buildConfigs: BuildConfigurations | undefined = getJsonObject(buildStepsPath);

	if (!buildConfigs) {
		throw new Error(`'${buildStepsPath}' file read problem.`);
	}

	let errors = validateJsonFile(buildStepsPath, BuildStepsFileSchema);
	if (errors) {
		throw new Error(`'${buildStepsPath}' file schema validation error(s).\n${(<string[]>errors).join('\n\n')}`);
	}

	// find matching configs in config and build files
	buildConfigs.configurations.forEach(c => {
		if (configurationJson) {
			const matchingConfigs = configurationJson.configurations.filter(b => b.name == c.name);

			if (matchingConfigs.length == 0) {
				return; // no match found
			} else if (matchingConfigs.length > 1) {
				throw new Error(`Build config '${c.name}' is defined more than once.`);
			}
		}

		const types: string[] = [];

		if (c.buildTypes) {
			c.buildTypes.forEach(t => {
				if (types.indexOf(t.name) !== -1) {
					throw new Error(`Build type '${t.name}' is defined more than once for config '${c.name}'.`);
				}
				types.push(t.name);
			});
		}
		configs.push({ name: c.name, buildTypes: types, problemMatchers: c.problemMatchers });
	});

	return configs;
}

/**
 * @returns returns validation errors or FALSE if validation passed
 */
export function validateJsonFile(jsonFile: string, schemaFile: string): string[] | boolean {
	// TODO: standardize return value
	const a = new ajv({ allErrors: true, schemaId: "auto" }); // options can be passed, e.g. {allErrors: true}
	const meta4: any = require('ajv/lib/refs/json-schema-draft-04.json');
	a.addMetaSchema(meta4);
	const schema: any = require(path.join('../', schemaFile));
	const validate = a.compile(schema);
	const data: any = getJsonObject(jsonFile);
	const valid = validate(data);

	if (valid) return false;

	const errors: string[] = [];

	validate.errors!.forEach(error => {
		let text = error.dataPath;
		text += ' ';
		text += error.message;
		text += '\n';
		text += listObject(error.params).join(', ');
		errors.push(text);
	});

	return errors;
}
