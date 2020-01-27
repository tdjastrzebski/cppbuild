/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2019-2020 Tomasz Jastrzębski. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

'use strict';

export { GlobalConfiguration, BuildConfiguration, BuildType, BuildStep, BuildInfo, BuilderOptions, ParamsDictionary, CompilerType, VariableResolver } from "./interfaces";
export { checkFileExists, checkDirectoryExists, readDirectory, ConfigurationJson, Configuration, Browse, KnownCompiler } from "./cpptools";
export { getJsonObject, execCmd, ExecCmdResult, spawnCommand, makeDirectory, getLatestVersion, replaceRecursive, matchRecursive, XRegExpMatch, escapeTemplateText, unescapeTemplateText } from "./utils";
export { getBuildInfos, expandTemplate } from "./processor";
export { Builder, setSampleBuildConfig } from "./builder";
export { ToolVersion, ToolName, VscodeFolder, PropertiesFile, BuildStepsFile, BuildStepsFileSchema, PropertiesFileSchema } from './consts';
