/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2019-2020 Tomasz Jastrzębski. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

'use strict';

import { assert } from 'chai';
import * as path from 'path';
import * as fs from 'fs';
import * as process from 'process';
import chalk from 'chalk';
import { getBuildInfos, validateJsonFile, expandTemplate, getMultivalues, variableListParse, variableListJoin } from '../src/processor';
import { elapsedMills, dColor, unescapeTemplateText, escapeTemplateText, expandGlob, lookUpVariable } from '../src/utils';
import { BuildStepsFileSchema, PropertiesFileSchema, PropertiesFile, BuildStepsFile } from '../src/api';
import { cppAnalyzer } from '../src/cppAnalyzer';
import { ParamsDictionary, ExpandPathsOption } from '../src/interfaces';
const testRoot = 'c:/temp/cppbuild-test';
const workspaceRoot = process.cwd();
const rimraf = require("rimraf");
import XRegExp from 'xregexp';
import { PathToRoot } from '../src/consts';

suite('processor tests', () => {
	test('expandTemplate() test', () => {
		rimraf.sync(testRoot);
		fs.mkdirSync(`${testRoot}/AA`, { recursive: true });
		fs.mkdirSync(`${testRoot}/AB`, { recursive: true });
		fs.mkdirSync(`${testRoot}/BA`, { recursive: true });
		fs.mkdirSync(`${testRoot}/BB`, { recursive: true });
		const params: ParamsDictionary = { t0: [`${testRoot}/A*`, `${testRoot}/B*`] };
		const actual = expandTemplate(workspaceRoot, '[$${t0}]', (name) => lookUpVariable(name, params));
		assert.equal(actual, `${testRoot}/AA ${testRoot}/AB ${testRoot}/BA ${testRoot}/BB`);
	});
	test('variableListJoin()/variableListParse() test', () => {
		const expected: string[] = ['"aa \\(bb\\) cc"'];
		const s = variableListJoin(expected);
		const actual = variableListParse(s);
		assert.deepEqual(actual, expected);
	});
	test('expandTemplate() test', () => {
		const escaped = 'C:\\\\Program Files \\(x86\\)\\\\';
		const params: ParamsDictionary = { t1: [escaped, escaped] };
		const actual = expandTemplate(workspaceRoot, '[$${t1}]', (name) => lookUpVariable(name, params));
		assert.equal(actual, '"C:/Program Files (x86)/" "C:/Program Files (x86)/"');
	});
	test('expandTemplate() test', () => {
		const expected = '[a] b {c}d (1) { e$f ${g}), \\h \'i\' "j"';
		const str = escapeTemplateText(expected);
		let arr = [str, str, str];
		const list = variableListJoin(arr);
		arr = variableListParse(list);
		const actual = unescapeTemplateText(arr[1]);
		assert.equal(actual, expected);
	});
	test('expandTemplate() test', () => {
		const template = '\\(aa\\) \\[bb\\] \\$\\{t1\\} \\$\\$\\{t2\\} \\\\ \\\'';
		const params: ParamsDictionary = { t1: 'c', t2: ['d', 'e'] };
		const actual = expandTemplate(workspaceRoot, template, (name) => lookUpVariable(name, params));
		assert.equal(actual, '(aa) [bb] ${t1} $${t2} \\ \'');
	});
	test('escape/unescape test', () => {
		const expected = '[sdf]sdf{sdf}s()df$sdef\\sdf\'df';
		const str = escapeTemplateText(expected);
		const actual = unescapeTemplateText(str);
		assert.equal(actual, expected);
	});
	test('expandTemplate() test', () => {
		const template = '(aa)';
		const actual = expandTemplate(workspaceRoot, template, (name) => lookUpVariable(name, {}));
		assert.equal(actual, 'aa');
	});
	test('expandTemplate() test', () => {
		const params: ParamsDictionary = { t0: ['a', '(-$${t1})', '(+$${t2})', '${t3}', '$${g, h}'], t1: ['b', 'c'], t2: ['d', 'e'], t3: 'f' };
		const template = '($${t0})';
		const actual = expandTemplate(workspaceRoot, template, (name) => lookUpVariable(name, params));
		assert.equal(actual, 'a -b -c +d +e f g h');
	});
	test('expandTemplate() test', () => {
		const params: ParamsDictionary = { t0: ['a', '(-$${t1})'], t1: ['b', 'c'] };
		const template = '($${t0})';
		const actual = expandTemplate(workspaceRoot, template, (name) => lookUpVariable(name, params));
		assert.equal(actual, 'a -b -c');
	});
	test('expandTemplate() test', () => {
		const params: ParamsDictionary = { t0: ['a', '$${t1}'], t1: ['b', 'c'] };
		const template = '($${t0})';
		const actual = expandTemplate(workspaceRoot, template, (name) => lookUpVariable(name, params));
		assert.equal(actual, 'a b c');
	});
	test('getMultivalues() test', () => {
		rimraf.sync(testRoot);
		fs.mkdirSync(`${testRoot}/A`, { recursive: true });
		fs.mkdirSync(`${testRoot}/B`, { recursive: true });
		const params: ParamsDictionary = { t0: [testRoot, testRoot + '/*'] };
		const actual = getMultivalues(workspaceRoot, '$${t0}', (name) => lookUpVariable(name, params), ExpandPathsOption.expandAll);
		assert.deepEqual(actual, [testRoot, `${testRoot}/A`, `${testRoot}/B`]);
	});
	test('getMultivalues() test', () => {
		rimraf.sync(testRoot);
		fs.mkdirSync(`${testRoot}/A`, { recursive: true });
		fs.mkdirSync(`${testRoot}/B`, { recursive: true });
		const pattern = `$\${${testRoot}/**}`;
		const actual = getMultivalues(workspaceRoot, pattern, (name) => lookUpVariable(name, {}), ExpandPathsOption.expandAll);
		assert.deepEqual(actual, [testRoot, `${testRoot}/A`, `${testRoot}/B`]);
	});
	test('variableListJoin()/variableListParse() test', () => {
		const expected: string[] = ['aa', '\"bb\"', '\"c c\"', '\'dd\'', '\'e e\'', ',', ' ', 'f,f', 'g\'g', ' h ', ' i, ', ' j , '];
		const s = variableListJoin(expected);
		const actual = variableListParse(s);
		assert.deepEqual(actual, expected);
	});
	test('expandTemplate() test', () => {
		rimraf.sync(testRoot);
		fs.mkdirSync(`${testRoot}/A`, { recursive: true });
		fs.mkdirSync(`${testRoot}/B`, { recursive: true });
		const params: ParamsDictionary = {};
		const template = '($${' + testRoot + '/**})';
		const actual = expandTemplate(testRoot, template, (name) => lookUpVariable(name, params));
		assert.equal(actual, `${testRoot} ${testRoot}/A ${testRoot}/B`);
	});
	test('expandTemplate() test', () => {
		const params: ParamsDictionary = { t0: '1', t1: ['bb', 'ccc', 'ddd'] };
		const template = '(($${t0}) $${t1})';
		const actual = expandTemplate(workspaceRoot, template, (name) => lookUpVariable(name, params));
		assert.equal(actual, '1 bb 1 ccc 1 ddd');
	});
	test('expandTemplate() test', () => {
		const params: ParamsDictionary = { t0: ['1', '2'], t1: ['bb', 'ccc', 'ddd'] };
		const template = '([$${t0}] $${t1})';
		try {
			const actual = expandTemplate(workspaceRoot, template, (name) => lookUpVariable(name, params));
			assert.fail('no expected error');
		} catch {
			assert.ok('error occurred');
		}
	});
	test('expandTemplate() test', () => {
		const params: ParamsDictionary = { t0: ['1', '2'], t1: ['bb', 'ccc', 'ddd'] };
		const template = '(($${t0}) $${t1})';
		const actual = expandTemplate(workspaceRoot, template, (name) => lookUpVariable(name, params));
		assert.equal(actual, '1 2 bb 1 2 ccc 1 2 ddd');
	});
	test('expandTemplate() test', () => {
		const params: ParamsDictionary = { t0: '$${t1}', t1: ['b b', 'ccc', 'dd dd'] };
		const template = '([${t0}]) : ([${t0}])';
		const actual = expandTemplate(workspaceRoot, template, (name) => lookUpVariable(name, params));
		assert.equal(actual, '"b b" ccc "dd dd" : "b b" ccc "dd dd"');
	});
	test('expandTemplate() test', () => {
		const params: ParamsDictionary = { t0: '$${t1}', t1: ['b b', 'ccc', 'dd dd'] };
		const template = '([${t0}])';
		const actual = expandTemplate(workspaceRoot, template, (name) => lookUpVariable(name, params));
		assert.equal(actual, '"b b" ccc "dd dd"');
	});
	test('expandTemplate() test', () => {
		const params: ParamsDictionary = { t1: ['b b', 'c c c', 'dddd'], t2: 'f:' };
		const template = '(${t2}[$${t1}])';
		const actual = expandTemplate(workspaceRoot, template, (name) => lookUpVariable(name, params));
		assert.equal(actual, 'f:"b b" f:"c c c" f:dddd');
	});
	test('expandTemplate() test', () => {
		const params: ParamsDictionary = { t1: ['b b', 'c c c', 'dddd'] };
		const template = '(f:$${t1})';
		const actual = expandTemplate(workspaceRoot, template, (name) => lookUpVariable(name, params));
		assert.equal(actual, 'f:b b f:c c c f:dddd');
	});
	test('expandTemplate() test', () => {
		const params: ParamsDictionary = { t1: ['b b', 'c c c', 'dddd'] };
		const template = '(f:[$${t1}])';
		const actual = expandTemplate(workspaceRoot, template, (name) => lookUpVariable(name, params));
		assert.equal(actual, 'f:"b b" f:"c c c" f:dddd');
	});
	test('expandTemplate() test', () => {
		const params: ParamsDictionary = { t1: ['b b', 'c c c', 'dddd'] };
		const template = '[$${t1}]';
		const actual = expandTemplate(workspaceRoot, template, (name) => lookUpVariable(name, params));
		assert.equal(actual, '"b b" "c c c" dddd');
	});
	test('expandTemplate() test', () => {
		const params: ParamsDictionary = { t1: 'b b' };
		const template = '[${t1}]';
		const actual = expandTemplate(workspaceRoot, template, (name) => lookUpVariable(name, params));
		assert.equal(actual, '"b b"');
	});
	test('expandTemplate() test', () => {
		const params: ParamsDictionary = { t1: '$${t2}', t2: ['bb', 'ccc', 'dddd'] };
		const template = '${t1}';
		const actual = expandTemplate(workspaceRoot, template, (name) => lookUpVariable(name, params));
		assert.equal(actual, 'bb ccc dddd');
	});
	test('expandTemplate() test', () => {
		const params: ParamsDictionary = { t1: 'a', t2: ['bb', 'ccc', 'dddd'] };
		const template = '${t1} $${t2}';
		const actual = expandTemplate(workspaceRoot, template, (name) => lookUpVariable(name, params));
		assert.equal(actual, 'a bb ccc dddd');
	});
});

suite('other tests', () => {
	test('trimmer.getIncludes test', async () => {
		const root = 'test-cpp';
		const includePaths = [''];//expandNoTemplatePaths(root, ["mbed-os", "mbed-os/**"], (name) => lookUpVariable(name, {}), ExpandPathsOption.expandAll);
		const trimmer = new cppAnalyzer(root);

		let start = process.hrtime();
		await trimmer.enlistFilePaths(includePaths);
		const initTime = elapsedMills(start) / 1000;

		const files = expandGlob(root, '**/*.{c,cpp}', ExpandPathsOption.filesOnly);
		start = process.hrtime();

		for (const file of files) {
			const fileLocation = path.join(root, path.dirname(file));
			const fileName = path.basename(file);
			const fileIncludes = await trimmer.getPaths(fileLocation, fileName);

			if (fileName == 'stm32f7xx.h') {
				const o = trimmer.pathMap.get('object.h'); // device.h
				console.log('');
			}

		}

		const processTime = elapsedMills(start) / 1000;
		let maxCount = 0;
		let notFoundCount = 0;

		trimmer.pathMap.forEach(path => {
			if (path == null) {
				notFoundCount++;
			} else {
				if (path.size > maxCount) maxCount = path.size;
			}
		});

		console.log(dColor(`initTime: ${initTime.toFixed(2)}, process time: ${processTime.toFixed(2)}s, max path count: ${maxCount}, files: ${trimmer.pathMap.size}, not found: ${notFoundCount}`));
		//console.log(wColor(`element count: ${inclPaths.size}, max count: ${maxCount}, time: ${elapsed.toFixed(2)}s`));
		//console.log(wColor(`c1: ${c1}, c2: ${c2}, c0: ${c0}s, nf: ${notFoundCount}`));
	});
	test('validateJsonFile test', () => {
		let errors = validateJsonFile('test-cpp/.vscode/c_cpp_build.json', path.join(PathToRoot, BuildStepsFileSchema));
		if (errors) {
			console.log(`XX file schema validation error(s).\n${(<string[]>errors).join('\n\n')}`);
		} else { console.log('no errors'); }

		errors = validateJsonFile('test-cpp/.vscode/c_cpp_properties.json', path.join(PathToRoot, PropertiesFileSchema));
		if (errors) {
			console.log(`XX file schema validation error(s).\n${(<string[]>errors).join('\n\n')}`);
		} else { console.log('no errors'); }
	});
	test('getBuildInfos test', () => {
		const propertiesPath: string = path.join(workspaceRoot, 'test-cpp/.vscode', PropertiesFile);
		const buildStepsPath: string = path.join(workspaceRoot, 'test-cpp/.vscode', BuildStepsFile);
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
	});
	test('colors test', () => {
		const ctx = new chalk.Instance({ level: 3 });
		console.log(ctx.rgb(224, 135, 113)('test 1'));
		console.log(ctx.rgb(205, 151, 49)('test 2'));
		console.log(ctx.rgb(220, 220, 170)('test 3'));
		console.log(ctx.rgb(206, 145, 120)('test 4'));
		console.log(ctx.rgb(156, 220, 254)('test 5'));
		console.log(ctx.rgb(78, 201, 176)('test 6'));
		console.log(ctx.rgb(197, 134, 192)('test 7'));
		console.log(ctx.rgb(204, 204, 204)('test 8'));
		console.log(ctx.rgb(224, 224, 224)('test 9'));
		console.log(ctx.rgb(86, 156, 214)('test 10'));
		console.log(ctx.rgb(114, 157, 179)('test 11'));
		console.log(ctx.rgb(181, 206, 169)('test 12'));
		assert.ok('done');
	});
});
