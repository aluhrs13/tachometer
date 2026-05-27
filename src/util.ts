/**
 * @license
 * Copyright 2019 Google LLC
 * SPDX-License-Identifier: BSD-3-Clause
 */

import {execFile, ExecFileOptions} from 'child_process';
import fsExtra from 'fs-extra';
import {URL} from 'url';
import {promisify} from 'util';

/** Return whether the given string is a valid HTTP URL. */
export function isHttpUrl(str: string): boolean {
  try {
    const url = new URL(str);
    // Note an absolute Windows file path will parse as a URL (e.g.
    // 'C:\\foo\\bar' => {protocol: 'c:', pathname: '\\foo\\bar', ...})
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch (e) {
    return false;
  }
}

export async function fileKind(
  path: string
): Promise<'file' | 'dir' | undefined> {
  try {
    const stat = await fsExtra.stat(path);
    if (stat.isDirectory()) {
      return 'dir';
    }
    if (stat.isFile()) {
      return 'file';
    }
  } catch (e) {
    if ((e as Error & {code?: string}).code === 'ENOENT') {
      return undefined;
    }
    throw e;
  }
}

const npmCmd = process.platform === 'win32' ? 'npm.cmd' : 'npm';
export async function runNpm(
  args: string[],
  options?: ExecFileOptions
): Promise<string | Buffer> {
  // On Windows, Node 20+ refuses to `execFile` `.cmd`/`.bat` shims without
  // `shell: true` (mitigation for CVE-2024-27980). All callers of `runNpm`
  // pass internally constructed arguments, not user input, so enabling the
  // shell is safe here.
  const shellOption: ExecFileOptions =
    process.platform === 'win32' ? {shell: true} : {};
  return promisify(execFile)(npmCmd, args, {...shellOption, ...options}).then(
    ({stdout}) => stdout
  );
}

/**
 * Promisified version of setTimeout.
 */
export const wait = (ms: number) =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * A function that should never be called. But if it somehow is anyway, throw an
 * exception with the given message.
 */
export function throwUnreachable(_unreachable: never, message: string): void {
  throw new Error(message);
}
