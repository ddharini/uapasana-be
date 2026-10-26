/**
 * Purges every account whose 30-day grace period has passed.
 *
 *   npx ts-node -r dotenv-flow/config scripts/hard-delete-scheduled-accounts.ts
 *   npx ts-node -r dotenv-flow/config scripts/hard-delete-scheduled-accounts.ts --dry-run
 *
 * `POST /users/delete` (userController.ts) only ever sets `User.deletedAt` — it
 * never removes a row. This is the other half: the one place left that does a
 * real, cascading `prisma.user.delete()`, and it only ever touches an account
 * whose grace period (`deletedAt` + `GRACE_DAYS`) has fully elapsed and that
 * was never restored via `POST /users/restore`.
 *
 * There is no cron running inside the API process — this is a standalone
 * script, meant to be triggered once a day by whatever runs scheduled jobs
 * outside the app (host cron, a platform's scheduled-job feature, CI). Safe to
 * run more often than that: a user with no grace period expired yet is simply
 * not selected.
 *
 * Order per user:
 *   1. An audit log row — written *before* the delete, on the reasoning that a
 *      record saying "we tried to hard-delete this account" is worth having
 *      even if a later step in the same run throws. `AccountAuditLog` is not a
 *      Prisma relation to `User`, so it is untouched by the cascade below.
 *   2. `prisma.user.delete()`, which cascades to every remaining row this
 *      schema still relates to the user — `Session` and `Account` — exactly the purge the soft delete exists to have
 *      deferred, not skipped.
 */
import { prisma } from "../src/utils/db";

const GRACE_DAYS = 30;

const main = async () => {
  const dryRun = process.argv.includes("--dry-run");
  const cutoff = new Date(Date.now() - GRACE_DAYS * 24 * 60 * 60 * 1000);

  const due = await prisma.user.findMany({
    where: { deletedAt: { lte: cutoff } },
    select: { id: true, email: true, deletedAt: true },
  });

  if (!due.length) {
    console.log(`No accounts past their ${GRACE_DAYS}-day grace period.`);
    await prisma.$disconnect();
    return;
  }

  console.log(`${due.length} account(s) past the grace period${dryRun ? " (dry run — nothing will be deleted)" : ""}:`);

  for (const user of due) {
    console.log(`  ${user.email} <${user.id}> — grace period started ${user.deletedAt?.toISOString()}`);

    if (dryRun) continue;

    await prisma.accountAuditLog.create({
      data: {
        userId: user.id,
        email: user.email,
        action: "hard_deleted",
        detail: `grace period started ${user.deletedAt?.toISOString()}`,
      },
    });

    // Cascades to Session and Account — see schema.prisma's
    // `onDelete: Cascade` on each. This is the one line in the whole
    // account-deletion path that actually deletes user data, and it only
    // ever runs here.
    await prisma.user.delete({ where: { id: user.id } });
  }

  console.log(dryRun ? "Dry run complete." : `Hard-deleted ${due.length} account(s).`);
  await prisma.$disconnect();
};

main().catch(async (error) => {
  console.error(error?.message ?? error);
  await prisma.$disconnect();
  process.exit(1);
});
