/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2019-2020 Tomasz Jastrzębski. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

'use strict';

import { Configuration, ConfigurationJson, checkDirectoryExists, checkFileExists, isArrayOfString } from './cpptools';
import { replaceAt, makeDirectory, getJsonObject, listObject, matchRecursive, replaceRecursive, unescapeTemplateText, escapeTemplateText, expandGlob, IsMochaRunning, normalizePath } from './utils';
import { CppParams, GlobalConfiguration, BuildInfo, ExpandPathsOption, VariableResolver } from './interfaces';
import { BuildStepsFileSchema, PropertiesFileSchema } from './consts';
import { hasMagic } from "glob";
import { AsyncMutex } from "@esfx/async-mutex";
import { deepClone } from './vscode';
import * as path from 'path';
import ajv from 'ajv';
import uniq from 'lodash.uniq';

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

function joint(replacements: string | string[], format?: (text: string) => string): string {
	if (isArrayOfString(replacements)) {
		if (format) {
			replacements.forEach((value: string, index: number) => {
				replacements[index] = format(value);
			});
		}
		const replacement = replacements.join(' ');
		return replacement;
	} else {
		const replacement = format ? format(replacements) : replacements;
		return replacement;
	}
}

/** builds interim list of values */
function ss(values: string | string[], format?: (text: string) => string): string {
	if (format) {
		if (isArrayOfString(values)) {
			const temp: string[] = [];
			values.forEach(value => {
				temp.push(format(value));
			});
			values = temp;
		} else {
			values = format(values);
		}
	}

	values = '$${' + variableListJoin(values) + '}';
	return values;
}

/** expands template string to string by applying params and unescaping */
export function expandTemplate(workspaceRoot: string, template: string, variableResolver: VariableResolver): string {
	const replacements = expandTemplates(workspaceRoot, template, variableResolver, false, ExpandPathsOption.expandAll);
	let replacement = joint(replacements);
	replacement = unescapeTemplateText(replacement);
	return replacement;
}

export function expandTemplates(workspaceRoot: string, template: string, variableResolver: VariableResolver, inSubtemplate: boolean = false, expandOption: ExpandPathsOption = ExpandPathsOption.expandAll): string | string[] {
	// 1. expand sub-templates: ()
	template = replaceRecursive(template, '\\(', '\\)', (match) => {
		let t = template;
		const replacements = expandTemplates(workspaceRoot, match.innerText, variableResolver, true, expandOption);
		const replacement = joint(replacements);
		return replacement;
	}, 'g', '\\');

	// 2. expand path sub-templates: []
	template = replaceRecursive(template, '\\[', '\\]', (match) => {
		let t = template;
		const replacements = expandTemplates(workspaceRoot, match.innerText, variableResolver, true, expandOption);

		if (inSubtemplate && isArrayOfString(replacements)) {
			// return multi-value param
			const replacement = ss(replacements, formatPath);
			return replacement;
		} else {
			// return multi-value string
			const replacement = joint(replacements, formatPath);
			return replacement;
		}
	}, 'g', '\\');

	// 3. expand single variables: ${name}
	template = replaceRecursive(template, '\\$\\$?{', '}', (match) => {
		let t = template;
		let replacement = match.outerText;
		if (match.left != '${') return replacement; // do not replace
		let replacements = variableResolver(match.innerText, expandOption);
		replacement = joint(replacements);
		replacements = expandTemplates(workspaceRoot, replacement, variableResolver, inSubtemplate, expandOption); // do I need to expandTemplates again?

		if (inSubtemplate && isArrayOfString(replacements)) {
			// return multi-value variable
			replacement = ss(replacements);
			return replacement;
		} else {
			// return multi-value string
			replacement = joint(replacements);
			return replacement;
		}
	}, 'g', '\\');

	// 4. expand multi-value variables: $${name}
	let paramMatches = matchRecursive(template, '\\$\\$?{', '}', 'g', '\\');
	paramMatches = paramMatches.filter(m => m.left == '$${');

	if (paramMatches.length == 0) return template; // template is not a template - do not expand

	if (inSubtemplate) {
		let t = template;
		if (paramMatches.length > 1) {
			// more than one multi-value variables found in sub-template
			throw new Error(`Subtemplate '${template}' contains more than one multi-value variable.`);
		}

		const paramMatch = paramMatches[0];
		const values = getMultivalues(workspaceRoot, paramMatch.innerText, variableResolver, expandOption);
		const replacements: string[] = [];

		values.forEach(replacement => {
			replacement = replaceAt(template, paramMatch.index, paramMatch.outerText.length, replacement);
			const xtReplacements = expandTemplates(workspaceRoot, replacement, variableResolver, inSubtemplate, expandOption);
			replacement = joint(xtReplacements);
			replacements.push(replacement);
		});
		return replacements; // return array
	} else {
		// NOT inSubtemplate
		let t = template;
		paramMatches.forEach(paramMatch => {
			const values = getMultivalues(workspaceRoot, paramMatch.innerText, variableResolver, expandOption);
			const replacements: string[] = [];

			values.forEach(replacement => {
				const xtReplacements = expandTemplates(workspaceRoot, replacement, variableResolver, inSubtemplate, expandOption);
				replacement = joint(xtReplacements);
				replacements.push(replacement);
			});
			const replacement = joint(replacements);
			template = replaceAt(template, paramMatch.index, paramMatch.outerText.length, replacement);
		});
		return template;
	}
}

const variableName = /^[a-zA-Z0-9_-]+$/; // actual variable name follows more strict pattern - see schema.json file

// FIXME: detect circular references
/** resolves multi-value $${} variable to array of values */
export function getMultivalues(workspaceRoot: string, variableText: string, variableResolver: VariableResolver, expandOption: ExpandPathsOption): string[] {
	let values: string[];

	if (variableName.test(variableText)) {
		// variableText appears to be a variable name
		const paramValue = variableResolver(variableText, expandOption);
		if (!paramValue) {
			throw new Error(`Variable '${variableText}' is undefined.`);
		} else {
			if (!isArrayOfString(paramValue)) {
				values = [paramValue];
			} else {
				values = deepClone(paramValue);
			}
		}
	} else if (variableList.test(variableText)) {
		// treat variableText as a list of values
		values = variableListParse(variableText);
	} else {
		throw new Error(`Unable to resolve variable '${variableText}'.`);
	}

	const newValues = expandMultivalues(workspaceRoot, values, variableResolver, expandOption);
	return newValues;
}

export function expandMultivalues(workspaceRoot: string, values: string[] | string, variableResolver: VariableResolver, expandOption: ExpandPathsOption): string[] {
	let newValues: string[] = [];
	if (!isArrayOfString(values)) values = values ? [values] : [];

	values.forEach(value => {
		const xtReplacements = expandTemplates(workspaceRoot, value, variableResolver, true, expandOption);

		if (isArrayOfString(xtReplacements)) {
			newValues = uniq([...newValues, ...xtReplacements]);
		} else {
			const pattern = unescapeTemplateText(xtReplacements);
			if (hasMagic(pattern)) {
				// value is glob expression
				const paths = expandGlob(workspaceRoot, pattern, expandOption);
				newValues = uniq([...newValues, ...paths]);
			} else {
				newValues.push(xtReplacements);
			}
		}
	});

	return newValues;
}

export function variableListJoin(list: string[] | string): string {
	const values: string[] = [];
	if (!isArrayOfString(list)) list = list ? [list] : [];
	list.forEach(value => {
		//let quote: boolean = false;
		if (value.indexOf('\'') != -1 || value.indexOf('\\') != -1) {
			// escape single quotes
			value = value.replace(/\'/g, '\\\'');
			//quote = true; // quote if variable contains single quote (') or backslash (\)
		}
		//if (quote || value.indexOf(',') != -1 || value.startsWith(' ') || value.endsWith(' ')) {
		// always quote value
		value = '\'' + value + '\'';
		//}
		values.push(value);
	});
	return values.join(',');
}

// expression to validate variable list
const variableList = /^\s*(?:'[^'\\]*(?:\\[\S\s][^'\\]*)*'|[^,'\s\\]*(?:\s+[^,'\s\\]+)*)\s*(?:,\s*(?:'[^'\\]*(?:\\[\S\s][^'\\]*)*'|[^,'\s\\]*(?:\s+[^,'\s\\]+)*)\s*)*$/;
// expression to match variable list values
const listValues = /(?!\s*$)\s*(?:'([^'\\]*(?:\\[\S\s][^'\\]*)*)'|([^,'\s\\]*(?:\s+[^,'\s\\]+)*))\s*(?:,|$)/g;
// for discussion refer to: https://stackoverflow.com/questions/8493195/how-can-i-parse-a-csv-string-with-javascript-which-contains-comma-in-data

export function variableListParse(list: string): string[] {
	if (!variableList.test(list)) {
		throw new Error(`Variable list is malformed: ${list}.`);
	}
	const values: string[] = [];
	const matches = list.match(listValues);
	matches?.forEach(value => {
		value = value.trim();
		value = value.endsWith(',') ? value.substr(0, value.length - 1) : value; // remove ending ','
		value = value.trim();
		value = value.startsWith('\'') && value.endsWith('\'') ? value.substr(1, value.length - 2) : value; // remove single quotes
		value = value.replace(/\\'/g, '\''); // de-escape single quotes
		values.push(value);
	});
	return values;
}

/** formats *escaped* string as path, adding quotes as needed */
function formatPath(pathString: string): string {
	pathString = pathString.trim();
	pathString = unescapeTemplateText(pathString);
	pathString = normalizePath(pathString);

	if (pathString.indexOf(' ') != -1) {
		if (pathString.startsWith('"') && pathString.endsWith('"')) {
			// path already double-quoted
		} else if (pathString.startsWith('\'') && pathString.endsWith('\'')) {
			if (process.platform !== 'win32') {
				// path already single-quoted - non-Windows
			} else {
				// change single quotes to double quotes required by Win32
				pathString = pathString.substr(1, pathString.length - 2);
				pathString = '"' + pathString + '"';
			}
		} else {
			// add double quotes
			pathString = '"' + pathString + '"';
		}
	}

	pathString = escapeTemplateText(pathString);
	return pathString;
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

	let propertiesConfigs: ConfigurationJson | undefined;

	if (propertiesPath) {
		if (false === await checkFileExists(propertiesPath)) {
			throw new Error(`'${propertiesPath}' file not found.`);
		}

		const errors = validateJsonFile(propertiesPath, PropertiesFileSchema);

		if (errors) {
			throw new Error(`'${propertiesPath}' file schema validation error(s).\n${(<string[]>errors).join('\n\n')}`);
		}

		propertiesConfigs = getJsonObject(propertiesPath);

		if (!propertiesConfigs) {
			throw new Error(`'${propertiesPath}' file read problem.`);
		}

		if (propertiesConfigs.version != 4) {
			throw new Error(`Unsupported '${propertiesPath}' config file version.`);
		}
	}

	const buildConfigs: GlobalConfiguration | undefined = getJsonObject(buildStepsPath);

	if (!buildConfigs) {
		throw new Error(`'${buildStepsPath}' file read problem.`);
	}

	let errors = validateJsonFile(buildStepsPath, BuildStepsFileSchema);
	if (errors) {
		throw new Error(`'${buildStepsPath}' file schema validation error(s).\n${(<string[]>errors).join('\n\n')}`);
	}

	// find matching configs in config and build files
	buildConfigs.configurations.forEach(c => {
		if (propertiesConfigs) {
			const matchingConfigs = propertiesConfigs.configurations.filter(b => b.name == c.name);

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
	const pathToRoot = IsMochaRunning ? '../' : '../../';
	const schema: any = require(path.join(pathToRoot, schemaFile));
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
