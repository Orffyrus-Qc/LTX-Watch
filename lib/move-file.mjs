import { copyFile, rename, unlink } from 'node:fs/promises';

export async function moveFile(source, destination, operations = {}) {
  const renameFile = operations.renameFile || rename;
  const copyFileToDestination = operations.copyFileToDestination || copyFile;
  const removeFile = operations.removeFile || unlink;

  try {
    await renameFile(source, destination);
    return;
  } catch (error) {
    if (error?.code !== 'EXDEV') throw error;
  }

  await copyFileToDestination(source, destination);
  try {
    await removeFile(source);
  } catch (error) {
    await removeFile(destination).catch(() => undefined);
    throw error;
  }
}
