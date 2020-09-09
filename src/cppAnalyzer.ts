/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2019-2020 Tomasz Jastrzębski. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

'use strict';

import * as path from 'path';
import { readLines, globAsync, normalizePath } from './utils';
import { AsyncMutex } from "@esfx/async-mutex";

/** Class contains methods performing C/C++ static source code files dependency analysis. */
export class cppAnalyzer {
	/** Maps file to paths where its dependencies are located. Null value indicates missing file. */
	private readonly _fileRequiredPaths = new Map<string, Set<string> | null>();
	/** Maps file name to full paths where it can be found */
	private _fileLocations: Map<string, Set<string>> | undefined;
	/** Maps file path to its dependencies */
	private _fileDependencies = new Map<string, Set<string>>();
	private readonly _mutex: AsyncMutex = new AsyncMutex();
	private readonly _root: string;
	private readonly _includePaths: string[] = [];

	/** Maps file path to paths where file dependencies are located. Null value indicates missing file. */
	get fileRequiredPaths(): Map<string, Set<string> | null> {
		return this._fileRequiredPaths;
	}

	/** Maps file path to its dependencies */
	get fileDependencies(): Map<string, Set<string>> | undefined {
		return this._fileDependencies;
	}

	public constructor(root: string) {
		this._root = normalizePath(root);
	}

	/** Enlists file paths containing source code files to be analysed */
	async enlistFilePaths(includePaths: string[]) {
		await this._mutex.lock();

		try {
			if (!this._fileLocations) {
				// initialize on the first call
				this._fileLocations = new Map<string, Set<string>>();
			}

			for (let includePath of includePaths) {
				includePath = normalizePath(includePath);
				let enlistPath = includePath;

				if (path.isAbsolute(includePath) && includePath.startsWith(this._root + '/')) {
					// absolute path starts with 'root'
					includePath = includePath.substr(this._root.length + 1);
				} else if (includePath == this._root) {
					// path is 'root'
					includePath = '.';
				}

				if (this._includePaths.includes(includePath)) continue; // skip path - already enlisted

				if (!path.isAbsolute(enlistPath)) {
					enlistPath = path.join(this._root, enlistPath);
				}

				await this.enlistFiles(enlistPath);
				this._includePaths.push(includePath);
			}
		} finally {
			this._mutex.unlock();
		}
	}

	private async enlistFiles(location: string) {
		const filePaths = await globAsync('*', { cwd: location, nodir: true }); // list files only

		for (const filePath of filePaths) {
			const fileName = path.basename(filePath);
			const fullPath = path.join(location, filePath);

			if (this._fileLocations!.has(fileName)) {
				const paths = this._fileLocations!.get(fileName)!;
				paths.add(fullPath);
			} else {
				const paths = new Set<string>();
				paths.add(fullPath);
				this._fileLocations!.set(fileName, paths);
			}
		}
	}

	/** Returns the 'include' paths required to compile a given file - a subset of the previously enlisted 'include' paths required by a given file or null, if file was not found. */
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
		let requiredPaths = this._fileRequiredPaths.get(filePath);

		if (requiredPaths || requiredPaths === null) {
			return requiredPaths; // file already processed - skip
		} else {
			requiredPaths = new Set<string>();
			this._fileRequiredPaths.set(filePath, requiredPaths);
		}

		const includeFiles: string[] = await this.getIncludedFiles(filePath);
		let fileDependencies = this._fileDependencies.get(filePath);

		if (!fileDependencies) {
			fileDependencies = new Set<string>();
			this._fileDependencies.set(filePath, fileDependencies);
		}

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

				fileDependencies.add(locationFilePath);
			} else if (includePath === null) {
				// included file not found
				this._fileRequiredPaths.set(locationFilePath, null);
				continue;
			} else {
				// includePath is undefined
				// file found at current location
				fileDependencies.add(path.join(fileLocation, includedFile));
			}

			let subRequiredPaths = this._fileRequiredPaths.get(locationFilePath);

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

	private getLinePartText(line: string, textStart: number | undefined, textEnd: number | undefined): string {
		if (textEnd == undefined) textEnd = line.length;
		if (textStart == undefined || textEnd <= textStart) return '';
		const text: string = line.substring(textStart, textEnd).trim();
		return text;
	}

	private async getIncludedFiles(filePath: string): Promise<string[]> {
		const includeFiles: string[] = [];
		let inCommentBlock: boolean = false;

		// parse file looking for '#include' directives
		await readLines(filePath, line => {
			line = line.trimLeft();
			let commentBlockStart: number = -1;
			let commentBlockEnd: number = -1;
			let linePartStart: number | undefined = inCommentBlock ? undefined : 0;
			let linePartEnd: number | undefined = undefined;
			let linePartText: string | undefined; // contains the first non-blank, non-comment line part

			// find first non-blank line part between commented-out blocs
			for (let i: number = 0; i < line.length - 1; i++) {
				if (inCommentBlock) {
					commentBlockEnd = line.indexOf('*/', i);

					if (commentBlockEnd > -1) {
						inCommentBlock = false;
						i = commentBlockEnd + 1;
						linePartStart = commentBlockEnd + 2;
						linePartEnd = undefined;
					} else {
						break; // no comment-end in this line, read the next line
					}
				} else {
					// not in comment block
					commentBlockStart = line.indexOf('/*', i);
					const lineCommentStart: number = line.indexOf('//', i);

					if (commentBlockStart > -1 && (lineCommentStart == -1 || commentBlockStart < lineCommentStart)) {
						// block comment occurs first
						inCommentBlock = true;
						linePartEnd = commentBlockStart;
						i = commentBlockStart + 1;
						linePartText = this.getLinePartText(line, linePartStart, linePartEnd);
						if (linePartText != '') break; // skip the rest of the line if this part is non-blank
					} else if (lineCommentStart > -1 && (commentBlockStart == -1 || lineCommentStart < commentBlockStart)) {
						// line comment occurs first
						inCommentBlock = false; // FALSE since line comment does not continue to the next line
						linePartEnd = lineCommentStart;
						linePartText = this.getLinePartText(line, linePartStart, linePartEnd);
						break; // unconditionally skip the rest of the line
					} else {
						linePartStart = i;
						linePartEnd = line.length;
						linePartText = this.getLinePartText(line, linePartStart, linePartEnd);
						break; // this line has no comment-start, stop looking for one
					}
				}
			}

			if (!linePartText) return;

			// store 'included' file name
			if (linePartText.startsWith('#include')) {
				let includeFile = linePartText.substring('#include'.length).trimLeft();

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

		return includeFiles;
	}

	/** Returns includePath at which searched file was found, null if file was not found or undefined if file is local and no search path is needed.  */
	private async findInclFile(root: string, location: string, searchedFile: string): Promise<string | undefined | null> {
		const fileName = path.basename(searchedFile);
		const paths = this._fileLocations!.get(fileName);

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
