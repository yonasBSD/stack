import { uploadAndGetUrl } from "@/s3";
import { Prisma } from "@prisma/client";
import { KnownErrors } from "@stackframe/stack-shared";
import { CompleteConfig, EnvironmentConfigOverrideOverride, ProjectConfigOverrideOverride } from "@stackframe/stack-shared/dist/config/schema";
import { AdminUserProjectsCrud, ProjectsCrud } from "@stackframe/stack-shared/dist/interface/crud/projects";
import { UsersCrud } from "@stackframe/stack-shared/dist/interface/crud/users";
import { getEnvVariable } from "@stackframe/stack-shared/dist/utils/env";
import { StackAssertionError } from "@stackframe/stack-shared/dist/utils/errors";
import { filterUndefined, typedFromEntries } from "@stackframe/stack-shared/dist/utils/objects";
import { generateUuid } from "@stackframe/stack-shared/dist/utils/uuids";
import { RawQuery, getPrismaClientForTenancy, globalPrismaClient, rawQuery, retryTransaction } from "../prisma-client";
import { overrideEnvironmentConfigOverride, overrideProjectConfigOverride } from "./config";
import { DEFAULT_BRANCH_ID, getSoleTenancyFromProjectBranch } from "./tenancies";

export async function listManagedProjectIds(projectUser: UsersCrud["Admin"]["Read"]) {
  const internalTenancy = await getSoleTenancyFromProjectBranch("internal", DEFAULT_BRANCH_ID);
  const internalPrisma = await getPrismaClientForTenancy(internalTenancy);
  const teams = await internalPrisma.team.findMany({
    where: {
      tenancyId: internalTenancy.id,
      teamMembers: {
        some: {
          projectUserId: projectUser.id,
        }
      }
    },
  });
  const projectIds = await globalPrismaClient.project.findMany({
    where: {
      ownerTeamId: {
        in: teams.map((team) => team.teamId),
      },
    },
    select: {
      id: true,
    },
  });
  return projectIds.map((project) => project.id);
}

export function getProjectQuery(projectId: string): RawQuery<Promise<Omit<ProjectsCrud["Admin"]["Read"], "config"> | null>> {
  return {
    supportedPrismaClients: ["global"],
    sql: Prisma.sql`
          SELECT "Project".*
          FROM "Project"
          WHERE "Project"."id" = ${projectId}
        `,
    postProcess: async (queryResult) => {
      if (queryResult.length > 1) {
        throw new StackAssertionError(`Expected 0 or 1 projects with id ${projectId}, got ${queryResult.length}`, { queryResult });
      }
      if (queryResult.length === 0) {
        return null;
      }
      const row = queryResult[0];
      return {
        id: row.id,
        display_name: row.displayName,
        description: row.description,
        logo_url: row.logoUrl,
        full_logo_url: row.fullLogoUrl,
        created_at_millis: new Date(row.createdAt + "Z").getTime(),
        is_production_mode: row.isProductionMode,
        owner_team_id: row.ownerTeamId,
      };
    },
  };
}

export async function getProject(projectId: string): Promise<Omit<ProjectsCrud["Admin"]["Read"], "config"> | null> {
  const result = await rawQuery(globalPrismaClient, getProjectQuery(projectId));
  return result;
}

export async function createOrUpdateProjectWithLegacyConfig(
  options: {
    sourceOfTruth?: ProjectConfigOverrideOverride["sourceOfTruth"],
  } & ({
    type: "create",
    projectId?: string,
    data: Omit<AdminUserProjectsCrud["Admin"]["Create"], "owner_team_id"> & { owner_team_id: string | null },
  } | {
    type: "update",
    projectId: string,
    /** The old config is specific to a tenancy, so this branchId specifies which tenancy it will update */
    branchId: string,
    data: ProjectsCrud["Admin"]["Update"],
  })
) {
  let logoUrl: string | null | undefined;
  if (options.data.logo_url !== undefined) {
    logoUrl = await uploadAndGetUrl(options.data.logo_url, "project-logos");
  }

  let fullLogoUrl: string | null | undefined;
  if (options.data.full_logo_url !== undefined) {
    fullLogoUrl = await uploadAndGetUrl(options.data.full_logo_url, "project-logos");
  }

  const [projectId, branchId] = await retryTransaction(globalPrismaClient, async (tx) => {
    let project: Prisma.ProjectGetPayload<{}>;
    let branchId: string;
    if (options.type === "create") {
      branchId = DEFAULT_BRANCH_ID;
      project = await tx.project.create({
        data: {
          id: options.projectId ?? generateUuid(),
          displayName: options.data.display_name,
          description: options.data.description ?? "",
          isProductionMode: options.data.is_production_mode ?? false,
          ownerTeamId: options.data.owner_team_id,
          logoUrl,
          fullLogoUrl,
        },
      });

      await tx.tenancy.create({
        data: {
          projectId: project.id,
          branchId,
          organizationId: null,
          hasNoOrganization: "TRUE",
        },
      });
    } else {
      const projectFound = await tx.project.findUnique({
        where: {
          id: options.projectId,
        },
      });

      if (!projectFound) {
        throw new KnownErrors.ProjectNotFound(options.projectId);
      }

      project = await tx.project.update({
        where: {
          id: projectFound.id,
        },
        data: {
          displayName: options.data.display_name,
          description: options.data.description === null ? "" : options.data.description,
          isProductionMode: options.data.is_production_mode,
          logoUrl,
          fullLogoUrl,
        },
      });
      branchId = options.branchId;
    }

    return [project.id, branchId];
  });

  // Update project config override
  await overrideProjectConfigOverride({
    projectId: projectId,
    projectConfigOverrideOverride: {
      sourceOfTruth: options.sourceOfTruth || (JSON.parse(getEnvVariable("STACK_OVERRIDE_SOURCE_OF_TRUTH", "null")) ?? undefined),
    },
  });

  // Update environment config override
  const translateDefaultPermissions = (permissions: { id: string }[] | undefined) => {
    return permissions ? typedFromEntries(permissions.map((permission) => [permission.id, true])) : undefined;
  };
  const dataOptions = options.data.config || {};
  const configOverrideOverride: EnvironmentConfigOverrideOverride = filterUndefined({
    // ======================= auth =======================
    'auth.allowSignUp': dataOptions.sign_up_enabled,
    'auth.password.allowSignIn': dataOptions.credential_enabled,
    'auth.otp.allowSignIn': dataOptions.magic_link_enabled,
    'auth.passkey.allowSignIn': dataOptions.passkey_enabled,
    'auth.oauth.accountMergeStrategy': dataOptions.oauth_account_merge_strategy,
    'auth.oauth.providers': dataOptions.oauth_providers ? typedFromEntries(dataOptions.oauth_providers
      .map((provider) => {
        return [
          provider.id,
          {
            type: provider.id,
            isShared: provider.type === "shared",
            clientId: provider.client_id,
            clientSecret: provider.client_secret,
            facebookConfigId: provider.facebook_config_id,
            microsoftTenantId: provider.microsoft_tenant_id,
            allowSignIn: true,
            allowConnectedAccounts: true,
          } satisfies CompleteConfig['auth']['oauth']['providers'][string]
        ];
      })) : undefined,
    // ======================= users =======================
    'users.allowClientUserDeletion': dataOptions.client_user_deletion_enabled,
    // ======================= teams =======================
    'teams.allowClientTeamCreation': dataOptions.client_team_creation_enabled,
    'teams.createPersonalTeamOnSignUp': dataOptions.create_team_on_sign_up,
    // ======================= domains =======================
    'domains.allowLocalhost': dataOptions.allow_localhost,
    'domains.trustedDomains': dataOptions.domains ? typedFromEntries(dataOptions.domains.map((domain) => {
      return [
        generateUuid(),
        {
          baseUrl: domain.domain,
          handlerPath: domain.handler_path,
        } satisfies CompleteConfig['domains']['trustedDomains'][string],
      ];
    })) : undefined,
    // ======================= api keys =======================
    'apiKeys.enabled.user': dataOptions.allow_user_api_keys,
    'apiKeys.enabled.team': dataOptions.allow_team_api_keys,
    // ======================= emails =======================
    'emails.server': dataOptions.email_config ? {
      isShared: dataOptions.email_config.type === 'shared',
      host: dataOptions.email_config.host,
      port: dataOptions.email_config.port,
      username: dataOptions.email_config.username,
      password: dataOptions.email_config.password,
      senderName: dataOptions.email_config.sender_name,
      senderEmail: dataOptions.email_config.sender_email,
      provider: "smtp",
    } satisfies CompleteConfig['emails']['server'] : undefined,
    'emails.selectedThemeId': dataOptions.email_theme,
    // ======================= rbac =======================
    'rbac.defaultPermissions.teamMember': translateDefaultPermissions(dataOptions.team_member_default_permissions),
    'rbac.defaultPermissions.teamCreator': translateDefaultPermissions(dataOptions.team_creator_default_permissions),
    'rbac.defaultPermissions.signUp': translateDefaultPermissions(dataOptions.user_default_permissions),
    // ======================= apps =======================
    'apps.installed': {
      authentication: { enabled: true },
      emails: { enabled: true },
    },
  });

  if (options.type === "create") {
    configOverrideOverride['rbac.permissions.team_member'] ??= {
      description: "Default permission for team members",
      scope: "team",
      containedPermissionIds: {
        '$read_members': true,
        '$invite_members': true,
      },
    } satisfies CompleteConfig['rbac']['permissions'][string];
    configOverrideOverride['rbac.permissions.team_admin'] ??= {
      description: "Default permission for team admins",
      scope: "team",
      containedPermissionIds: {
        '$update_team': true,
        '$delete_team': true,
        '$read_members': true,
        '$remove_members': true,
        '$invite_members': true,
        '$manage_api_keys': true,
      },
    } satisfies CompleteConfig['rbac']['permissions'][string];

    configOverrideOverride['rbac.defaultPermissions.teamCreator'] ??= { 'team_admin': true };
    configOverrideOverride['rbac.defaultPermissions.teamMember'] ??= { 'team_member': true };

    configOverrideOverride['auth.password.allowSignIn'] ??= true;
  }
  await overrideEnvironmentConfigOverride({
    projectId: projectId,
    branchId: branchId,
    environmentConfigOverrideOverride: configOverrideOverride,
  });


  const result = await getProject(projectId);
  if (!result) {
    throw new StackAssertionError("Project not found after creation/update", { projectId });
  }
  return result;
}
