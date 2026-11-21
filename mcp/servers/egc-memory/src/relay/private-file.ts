import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

// The private files of the mesh under ~/.egc (the identity of the machine,
// the central, the lock and the status of the bridge) are written the same
// way: the content goes to a temporary sibling created exclusively, with
// mode 0600 from the start, so a link planted at that name is refused and
// never followed; the sibling is renamed over the target, so a reader never
// sees half a file; and a draft that could not be finished is removed, so
// a failing disk leaves no partial files behind.
function draft(file: string, text: string): string {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  const descriptor = fs.openSync(temporary, 'wx', 0o600);
  try {
    // The mode given to open is masked by the umask; the owner gets it back
    // before the first byte. Windows has no mode bits to set, and only there
    // is a failure to set them not an error.
    try {
      fs.fchmodSync(descriptor, 0o600);
    } catch (error) {
      if (process.platform !== 'win32') throw error;
    }
    fs.writeFileSync(descriptor, text, 'utf8');
    fs.closeSync(descriptor);
  } catch (error) {
    try {
      fs.closeSync(descriptor);
    } catch {
      // closed already
    }
    fs.rmSync(temporary, { force: true });
    throw error;
  }
  return temporary;
}

export function writePrivateFile(file: string, text: string): void {
  const temporary = draft(file, text);
  try {
    fs.renameSync(temporary, file);
  } catch (error) {
    fs.rmSync(temporary, { force: true });
    throw error;
  }
}

// Publishes the file only if the name is free: the finished draft is linked
// to its name, which fails with EEXIST when another process got there first,
// and then false is returned with nothing changed. A file system without
// hard links falls back to an exclusive copy, which keeps the guarantee that
// a name already taken is never overwritten.
export function publishPrivateFile(file: string, text: string): boolean {
  const temporary = draft(file, text);
  try {
    try {
      fs.linkSync(temporary, file);
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false;
    }
    try {
      fs.copyFileSync(temporary, file, fs.constants.COPYFILE_EXCL);
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false;
      throw error;
    }
  } finally {
    fs.rmSync(temporary, { force: true });
  }
}

export function privateJson(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}
