/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2019 Tomasz Jastrzębski. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

'use strict';

import * as path from 'path';
import { getBuildInfos, validateJsonFile } from './processor';
import { getJsonObject } from './utils';
import ajv from 'ajv';


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
		const infos = await getBuildInfos(buildStepsPath, propertiesPath);
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
