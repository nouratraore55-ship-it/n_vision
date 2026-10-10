import 'dotenv/config';
import readline from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { prisma } from '../src/prismaClient.js';
import { hashPassword } from '../src/auth.js';

function getArg(name) {
  const prefix = `--${name}=`;
  const found = process.argv.find((a) => a.startsWith(prefix));
  return found ? found.slice(prefix.length) : null;
}

async function main() {
  let email = getArg('email');
  let password = getArg('password');
  let name = getArg('name');

  const rl = readline.createInterface({ input: stdin, output: stdout });

  if (!email) email = await rl.question('Email admin : ');
  if (!password) password = await rl.question('Mot de passe admin : ');
  if (!name) name = await rl.question('Nom (optionnel) : ');

  rl.close();

  if (!email || !password || password.length < 8) {
    console.error('❌ Email requis et mot de passe d’au moins 8 caractères requis.');
    process.exit(1);
  }

  const passwordHash = await hashPassword(password);

  const user = await prisma.user.upsert({
    where: { email },
    update: { passwordHash, name: name || undefined },
    create: { email, passwordHash, name: name || null, role: 'admin' },
  });

  console.log(`✅ Compte admin prêt : ${user.email}`);
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
