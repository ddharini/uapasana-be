/**
 * The indexes Prisma cannot express.
 *
 *   npx ts-node scripts/ensure-partial-indexes.ts
 *
 * RUN THIS AFTER EVERY `prisma db push`. Push reconciles indexes against
 * schema.prisma and drops any it does not recognise, so an index created here
 * does not survive one.
 *
 * One registration per contact number: `Registration.contactMobile` has to be
 * unique among registrations that HAVE one, and absent on everyone else. A
 * plain `@unique` cannot do that on MongoDB: a missing field counts as a value,
 * so the index permits exactly one registration without a number and refuses
 * to build at all once there is a second.
 *
 * A partial index solves it: unique over the documents where the field is a
 * string, and silent about the rest.
 *
 * Assistant chats and the team's questions delete themselves 30 days after
 * last use: TTL indexes, which Prisma cannot express either. MongoDB's TTL
 * monitor removes expired documents about once a minute.
 *
 * `createIndexes` is idempotent: creating an index that already exists with the
 * same definition is a no-op, so this is safe to run blind.
 */
import { ASSISTANT_RETENTION_DAYS } from "../src/lib/assistant";
import { prisma } from "../src/utils/db";

const main = async () => {
  await prisma.$runCommandRaw({
    createIndexes: "registration",
    indexes: [
      {
        key: { contactMobile: 1 },
        name: "registration_contactMobile_partial_key",
        unique: true,
        partialFilterExpression: { contactMobile: { $type: "string" } },
      },
    ],
  });
  console.log("registration_contactMobile_partial_key is in place.");

  for (const [collection, field] of [
    ["assistant_chat", "updatedAt"],
    ["assistant_ask", "askedAt"],
  ] as const) {
    await prisma.$runCommandRaw({
      createIndexes: collection,
      indexes: [
        {
          key: { [field]: 1 },
          name: `${collection}_${field}_ttl`,
          expireAfterSeconds: ASSISTANT_RETENTION_DAYS * 24 * 60 * 60,
        },
      ],
    });
    console.log(`${collection}_${field}_ttl is in place (${ASSISTANT_RETENTION_DAYS} days).`);
  }

  await prisma.$disconnect();
};

main().catch(async e => {
  console.error(e?.message ?? e);
  await prisma.$disconnect();
  process.exit(1);
});
