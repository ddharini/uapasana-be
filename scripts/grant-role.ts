/**
 * Gives an account access to the registration desk, or takes it away.
 *
 *   pnpm grant-role <email> staff                 see and manage registrations
 *   pnpm grant-role <email> admin                 the same, plus the admin screens
 *   pnpm grant-role <email> sanchalak "<mandal>"  one mandal's registrations
 *   pnpm grant-role <email> user                  back to no access
 *
 * The account has to exist first: the person signs up on the login screen,
 * sees "waiting for access", and is let in by this.
 *
 * This is how the first admin is made. After that, admins invite admins and
 * sanchalaks from the app's Team screen; this script stays for bootstrap and
 * for granting "staff".
 */
import "../src/env";

import { MANDALS } from "../src/lib/event";
import { prisma } from "../src/utils/db";

const ROLES = ["user", "staff", "sanchalak", "admin"];

async function main() {
  const [email, role, mandal] = process.argv.slice(2);
  if (!email || !role || !ROLES.includes(role)) {
    console.error(`Usage: pnpm grant-role <email> <${ROLES.join("|")}> ["<mandal>" for sanchalak]`);
    process.exitCode = 1;
    return;
  }
  if (role === "sanchalak" && !(MANDALS as readonly string[]).includes(mandal ?? "")) {
    console.error(`A sanchalak needs one of these mandals, in quotes:\n  ${MANDALS.join("\n  ")}`);
    process.exitCode = 1;
    return;
  }

  const user = await prisma.user.findUnique({ where: { email: email.toLowerCase() } });
  if (!user) {
    console.error(`No account for ${email}. They need to sign up on the login screen first.`);
    process.exitCode = 1;
    return;
  }

  await prisma.user.update({
    where: { id: user.id },
    data: { role, mandal: role === "sanchalak" ? mandal : null },
  });
  console.log(
    `${user.name} <${user.email}> is now "${role}"${role === "sanchalak" ? ` for ${mandal}` : ""} (was "${user.role}").`
  );
  console.log("It takes effect on their next page load.");
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
