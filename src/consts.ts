/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2019 Tomasz Jastrzębski. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

'use strict';

const pkg = require('../package.json');

export const ToolVersion: string = pkg.version;
export const ToolName: string = pkg.name;
export const VscodeFolder: string = '.vscode';
export const PropertiesFile: string = 'c_cpp_properties.json';
export const BuildStepsFile: string = 'c_cpp_build.json';
export const BuildStepsFileSchema: string = 'c_cpp_build.schema.json';
export const PropertiesFileSchema: string = 'c_cpp_properties.schema.json';