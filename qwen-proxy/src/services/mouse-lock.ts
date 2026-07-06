let locked = false;
let lockedBy: string | null = null;

export function acquireMouseLock(owner: string): boolean {
  if (locked) return false;
  locked = true;
  lockedBy = owner;
  return true;
}

export function releaseMouseLock(owner?: string): void {
  if (owner && lockedBy !== owner) return;
  locked = false;
  lockedBy = null;
}

export function isMouseLocked(): boolean {
  return locked;
}

export function getMouseLockOwner(): string | null {
  return lockedBy;
}
