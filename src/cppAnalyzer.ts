/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2019-2020 Tomasz Jastrzębski. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

'use strict';

import * as path from 'path';
import { readLines, elapsedMills, globAsync, normalizePath } from './utils';
import * as process from 'process';
import { AsyncMutex } from "@esfx/async-mutex";

/** Class contains methods performing C/C++ static source code files dependency analysis. */
export class cppAnalyzer {
	/** Maps file to paths where its dependencies are located. Null value indicates missing file. */
	private readonly _pathMap = new Map<string, Set<string> | null>();
	/** Maps file to its dependencies */
	private _fileMap: Map<string, Set<string>> | undefined;
	private readonly _mutex: AsyncMutex = new AsyncMutex();
	private readonly _root: string;
	private readonly _includePaths: string[] = [];

	get pathMap(): Map<string, Set<string> | null> {
		return this._pathMap;
	}

	public constructor(root: string) {
		this._root = normalizePath(root);
	}

	/** Registers paths containing source code files to be analysed */
	async enlistFiles(includePaths: string[]) {
		await this._mutex.lock();

		try {
			if (!this._fileMap) {
				// initialize on the first call
				this._fileMap = new Map<string, Set<string>>();
				await this.enlist(this._root);
			}

			// read includePaths which do not start with _root
			for (let includePath of includePaths) {
				includePath = normalizePath(includePath);
				if (this._includePaths.includes(includePath)) continue; // skip path - already enlisted
				if (path.isAbsolute(includePath)) {
					if (includePath.startsWith(this._root)) continue; // skip paths starting with _root (already enlisted)
					await this.enlist(includePath);
				} else {
					// skip root-relative paths (already enlisted)
				}
				this._includePaths.push(includePath);
			}
		} finally {
			this._mutex.unlock();
		}
	}

	private async enlist(location: string) {
		const filePaths = await globAsync('**/*', { cwd: location });

		for (const filePath of filePaths) {
			const fileName = path.basename(filePath);
			const fullPath = path.join(location, filePath);

			if (this._fileMap!.has(fileName)) {
				const paths = this._fileMap!.get(fileName)!;
				paths.add(fullPath);
			} else {
				const paths = new Set<string>();
				paths.add(fullPath);
				this._fileMap!.set(fileName, paths);
			}
		}
	}

	/** Function returns subset of the previously enlisted paths required by a given file or null if file was not found. */
	async getPaths(fileLocation: string, file: string): Promise<string[] | null> {
		fileLocation = normalizePath(fileLocation);
		await this._mutex.lock();

		try {
			const includes = await this._getPaths(fileLocation, file);
			if (!includes) return [];
			const trimmedIncludePaths: string[] = [];
			// put includePaths in the original order
			for (const path of this._includePaths) {
				if (includes.has(path)) trimmedIncludePaths.push(path);
			}
			return trimmedIncludePaths;
		} finally {
			this._mutex.unlock();
		}
	}

	private async _getPaths(fileLocation: string, file: string): Promise<Set<string> | null> {
		const filePath = path.join(fileLocation, file);
		let requiredPaths = this._pathMap.get(filePath);

		if (requiredPaths || requiredPaths === null) {
			return requiredPaths; // file already processed - skip
		} else {
			requiredPaths = new Set<string>();
			this._pathMap.set(filePath, requiredPaths);
		}

		const includeFiles: string[] = [];

		// parse file looking for '#include' directives
		await readLines(filePath, line => {
			line = line.trimLeft();

			if (line.startsWith('#include')) {
				let includeFile = line.substring('#include'.length).trimLeft();

				if (includeFile.startsWith('"')) {
					const closingQuote = includeFile.indexOf('"', 1);

					if (closingQuote > 0) {
						includeFile = includeFile.substr(1, closingQuote - 1);
						includeFiles.push(includeFile);
					}
				} else if (includeFile.startsWith('<')) {
					const closingQuote = includeFile.indexOf('>', 1);

					if (closingQuote > 0) {
						includeFile = includeFile.substr(1, closingQuote - 1);
						includeFiles.push(includeFile);
					}
				}
			}
		});

		for (const includedFile of includeFiles) {
			let locationFilePath = path.join(fileLocation, includedFile); // set to current location - file may not exist here
			const includePath = await this.findInclFile(this._root, locationFilePath, includedFile);

			if (includePath) {
				// required included path found
				requiredPaths.add(includePath); // add path where included file was found

				if (path.isAbsolute(includePath)) {
					locationFilePath = path.join(includePath, includedFile);
				} else {
					locationFilePath = path.join(this._root, includePath, includedFile);
				}
			} else if (includePath === null) {
				// included file not found
				this._pathMap.set(locationFilePath, null);
				continue;
			} else {
				// includePath is undefined
				// file found at current location
			}

			let subRequiredPaths = this._pathMap.get(locationFilePath);

			if (!subRequiredPaths) {
				// get this file dependencies if not previously established
				const newLocation = path.dirname(locationFilePath);
				const fileName = path.basename(locationFilePath);
				subRequiredPaths = await this._getPaths(newLocation, fileName);
			}

			if (subRequiredPaths !== null) {
				// add paths required by dependencies
				for (const path of subRequiredPaths) requiredPaths.add(path);
			}
		}

		return requiredPaths;
	}

	/** Function returns includePath at which searched file was found, null if file was not found or undefined if file is local and no search path is needed.  */
	private async findInclFile(root: string, location: string, searchedFile: string): Promise<string | undefined | null> {
		const fileName = path.basename(searchedFile);
		const paths = this._fileMap!.get(fileName);

		if (paths) {
			if (paths.has(location)) {
				// file found from the same location
				// - no include paths search needed
				return undefined;
			}

			for (const includePath of this._includePaths) {
				let testedPath: string;

				if (path.isAbsolute(includePath)) {
					testedPath = path.join(includePath, searchedFile);
				} else {
					testedPath = path.join(root, includePath, searchedFile);
				}

				if (paths.has(testedPath)) {
					// file found
					return includePath;
				}
			}
			// file not found at any provided path
			return null;
		} else {
			// file known to be missing
			return null;
		}
	}
}
