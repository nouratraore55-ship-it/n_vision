// Stockage simple par fichiers JSON — pas de base de données à installer ou migrer.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, '..', 'data');

function ensureFile(file) {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  const filePath = path.join(DATA_DIR, file);
  if (!fs.existsSync(filePath)) fs.writeFileSync(filePath, '[]', 'utf-8');
  return filePath;
}

export function readAll(file) {
  const filePath = ensureFile(file);
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  } catch {
    return [];
  }
}

export function writeAll(file, list) {
  const filePath = ensureFile(file);
  fs.writeFileSync(filePath, JSON.stringify(list, null, 2), 'utf-8');
}
