/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2019-2020 Tomasz Jastrzębski. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

'use strict';
import * as path from 'path';
export const PathToRoot = '../../';
const pkg = require(path.join(PathToRoot, 'package.json'));
export const ToolVersion: string = pkg.version;
export const ToolName: string = pkg.name;
export const VscodeFolder: string = '.vscode';
export const PropertiesFile: string = 'c_cpp_properties.json';
export const BuildStepsFile: string = 'c_cpp_build.json';
export const BuildStepsFileSchema: string = 'c_cpp_build.schema.json';
export const PropertiesFileSchema: string = 'c_cpp_properties.schema.json';
/** expression to validate variable list */
export const VariableList = /^\s*(?:'[^'\\]*(?:\\[\S\s][^'\\]*)*'|[^,'\s\\]*(?:\s+[^,'\s\\]+)*)\s*(?:,\s*(?:'[^'\\]*(?:\\[\S\s][^'\\]*)*'|[^,'\s\\]*(?:\s+[^,'\s\\]+)*)\s*)*$/;
/**
 * expression to match variable list values
 * for discussion refer to: https://stackoverflow.com/questions/8493195/how-can-i-parse-a-csv-string-with-javascript-which-contains-comma-in-data
*/
export const ListValues = /(?!\s*$)\s*(?:'([^'\\]*(?:\\[\S\s][^'\\]*)*)'|([^,'\s\\]*(?:\s+[^,'\s\\]+)*))\s*(?:,|$)/g;
/** the actual variable name follows more strict pattern - see schema.json file */
export const VariableName = /^[a-zA-Z0-9_-]+$/;