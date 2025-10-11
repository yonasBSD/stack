import { sqlQuoteIdent } from '@/prisma-client';
import { Prisma, PrismaClient } from '@prisma/client';
import { StackAssertionError } from '@stackframe/stack-shared/dist/utils/errors';
import { MIGRATION_FILES } from './../generated/migration-files';

// The bigint key for the pg advisory lock
const MIGRATION_LOCK_ID = 59129034;
class MigrationNeededError extends Error {
  constructor() {
    super('MIGRATION_NEEDED');
    this.name = 'MigrationNeededError';
  }
}

function getMigrationError(error: unknown): string {
  // P2010: Raw query failed error
  if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2010') {
    if (error.meta?.code === 'P0001') {
      const errorName = (error.meta as { message: string }).message.split(' ')[1];
      return errorName;
    }
  }
  throw error;
}

function isMigrationNeededError(error: unknown): boolean {
  if (error instanceof Prisma.PrismaClientKnownRequestError) {
    // 42P01: relation does not exist error
    if (/relation "(?:.*\.)?SchemaMigration" does not exist/.test(error.message) || /No such table: (?:.*\.)?SchemaMigration/.test(error.message)) {
      return true;
    }
  }
  if (error instanceof MigrationNeededError) {
    return true;
  }
  return false;
}

async function getAppliedMigrations(options: {
  prismaClient: PrismaClient,
  schema: string,
}) {
  // eslint-disable-next-line no-restricted-syntax
  const [_1, _2, _3, appliedMigrations] = await options.prismaClient.$transaction([
    options.prismaClient.$executeRaw`SELECT pg_advisory_xact_lock(${MIGRATION_LOCK_ID})`,
    options.prismaClient.$executeRaw(Prisma.sql`
      SET search_path TO ${sqlQuoteIdent(options.schema)};
    `),
    options.prismaClient.$executeRaw`
      DO $$
      BEGIN
        CREATE TABLE IF NOT EXISTS "SchemaMigration" (
          "id" TEXT NOT NULL DEFAULT gen_random_uuid(),
          "finishedAt" TIMESTAMP(3) NOT NULL,
          "migrationName" TEXT NOT NULL UNIQUE,
          CONSTRAINT "SchemaMigration_pkey" PRIMARY KEY ("id")
        );
        
        IF EXISTS (
          SELECT 1 FROM information_schema.tables 
          WHERE table_name = '_prisma_migrations'
        ) THEN
          INSERT INTO "SchemaMigration" ("migrationName", "finishedAt")
          SELECT 
            migration_name, 
            finished_at
          FROM _prisma_migrations
          WHERE migration_name NOT IN (
            SELECT "migrationName" FROM "SchemaMigration"
          )
          AND finished_at IS NOT NULL;
        END IF;
      END $$;
    `,
    options.prismaClient.$queryRaw`SELECT "migrationName" FROM "SchemaMigration"`,
  ]);

  return (appliedMigrations as { migrationName: string }[]).map((migration) => migration.migrationName);
}

export async function applyMigrations(options: {
  prismaClient: PrismaClient,
  migrationFiles?: { migrationName: string, sql: string }[],
  artificialDelayInSeconds?: number,
  logging?: boolean,
  schema: string,
}): Promise<{
  newlyAppliedMigrationNames: string[],
}> {
  const migrationFiles = options.migrationFiles ?? MIGRATION_FILES;
  const appliedMigrationNames = await getAppliedMigrations({ prismaClient: options.prismaClient, schema: options.schema });
  const newMigrationFiles = migrationFiles.filter(x => !appliedMigrationNames.includes(x.migrationName));

  const log = (msg: string, ...args: any[]) => {
    if (options.logging) {
      console.log(`[${new Date().toISOString().slice(11, 23)}] ${msg}`, ...args);
    }
  };

  const newlyAppliedMigrationNames: string[] = [];
  for (const migration of newMigrationFiles) {

    let shouldRepeat = true;
    for (let repeat = 0; shouldRepeat; repeat++) {
      log(`Applying migration ${migration.migrationName}${repeat > 0 ? ` (repeat ${repeat})` : ''}`);

      // eslint-disable-next-line no-restricted-syntax
      await options.prismaClient.$transaction(async (tx) => {
        log(`  |> Preparing...`);
        await tx.$executeRaw`
          SELECT pg_advisory_xact_lock(${MIGRATION_LOCK_ID});
        `;

        await tx.$executeRaw(Prisma.sql`
          SET search_path TO ${sqlQuoteIdent(options.schema)};
        `);

        const existingMigration = await tx.$queryRaw`
          SELECT 1 FROM "SchemaMigration"
          WHERE "migrationName" = ${migration.migrationName}
        ` as { "?column?": number }[];
        if (existingMigration.length > 0) {
          log(`  |> Migration ${migration.migrationName} already applied, skipping`);
          shouldRepeat = false;
          return;
        }

        for (const statement of migration.sql.split('SPLIT_STATEMENT_SENTINEL')) {
          const runOutside = statement.includes('RUN_OUTSIDE_TRANSACTION_SENTINEL');
          const isSingleStatement = statement.includes('SINGLE_STATEMENT_SENTINEL');
          const isConditionallyRepeatMigration = statement.includes('CONDITIONALLY_REPEAT_MIGRATION_SENTINEL');

          log(`  |> Running statement${isSingleStatement ? "" : "s"}${runOutside ? " outside of transaction" : ""}...`);

          const txOrPrismaClient = runOutside ? options.prismaClient : tx;
          if (isSingleStatement) {
            const res = await txOrPrismaClient.$queryRaw`${Prisma.raw(statement)}`;
            if (isConditionallyRepeatMigration) {
              if (!Array.isArray(res)) {
                throw new StackAssertionError("Expected an array as a return value of repeat condition", { res });
              }
              if (res.length > 0) {
                if (!("should_repeat_migration" in res[0])) {
                  throw new StackAssertionError("Expected should_repeat_migration column in return value of repeat condition", { res });
                }
                if (typeof res[0].should_repeat_migration !== 'boolean') {
                  throw new StackAssertionError("Expected should_repeat_migration column in return value of repeat condition to be a boolean (found: " + typeof res[0].should_repeat_migration + ")", { res });
                }
                if (res[0].should_repeat_migration) {
                  log(`  |> Migration ${migration.migrationName} requested to be repeated. This is normal and *not* indicative of a problem.`);
                  // Commit the transaction and continue re-running the migration
                  return;
                }
              }
            }
          } else {
            await txOrPrismaClient.$executeRaw`
              DO $$
              BEGIN
                ${Prisma.raw(statement)}
              END
              $$;
            `;
          }
        }

        if (options.artificialDelayInSeconds) {
          await tx.$executeRaw`
            SELECT pg_sleep(${options.artificialDelayInSeconds});
          `;
        }

        log(`  |> Inserting migration into SchemaMigration...`);
        await tx.$executeRaw`
          INSERT INTO "SchemaMigration" ("migrationName", "finishedAt")
          VALUES (${migration.migrationName}, clock_timestamp())
        `;
        log(`  |> Done!`);
        newlyAppliedMigrationNames.push(migration.migrationName);
        shouldRepeat = false;
      }, {
        // note: in the vast majority of cases, we want our migrations to be much faster than this, but the error message
        // of this timeout is unhelpful, so we prefer relying on pg's statement timeout instead
        // (at the time of writing that one is set to 60s in prod)
        //
        // if you have a migration that's slower, consider using CONDITIONALLY_REPEAT_MIGRATION_SENTINEL
        timeout: 80_000,
      });
    }
  }

  return { newlyAppliedMigrationNames };
};

export async function runMigrationNeeded(options: {
  prismaClient: PrismaClient,
  schema: string,
  migrationFiles?: { migrationName: string, sql: string }[],
  artificialDelayInSeconds?: number,
}): Promise<void> {
  const migrationFiles = options.migrationFiles ?? MIGRATION_FILES;

  try {
    const result = await options.prismaClient.$queryRaw(Prisma.sql`
      SELECT * FROM ${sqlQuoteIdent(options.schema)}."SchemaMigration"
      ORDER BY "finishedAt" ASC
    `);
    for (const migration of migrationFiles) {
      if (!(result as any).includes(migration.migrationName)) {
        throw new MigrationNeededError();
      }
    }
  } catch (e) {
    if (isMigrationNeededError(e)) {
      await applyMigrations({
        prismaClient: options.prismaClient,
        migrationFiles: options.migrationFiles,
        artificialDelayInSeconds: options.artificialDelayInSeconds,
        schema: options.schema,
      });
    } else {
      throw e;
    }
  }
}
