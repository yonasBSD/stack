import { KnownErrors, StackServerInterface } from "@stackframe/stack-shared";
import { ContactChannelsCrud } from "@stackframe/stack-shared/dist/interface/crud/contact-channels";
import { ItemCrud } from "@stackframe/stack-shared/dist/interface/crud/items";
import { NotificationPreferenceCrud } from "@stackframe/stack-shared/dist/interface/crud/notification-preferences";
import { OAuthProviderCrud } from "@stackframe/stack-shared/dist/interface/crud/oauth-providers";
import { TeamApiKeysCrud, UserApiKeysCrud, teamApiKeysCreateOutputSchema, userApiKeysCreateOutputSchema } from "@stackframe/stack-shared/dist/interface/crud/project-api-keys";
import { ProjectPermissionDefinitionsCrud, ProjectPermissionsCrud } from "@stackframe/stack-shared/dist/interface/crud/project-permissions";
import { TeamInvitationCrud } from "@stackframe/stack-shared/dist/interface/crud/team-invitation";
import { TeamMemberProfilesCrud } from "@stackframe/stack-shared/dist/interface/crud/team-member-profiles";
import { TeamPermissionDefinitionsCrud, TeamPermissionsCrud } from "@stackframe/stack-shared/dist/interface/crud/team-permissions";
import { TeamsCrud } from "@stackframe/stack-shared/dist/interface/crud/teams";
import { UsersCrud } from "@stackframe/stack-shared/dist/interface/crud/users";
import { InternalSession } from "@stackframe/stack-shared/dist/sessions";
import type { AsyncCache } from "@stackframe/stack-shared/dist/utils/caches";
import { StackAssertionError, throwErr } from "@stackframe/stack-shared/dist/utils/errors";
import { ProviderType } from "@stackframe/stack-shared/dist/utils/oauth";
import { runAsynchronously } from "@stackframe/stack-shared/dist/utils/promises";
import { suspend } from "@stackframe/stack-shared/dist/utils/react";
import { Result } from "@stackframe/stack-shared/dist/utils/results";
import { useMemo } from "react"; // THIS_LINE_PLATFORM react-like
import * as yup from "yup";
import { constructRedirectUrl } from "../../../../utils/url";
import { ApiKey, ApiKeyCreationOptions, ApiKeyUpdateOptions, apiKeyCreationOptionsToCrud, apiKeyUpdateOptionsToCrud } from "../../api-keys";
import { GetCurrentUserOptions, HandlerUrls, OAuthScopesOnSignIn, TokenStoreInit, ConvexCtx } from "../../common";
import { OAuthConnection } from "../../connected-accounts";
import { ServerContactChannel, ServerContactChannelCreateOptions, ServerContactChannelUpdateOptions, serverContactChannelCreateOptionsToCrud, serverContactChannelUpdateOptionsToCrud } from "../../contact-channels";
import { InlineOffer, ServerItem } from "../../customers";
import { DataVaultStore } from "../../data-vault";
import { SendEmailOptions } from "../../email";
import { NotificationCategory } from "../../notification-categories";
import { AdminProjectPermissionDefinition, AdminTeamPermission, AdminTeamPermissionDefinition } from "../../permissions";
import { EditableTeamMemberProfile, ServerListUsersOptions, ServerTeam, ServerTeamCreateOptions, ServerTeamUpdateOptions, ServerTeamUser, Team, TeamInvitation, serverTeamCreateOptionsToCrud, serverTeamUpdateOptionsToCrud } from "../../teams";
import { ProjectCurrentServerUser, ServerOAuthProvider, ServerUser, ServerUserCreateOptions, ServerUserUpdateOptions, serverUserCreateOptionsToCrud, serverUserUpdateOptionsToCrud } from "../../users";
import { StackServerAppConstructorOptions } from "../interfaces/server-app";
import { _StackClientAppImplIncomplete } from "./client-app-impl";
import { clientVersion, createCache, createCacheBySession, getBaseUrl, getDefaultExtraRequestHeaders, getDefaultProjectId, getDefaultPublishableClientKey, getDefaultSecretServerKey } from "./common";

import { useAsyncCache } from "./common"; // THIS_LINE_PLATFORM react-like

export class _StackServerAppImplIncomplete<HasTokenStore extends boolean, ProjectId extends string> extends _StackClientAppImplIncomplete<HasTokenStore, ProjectId> {
  declare protected _interface: StackServerInterface;

  // TODO override the client user cache to use the server user cache, so we save some requests
  private readonly _currentServerUserCache = createCacheBySession(async (session) => {
    if (session.isKnownToBeInvalid()) {
      // see comment in _currentUserCache for more details on why we do this
      return null;
    }
    return await this._interface.getServerUserByToken(session);
  });
  private readonly _serverUsersCache = createCache<[
    cursor?: string,
    limit?: number,
    orderBy?: 'signedUpAt',
    desc?: boolean,
    query?: string,
    includeAnonymous?: boolean,
  ], UsersCrud['Server']['List']>(async ([cursor, limit, orderBy, desc, query, includeAnonymous]) => {
    return await this._interface.listServerUsers({ cursor, limit, orderBy, desc, query, includeAnonymous });
  });
  private readonly _serverUserCache = createCache<string[], UsersCrud['Server']['Read'] | null>(async ([userId]) => {
    const user = await this._interface.getServerUserById(userId);
    return Result.or(user, null);
  });
  private readonly _serverTeamsCache = createCache<[string | undefined], TeamsCrud['Server']['Read'][]>(async ([userId]) => {
    return await this._interface.listServerTeams({ userId });
  });
  private readonly _serverTeamUserPermissionsCache = createCache<
    [string, string, boolean],
    TeamPermissionsCrud['Server']['Read'][]
  >(async ([teamId, userId, recursive]) => {
    return await this._interface.listServerTeamPermissions({ teamId, userId, recursive }, null);
  });
  private readonly _serverUserProjectPermissionsCache = createCache<
    [string, boolean],
    ProjectPermissionsCrud['Server']['Read'][]
  >(async ([userId, recursive]) => {
    return await this._interface.listServerProjectPermissions({ userId, recursive }, null);
  });
  private readonly _serverUserOAuthConnectionAccessTokensCache = createCache<[string, string, string], { accessToken: string } | null>(
    async ([userId, providerId, scope]) => {
      try {
        const result = await this._interface.createServerProviderAccessToken(userId, providerId, scope || "");
        return { accessToken: result.access_token };
      } catch (err) {
        if (!(KnownErrors.OAuthConnectionDoesNotHaveRequiredScope.isInstance(err) || KnownErrors.OAuthConnectionNotConnectedToUser.isInstance(err))) {
          throw err;
        }
      }
      return null;
    }
  );
  private readonly _serverUserOAuthConnectionCache = createCache<[string, ProviderType, string, boolean], OAuthConnection | null>(
    async ([userId, providerId, scope, redirect]) => {
      return await this._getUserOAuthConnectionCacheFn({
        getUser: async () => Result.orThrow(await this._serverUserCache.getOrWait([userId], "write-only")),
        getOrWaitOAuthToken: async () => Result.orThrow(await this._serverUserOAuthConnectionAccessTokensCache.getOrWait([userId, providerId, scope || ""] as const, "write-only")),
        // IF_PLATFORM react-like
        useOAuthToken: () => useAsyncCache(this._serverUserOAuthConnectionAccessTokensCache, [userId, providerId, scope || ""] as const, "user.useConnectedAccount()"),
        // END_PLATFORM
        providerId,
        scope,
        redirect,
        session: null,
      });
    }
  );
  private readonly _serverTeamMemberProfilesCache = createCache<[string], TeamMemberProfilesCrud['Server']['Read'][]>(
    async ([teamId]) => {
      return await this._interface.listServerTeamMemberProfiles({ teamId });
    }
  );
  private readonly _serverTeamInvitationsCache = createCache<[string], TeamInvitationCrud['Server']['Read'][]>(
    async ([teamId]) => {
      return await this._interface.listServerTeamInvitations({ teamId });
    }
  );
  private readonly _serverUserTeamProfileCache = createCache<[string, string], TeamMemberProfilesCrud['Client']['Read']>(
    async ([teamId, userId]) => {
      return await this._interface.getServerTeamMemberProfile({ teamId, userId });
    }
  );
  private readonly _serverContactChannelsCache = createCache<[string], ContactChannelsCrud['Server']['Read'][]>(
    async ([userId]) => {
      return await this._interface.listServerContactChannels(userId);
    }
  );
  private readonly _serverNotificationCategoriesCache = createCache<[string], NotificationPreferenceCrud['Server']['Read'][]>(
    async ([userId]) => {
      return await this._interface.listServerNotificationCategories(userId);
    }
  );
  private readonly _serverDataVaultStoreValueCache = createCache<[string, string, string], string | null>(async ([storeId, key, secret]) => {
    return await this._interface.getDataVaultStoreValue(secret, storeId, key);
  });

  private readonly _serverUserApiKeysCache = createCache<[string], UserApiKeysCrud['Server']['Read'][]>(
    async ([userId]) => {
      const result = await this._interface.listProjectApiKeys({
        user_id: userId,
      }, null, "server");
      return result as UserApiKeysCrud['Server']['Read'][];
    }
  );

  private readonly _serverTeamApiKeysCache = createCache<[string], TeamApiKeysCrud['Server']['Read'][]>(
    async ([teamId]) => {
      const result = await this._interface.listProjectApiKeys({
        team_id: teamId,
      }, null, "server");
      return result as TeamApiKeysCrud['Server']['Read'][];
    }
  );

  private readonly _convexIdentitySubjectCache = createCache<[ConvexCtx], string | null>(
    async ([ctx]) => {
      const identity = await ctx.auth.getUserIdentity();
      return identity ? identity.subject : null;
    }
  );

  private readonly _serverCheckApiKeyCache = createCache<["user" | "team", string], UserApiKeysCrud['Server']['Read'] | TeamApiKeysCrud['Server']['Read'] | null>(async ([type, apiKey]) => {
    const result = await this._interface.checkProjectApiKey(
      type,
      apiKey,
      null,
      "server",
    );
    return result;
  });

  private readonly _serverOAuthProvidersCache = createCache<[string], OAuthProviderCrud['Server']['Read'][]>(
    async ([userId]) => {
      return await this._interface.listServerOAuthProviders({ user_id: userId });
    }
  );

  private readonly _serverTeamItemsCache = createCache<[string, string], ItemCrud['Client']['Read']>(
    async ([teamId, itemId]) => {
      return await this._interface.getItem({ teamId, itemId }, null);
    }
  );

  private readonly _serverUserItemsCache = createCache<[string, string], ItemCrud['Client']['Read']>(
    async ([userId, itemId]) => {
      return await this._interface.getItem({ userId, itemId }, null);
    }
  );

  private readonly _serverCustomItemsCache = createCache<[string, string], ItemCrud['Client']['Read']>(
    async ([customCustomerId, itemId]) => {
      return await this._interface.getItem({ customCustomerId, itemId }, null);
    }
  );

  private async _updateServerUser(userId: string, update: ServerUserUpdateOptions): Promise<UsersCrud['Server']['Read']> {
    const result = await this._interface.updateServerUser(userId, serverUserUpdateOptionsToCrud(update));
    await this._refreshUsers();
    return result;
  }

  protected _serverEditableTeamProfileFromCrud(crud: TeamMemberProfilesCrud['Client']['Read']): EditableTeamMemberProfile {
    const app = this;
    return {
      displayName: crud.display_name,
      profileImageUrl: crud.profile_image_url,
      async update(update: { displayName?: string, profileImageUrl?: string }) {
        await app._interface.updateServerTeamMemberProfile({
          teamId: crud.team_id,
          userId: crud.user_id,
          profile: {
            display_name: update.displayName,
            profile_image_url: update.profileImageUrl,
          },
        });
        await app._serverUserTeamProfileCache.refresh([crud.team_id, crud.user_id]);
      }
    };
  }

  protected _serverContactChannelFromCrud(userId: string, crud: ContactChannelsCrud['Server']['Read']): ServerContactChannel {
    const app = this;
    return {
      id: crud.id,
      value: crud.value,
      type: crud.type,
      isVerified: crud.is_verified,
      isPrimary: crud.is_primary,
      usedForAuth: crud.used_for_auth,
      async sendVerificationEmail(options?: { callbackUrl?: string }) {
        await app._interface.sendServerContactChannelVerificationEmail(userId, crud.id, options?.callbackUrl ?? constructRedirectUrl(app.urls.emailVerification, "callbackUrl"));
      },
      async update(data: ServerContactChannelUpdateOptions) {
        await app._interface.updateServerContactChannel(userId, crud.id, serverContactChannelUpdateOptionsToCrud(data));
        await Promise.all([
          app._serverContactChannelsCache.refresh([userId]),
          app._serverUserCache.refresh([userId])
        ]);
      },
      async delete() {
        await app._interface.deleteServerContactChannel(userId, crud.id);
        await Promise.all([
          app._serverContactChannelsCache.refresh([userId]),
          app._serverUserCache.refresh([userId])
        ]);
      },
    };
  }

  protected _serverNotificationCategoryFromCrud(userId: string, crud: NotificationPreferenceCrud['Server']['Read']): NotificationCategory {
    const app = this;
    return {
      id: crud.notification_category_id,
      name: crud.notification_category_name,
      enabled: crud.enabled,
      canDisable: crud.can_disable,

      async setEnabled(enabled: boolean) {
        await app._interface.setServerNotificationsEnabled(userId, crud.notification_category_id, enabled);
        await app._serverNotificationCategoriesCache.refresh([userId]);
      },
    };
  }

  protected _serverOAuthProviderFromCrud(crud: OAuthProviderCrud['Server']['Read']) {
    const app = this;
    return {
      id: crud.id,
      type: crud.type,
      userId: crud.user_id,
      accountId: crud.account_id,
      email: crud.email,
      allowSignIn: crud.allow_sign_in,
      allowConnectedAccounts: crud.allow_connected_accounts,

      async update(data: { accountId?: string, email?: string, allowSignIn?: boolean, allowConnectedAccounts?: boolean }): Promise<Result<void,
        InstanceType<typeof KnownErrors.OAuthProviderAccountIdAlreadyUsedForSignIn>
      >> {
        try {
          await app._interface.updateServerOAuthProvider(crud.user_id, crud.id, {
            account_id: data.accountId,
            email: data.email,
            allow_sign_in: data.allowSignIn,
            allow_connected_accounts: data.allowConnectedAccounts,
          });
          await app._serverOAuthProvidersCache.refresh([crud.user_id]);
          return Result.ok(undefined);
        } catch (error) {
          if (KnownErrors.OAuthProviderAccountIdAlreadyUsedForSignIn.isInstance(error)) {
            return Result.error(error);
          }
          throw error;
        }
      },

      async delete() {
        await app._interface.deleteServerOAuthProvider(crud.user_id, crud.id);
        await app._serverOAuthProvidersCache.refresh([crud.user_id]);
      },
    };
  }

  constructor(options:
    | StackServerAppConstructorOptions<HasTokenStore, ProjectId>
    | {
      interface: StackServerInterface,
      tokenStore: TokenStoreInit<HasTokenStore>,
      urls: Partial<HandlerUrls> | undefined,
      oauthScopesOnSignIn?: Partial<OAuthScopesOnSignIn> | undefined,
    }
  ) {
    super("interface" in options ? {
      interface: options.interface,
      tokenStore: options.tokenStore,
      urls: options.urls,
      oauthScopesOnSignIn: options.oauthScopesOnSignIn,
    } : {
      interface: new StackServerInterface({
        getBaseUrl: () => getBaseUrl(options.baseUrl),
        projectId: options.projectId ?? getDefaultProjectId(),
        extraRequestHeaders: options.extraRequestHeaders ?? getDefaultExtraRequestHeaders(),
        clientVersion,
        publishableClientKey: options.publishableClientKey ?? getDefaultPublishableClientKey(),
        secretServerKey: options.secretServerKey ?? getDefaultSecretServerKey(),
      }),
      baseUrl: options.baseUrl,
      extraRequestHeaders: options.extraRequestHeaders,
      projectId: options.projectId,
      publishableClientKey: options.publishableClientKey,
      tokenStore: options.tokenStore,
      urls: options.urls,
      oauthScopesOnSignIn: options.oauthScopesOnSignIn,
      redirectMethod: options.redirectMethod,
    });
  }


  protected _serverApiKeyFromCrud(crud: TeamApiKeysCrud['Client']['Read']): ApiKey<"team">;
  protected _serverApiKeyFromCrud(crud: UserApiKeysCrud['Client']['Read']): ApiKey<"user">;
  protected _serverApiKeyFromCrud(crud: yup.InferType<typeof teamApiKeysCreateOutputSchema>): ApiKey<"team", true>;
  protected _serverApiKeyFromCrud(crud: yup.InferType<typeof userApiKeysCreateOutputSchema>): ApiKey<"user", true>;
  protected _serverApiKeyFromCrud(crud: TeamApiKeysCrud['Client']['Read'] | UserApiKeysCrud['Client']['Read'] | yup.InferType<typeof teamApiKeysCreateOutputSchema> | yup.InferType<typeof userApiKeysCreateOutputSchema>): ApiKey<"user" | "team", boolean> {
    return {
      ...this._baseApiKeyFromCrud(crud),
      async revoke() {
        await this.update({ revoked: true });
      },
      update: async (options: ApiKeyUpdateOptions) => {
        await this._interface.updateProjectApiKey(
          crud.type === "team" ? { team_id: crud.team_id } : { user_id: crud.user_id },
          crud.id,
          await apiKeyUpdateOptionsToCrud(crud.type, options),
          null,
          "server");
        if (crud.type === "team") {
          await this._serverTeamApiKeysCache.refresh([crud.team_id]);
        } else {
          await this._serverUserApiKeysCache.refresh([crud.user_id]);
        }
      },
    };
  }

  protected _serverUserFromCrud(crud: UsersCrud['Server']['Read']): ServerUser {
    const app = this;

    async function getConnectedAccount(id: ProviderType, options?: { scopes?: string[] }): Promise<OAuthConnection | null>;
    async function getConnectedAccount(id: ProviderType, options: { or: 'redirect', scopes?: string[] }): Promise<OAuthConnection>;
    async function getConnectedAccount(id: ProviderType, options?: { or?: 'redirect', scopes?: string[] }): Promise<OAuthConnection | null> {
      const scopeString = options?.scopes?.join(" ");
      return Result.orThrow(await app._serverUserOAuthConnectionCache.getOrWait([crud.id, id, scopeString || "", options?.or === 'redirect'], "write-only"));
    }

    // IF_PLATFORM react-like
    function useConnectedAccount(id: ProviderType, options?: { scopes?: string[] }): OAuthConnection | null;
    function useConnectedAccount(id: ProviderType, options: { or: 'redirect', scopes?: string[] }): OAuthConnection;
    function useConnectedAccount(id: ProviderType, options?: { or?: 'redirect', scopes?: string[] }): OAuthConnection | null {
      const scopeString = options?.scopes?.join(" ");
      return useAsyncCache(app._serverUserOAuthConnectionCache, [crud.id, id, scopeString || "", options?.or === 'redirect'] as const, "user.useConnectedAccount()");
    }
    // END_PLATFORM

    return {
      ...super._createBaseUser(crud),
      lastActiveAt: new Date(crud.last_active_at_millis),
      serverMetadata: crud.server_metadata,
      async setPrimaryEmail(email: string | null, options?: { verified?: boolean }) {
        await app._updateServerUser(crud.id, { primaryEmail: email, primaryEmailVerified: options?.verified });
      },
      async grantPermission(scopeOrPermissionId: Team | string, permissionId?: string): Promise<void> {
        if (scopeOrPermissionId && typeof scopeOrPermissionId !== 'string' && permissionId) {
          const scope = scopeOrPermissionId;
          await app._interface.grantServerTeamUserPermission(scope.id, crud.id, permissionId);

          for (const recursive of [true, false]) {
            await app._serverTeamUserPermissionsCache.refresh([scope.id, crud.id, recursive]);
          }
        } else {
          const pId = scopeOrPermissionId as string;
          await app._interface.grantServerProjectPermission(crud.id, pId);

          for (const recursive of [true, false]) {
            await app._serverUserProjectPermissionsCache.refresh([crud.id, recursive]);
          }
        }
      },
      async revokePermission(scopeOrPermissionId: Team | string, permissionId?: string): Promise<void> {
        if (scopeOrPermissionId && typeof scopeOrPermissionId !== 'string' && permissionId) {
          const scope = scopeOrPermissionId;
          await app._interface.revokeServerTeamUserPermission(scope.id, crud.id, permissionId);

          for (const recursive of [true, false]) {
            await app._serverTeamUserPermissionsCache.refresh([scope.id, crud.id, recursive]);
          }
        } else {
          const pId = scopeOrPermissionId as string;
          await app._interface.revokeServerProjectPermission(crud.id, pId);

          for (const recursive of [true, false]) {
            await app._serverUserProjectPermissionsCache.refresh([crud.id, recursive]);
          }
        }
      },
      async delete() {
        const res = await app._interface.deleteServerUser(crud.id);
        await app._refreshUsers();
        return res;
      },
      async createSession(options: { expiresInMillis?: number, isImpersonation?: boolean }) {
        // TODO this should also refresh the access token when it expires (like InternalSession)
        const tokens = await app._interface.createServerUserSession(crud.id, options.expiresInMillis ?? 1000 * 60 * 60 * 24 * 365, options.isImpersonation ?? false);
        return {
          async getTokens() {
            return tokens;
          },
        };
      },

      async getActiveSessions() {
        const sessions = await app._interface.listServerSessions(crud.id);
        return sessions.map((session) => app._clientSessionFromCrud(session));
      },

      async revokeSession(sessionId: string) {
        await app._interface.deleteServerSession(sessionId);
      },
      async setDisplayName(displayName: string) {
        return await this.update({ displayName });
      },
      async setClientMetadata(metadata: Record<string, any>) {
        return await this.update({ clientMetadata: metadata });
      },
      async setClientReadOnlyMetadata(metadata: Record<string, any>) {
        return await this.update({ clientReadOnlyMetadata: metadata });
      },
      async setServerMetadata(metadata: Record<string, any>) {
        return await this.update({ serverMetadata: metadata });
      },
      async setSelectedTeam(team: Team | null) {
        return await this.update({ selectedTeamId: team?.id ?? null });
      },
      getConnectedAccount,
      useConnectedAccount, // THIS_LINE_PLATFORM react-like
      selectedTeam: crud.selected_team ? app._serverTeamFromCrud(crud.selected_team) : null,
      async getTeam(teamId: string) {
        const teams = await this.listTeams();
        return teams.find((t) => t.id === teamId) ?? null;
      },
      // IF_PLATFORM react-like
      useTeam(teamId: string) {
        const teams = this.useTeams();
        return useMemo(() => {
          return teams.find((t) => t.id === teamId) ?? null;
        }, [teams, teamId]);
      },
      // END_PLATFORM
      async listTeams() {
        const teams = Result.orThrow(await app._serverTeamsCache.getOrWait([crud.id], "write-only"));
        return teams.map((t) => app._serverTeamFromCrud(t));
      },
      // IF_PLATFORM react-like
      useTeams() {
        const teams = useAsyncCache(app._serverTeamsCache, [crud.id], "user.useTeams()");
        return useMemo(() => teams.map((t) => app._serverTeamFromCrud(t)), [teams]);
      },
      // END_PLATFORM
      createTeam: async (data: Omit<ServerTeamCreateOptions, "creatorUserId">) => {
        const team = await app._interface.createServerTeam(serverTeamCreateOptionsToCrud({
          creatorUserId: crud.id,
          ...data,
        }));
        await app._serverTeamsCache.refresh([undefined]);
        await app._updateServerUser(crud.id, { selectedTeamId: team.id });
        return app._serverTeamFromCrud(team);
      },
      leaveTeam: async (team: Team) => {
        await app._interface.leaveServerTeam({ teamId: team.id, userId: crud.id });
        // TODO: refresh cache
      },
      async listPermissions(scopeOrOptions?: Team | { recursive?: boolean }, options?: { recursive?: boolean }): Promise<AdminTeamPermission[]> {
        if (scopeOrOptions && 'id' in scopeOrOptions) {
          const scope = scopeOrOptions;
          const recursive = options?.recursive ?? true;
          const permissions = Result.orThrow(await app._serverTeamUserPermissionsCache.getOrWait([scope.id, crud.id, recursive], "write-only"));
          return permissions.map((crud) => app._serverPermissionFromCrud(crud));
        } else {
          const opts = scopeOrOptions;
          const recursive = opts?.recursive ?? true;
          const permissions = Result.orThrow(await app._serverUserProjectPermissionsCache.getOrWait([crud.id, recursive], "write-only"));
          return permissions.map((crud) => app._serverPermissionFromCrud(crud));
        }
      },
      // IF_PLATFORM react-like
      usePermissions(scopeOrOptions?: Team | { recursive?: boolean }, options?: { recursive?: boolean }): AdminTeamPermission[] {
        if (scopeOrOptions && 'id' in scopeOrOptions) {
          const scope = scopeOrOptions;
          const recursive = options?.recursive ?? true;
          const permissions = useAsyncCache(app._serverTeamUserPermissionsCache, [scope.id, crud.id, recursive] as const, "user.usePermissions()");
          return useMemo(() => permissions.map((crud) => app._serverPermissionFromCrud(crud)), [permissions]);
        } else {
          const opts = scopeOrOptions;
          const recursive = opts?.recursive ?? true;
          const permissions = useAsyncCache(app._serverUserProjectPermissionsCache, [crud.id, recursive] as const, "user.usePermissions()");
          return useMemo(() => permissions.map((crud) => app._serverPermissionFromCrud(crud)), [permissions]);
        }
      },
      // END_PLATFORM
      async getPermission(scopeOrPermissionId: Team | string, permissionId?: string): Promise<AdminTeamPermission | null> {
        if (scopeOrPermissionId && typeof scopeOrPermissionId !== 'string') {
          const scope = scopeOrPermissionId;
          const permissions = await this.listPermissions(scope);
          return permissions.find((p) => p.id === permissionId) ?? null;
        } else {
          const pid = scopeOrPermissionId;
          const permissions = await this.listPermissions();
          return permissions.find((p) => p.id === pid) ?? null;
        }
      },
      // IF_PLATFORM react-like
      usePermission(scopeOrPermissionId: Team | string, permissionId?: string): AdminTeamPermission | null {
        if (scopeOrPermissionId && typeof scopeOrPermissionId !== 'string') {
          const scope = scopeOrPermissionId;
          const permissions = this.usePermissions(scope);
          return useMemo(() => permissions.find((p) => p.id === permissionId) ?? null, [permissions, permissionId]);
        } else {
          const pid = scopeOrPermissionId;
          const permissions = this.usePermissions();
          return useMemo(() => permissions.find((p) => p.id === pid) ?? null, [permissions, pid]);
        }
      },
      // END_PLATFORM
      async hasPermission(scopeOrPermissionId: Team | string, permissionId?: string): Promise<boolean> {
        if (scopeOrPermissionId && typeof scopeOrPermissionId !== 'string') {
          const scope = scopeOrPermissionId;
          return (await this.getPermission(scope, permissionId as string)) !== null;
        } else {
          const pid = scopeOrPermissionId;
          return (await this.getPermission(pid)) !== null;
        }
      },
      async update(update: ServerUserUpdateOptions) {
        await app._updateServerUser(crud.id, update);
      },
      async sendVerificationEmail() {
        return await app._checkFeatureSupport("sendVerificationEmail() on ServerUser", {});
      },
      async updatePassword(options: { oldPassword: string, newPassword: string }) {
        const result = await app._interface.updatePassword(options);
        await app._serverUserCache.refresh([crud.id]);
        return result;
      },
      async setPassword(options: { password: string }) {
        const result = await this.update(options);
        await app._serverUserCache.refresh([crud.id]);
        return result;
      },
      async getTeamProfile(team: Team) {
        const result = Result.orThrow(await app._serverUserTeamProfileCache.getOrWait([team.id, crud.id], "write-only"));
        return app._serverEditableTeamProfileFromCrud(result);
      },
      // IF_PLATFORM react-like
      useTeamProfile(team: Team) {
        const result = useAsyncCache(app._serverUserTeamProfileCache, [team.id, crud.id] as const, "user.useTeamProfile()");
        return useMemo(() => app._serverEditableTeamProfileFromCrud(result), [result]);
      },
      // END_PLATFORM
      async listContactChannels() {
        const result = Result.orThrow(await app._serverContactChannelsCache.getOrWait([crud.id], "write-only"));
        return result.map((data) => app._serverContactChannelFromCrud(crud.id, data));
      },
      // IF_PLATFORM react-like
      useContactChannels() {
        const result = useAsyncCache(app._serverContactChannelsCache, [crud.id] as const, "user.useContactChannels()");
        return useMemo(() => result.map((data) => app._serverContactChannelFromCrud(crud.id, data)), [result]);
      },
      // END_PLATFORM
      createContactChannel: async (data: ServerContactChannelCreateOptions) => {
        const contactChannel = await app._interface.createServerContactChannel(serverContactChannelCreateOptionsToCrud(crud.id, data));
        await Promise.all([
          app._serverContactChannelsCache.refresh([crud.id]),
          app._serverUserCache.refresh([crud.id])
        ]);
        return app._serverContactChannelFromCrud(crud.id, contactChannel);
      },
      // IF_PLATFORM react-like
      useNotificationCategories() {
        const results = useAsyncCache(app._serverNotificationCategoriesCache, [crud.id] as const, "user.useNotificationCategories()");
        return results.map((category) => app._serverNotificationCategoryFromCrud(crud.id, category));
      },
      // END_PLATFORM
      async listNotificationCategories() {
        const results = Result.orThrow(await app._serverNotificationCategoriesCache.getOrWait([crud.id], "write-only"));
        return results.map((category) => app._serverNotificationCategoryFromCrud(crud.id, category));
      },
      // IF_PLATFORM react-like
      useApiKeys() {
        const result = useAsyncCache(app._serverUserApiKeysCache, [crud.id] as const, "user.useApiKeys()");
        return result.map((apiKey) => app._serverApiKeyFromCrud(apiKey));
      },
      // END_PLATFORM
      async listApiKeys() {
        const result = Result.orThrow(await app._serverUserApiKeysCache.getOrWait([crud.id], "write-only"));
        return result.map((apiKey) => app._serverApiKeyFromCrud(apiKey));
      },
      async createApiKey(options: ApiKeyCreationOptions<"user">) {
        const result = await app._interface.createProjectApiKey(
          await apiKeyCreationOptionsToCrud("user", crud.id, options),
          null,
          "server",
        );
        await app._serverUserApiKeysCache.refresh([crud.id]);
        return app._serverApiKeyFromCrud(result);
      },
      // IF_PLATFORM react-like
      useOAuthProviders() {
        const results = useAsyncCache(app._serverOAuthProvidersCache, [crud.id] as const, "user.useOAuthProviders()");
        return useMemo(() => results.map((oauthCrud) => app._serverOAuthProviderFromCrud(oauthCrud)), [results]);
      },
      // END_PLATFORM

      async listOAuthProviders() {
        const results = Result.orThrow(await app._serverOAuthProvidersCache.getOrWait([crud.id], "write-only"));
        return results.map((oauthCrud) => app._serverOAuthProviderFromCrud(oauthCrud));
      },

      // IF_PLATFORM react-like
      useOAuthProvider(id: string) {
        const providers = this.useOAuthProviders();
        return useMemo(() => providers.find((p) => p.id === id) ?? null, [providers, id]);
      },
      // END_PLATFORM
      async getOAuthProvider(id: string) {
        const providers = await this.listOAuthProviders();
        return providers.find((p) => p.id === id) ?? null;
      },
      async createCheckoutUrl(options: { offerId: string } | { offer: InlineOffer }) {
        const offerIdOrInline = "offerId" in options ? options.offerId : options.offer;
        return await app._interface.createCheckoutUrl("user", crud.id, offerIdOrInline, null);
      },
      async getItem(itemId: string) {
        const result = Result.orThrow(await app._serverUserItemsCache.getOrWait([crud.id, itemId], "write-only"));
        return app._serverItemFromCrud({ type: "user", id: crud.id }, result);
      },
      // IF_PLATFORM react-like
      useItem(itemId: string) {
        const result = useAsyncCache(app._serverUserItemsCache, [crud.id, itemId] as const, "user.useItem()");
        return useMemo(() => app._serverItemFromCrud({ type: "user", id: crud.id }, result), [result]);
      },
      // END_PLATFORM
    };
  }

  protected _serverTeamUserFromCrud(crud: TeamMemberProfilesCrud["Server"]["Read"]): ServerTeamUser {
    return {
      ...this._serverUserFromCrud(crud.user),
      teamProfile: {
        displayName: crud.display_name,
        profileImageUrl: crud.profile_image_url,
      },
    };
  }

  protected _serverTeamInvitationFromCrud(crud: TeamInvitationCrud['Server']['Read']): TeamInvitation {
    return {
      id: crud.id,
      recipientEmail: crud.recipient_email,
      expiresAt: new Date(crud.expires_at_millis),
      revoke: async () => {
        await this._interface.revokeServerTeamInvitation(crud.id, crud.team_id);
      },
    };
  }

  protected override _currentUserFromCrud(crud: UsersCrud['Server']['Read'], session: InternalSession): ProjectCurrentServerUser<ProjectId> {
    const app = this;
    const currentUser = {
      ...this._serverUserFromCrud(crud),
      ...this._createAuth(session),
      ...this._isInternalProject() ? this._createInternalUserExtra(session) : {},
    } satisfies ServerUser;

    Object.freeze(currentUser);
    return currentUser as ProjectCurrentServerUser<ProjectId>;
  }

  protected _serverTeamFromCrud(crud: TeamsCrud['Server']['Read']): ServerTeam {
    const app = this;
    return {
      id: crud.id,
      displayName: crud.display_name,
      profileImageUrl: crud.profile_image_url,
      createdAt: new Date(crud.created_at_millis),
      clientMetadata: crud.client_metadata,
      clientReadOnlyMetadata: crud.client_read_only_metadata,
      serverMetadata: crud.server_metadata,
      async update(update: Partial<ServerTeamUpdateOptions>) {
        await app._interface.updateServerTeam(crud.id, serverTeamUpdateOptionsToCrud(update));
        await app._serverTeamsCache.refresh([undefined]);
      },
      async delete() {
        await app._interface.deleteServerTeam(crud.id);
        await app._serverTeamsCache.refresh([undefined]);
      },
      async listUsers() {
        const result = Result.orThrow(await app._serverTeamMemberProfilesCache.getOrWait([crud.id], "write-only"));
        return result.map(u => app._serverTeamUserFromCrud(u));
      },
      // IF_PLATFORM react-like
      useUsers() {
        const result = useAsyncCache(app._serverTeamMemberProfilesCache, [crud.id] as const, "team.useUsers()");
        return useMemo(() => result.map(u => app._serverTeamUserFromCrud(u)), [result]);
      },
      // END_PLATFORM
      async addUser(userId) {
        await app._interface.addServerUserToTeam({
          teamId: crud.id,
          userId,
        });
        await app._serverTeamMemberProfilesCache.refresh([crud.id]);
      },
      async removeUser(userId) {
        await app._interface.removeServerUserFromTeam({
          teamId: crud.id,
          userId,
        });
        await app._serverTeamMemberProfilesCache.refresh([crud.id]);
      },
      async inviteUser(options: { email: string, callbackUrl?: string }) {
        await app._interface.sendServerTeamInvitation({
          teamId: crud.id,
          email: options.email,
          callbackUrl: options.callbackUrl ?? constructRedirectUrl(app.urls.teamInvitation, "callbackUrl"),
        });
        await app._serverTeamInvitationsCache.refresh([crud.id]);
      },
      async listInvitations() {
        const result = Result.orThrow(await app._serverTeamInvitationsCache.getOrWait([crud.id], "write-only"));
        return result.map((crud) => app._serverTeamInvitationFromCrud(crud));
      },
      // IF_PLATFORM react-like
      useInvitations() {
        const result = useAsyncCache(app._serverTeamInvitationsCache, [crud.id] as const, "team.useInvitations()");
        return useMemo(() => result.map((crud) => app._serverTeamInvitationFromCrud(crud)), [result]);
      },
      // END_PLATFORM
      // IF_PLATFORM react-like
      useApiKeys() {
        const result = useAsyncCache(app._serverTeamApiKeysCache, [crud.id] as const, "team.useApiKeys()");
        return result.map((apiKey) => app._serverApiKeyFromCrud(apiKey));
      },
      // END_PLATFORM
      async listApiKeys() {
        const result = Result.orThrow(await app._serverTeamApiKeysCache.getOrWait([crud.id], "write-only"));
        return result.map((apiKey) => app._serverApiKeyFromCrud(apiKey));
      },
      async createApiKey(options: ApiKeyCreationOptions<"team">) {
        const result = await app._interface.createProjectApiKey(
          await apiKeyCreationOptionsToCrud("team", crud.id, options),
          null,
          "server",
        );
        await app._serverTeamApiKeysCache.refresh([crud.id]);
        return app._serverApiKeyFromCrud(result);
      },
      async getItem(itemId: string) {
        const result = Result.orThrow(await app._serverTeamItemsCache.getOrWait([crud.id, itemId], "write-only"));
        return app._serverItemFromCrud({ type: "team", id: crud.id }, result);
      },
      // IF_PLATFORM react-like
      useItem(itemId: string) {
        const result = useAsyncCache(app._serverTeamItemsCache, [crud.id, itemId] as const, "team.useItem()");
        return useMemo(() => app._serverItemFromCrud({ type: "team", id: crud.id }, result), [result]);
      },
      // END_PLATFORM
      async createCheckoutUrl(options: { offerId: string } | { offer: InlineOffer }) {
        const offerIdOrInline = "offerId" in options ? options.offerId : options.offer;
        return await app._interface.createCheckoutUrl("team", crud.id, offerIdOrInline, null);
      },
    };
  }

  protected _serverItemFromCrud(customer: { type: "user" | "team" | "custom", id: string }, crud: ItemCrud['Client']['Read']): ServerItem {
    const app = this;
    return {
      displayName: crud.display_name,
      quantity: crud.quantity,
      nonNegativeQuantity: Math.max(0, crud.quantity),
      increaseQuantity: async (delta: number) => {
        const updateOptions = customer.type === "user"
          ? { itemId: crud.id, userId: customer.id }
          : customer.type === "team"
            ? { itemId: crud.id, teamId: customer.id }
            : { itemId: crud.id, customCustomerId: customer.id };
        await app._interface.updateItemQuantity(updateOptions, { delta });
        if (customer.type === "user") await app._serverUserItemsCache.refresh([customer.id, crud.id]);
        else if (customer.type === "team") await app._serverTeamItemsCache.refresh([customer.id, crud.id]);
        else await app._serverCustomItemsCache.refresh([customer.id, crud.id]);
      },
      decreaseQuantity: async (delta: number) => {
        const updateOptions = customer.type === "user"
          ? { itemId: crud.id, userId: customer.id }
          : customer.type === "team"
            ? { itemId: crud.id, teamId: customer.id }
            : { itemId: crud.id, customCustomerId: customer.id };
        await app._interface.updateItemQuantity(updateOptions, { delta: -delta, allow_negative: true });
        if (customer.type === "user") await app._serverUserItemsCache.refresh([customer.id, crud.id]);
        else if (customer.type === "team") await app._serverTeamItemsCache.refresh([customer.id, crud.id]);
        else await app._serverCustomItemsCache.refresh([customer.id, crud.id]);
      },
      tryDecreaseQuantity: async (delta: number) => {
        try {
          const updateOptions = customer.type === "user"
            ? { itemId: crud.id, userId: customer.id }
            : customer.type === "team"
              ? { itemId: crud.id, teamId: customer.id }
              : { itemId: crud.id, customCustomerId: customer.id };
          await app._interface.updateItemQuantity(updateOptions, { delta: -delta });
          if (customer.type === "user") await app._serverUserItemsCache.refresh([customer.id, crud.id]);
          else if (customer.type === "team") await app._serverTeamItemsCache.refresh([customer.id, crud.id]);
          else await app._serverCustomItemsCache.refresh([customer.id, crud.id]);
          return true;
        } catch (error) {
          if (error instanceof KnownErrors.ItemQuantityInsufficientAmount) {
            return false;
          }
          throw error;
        }
      },
    };
  }

  protected async _getUserApiKey(options: { apiKey: string }): Promise<ApiKey<"user"> | null> {
    const crud = Result.orThrow(await this._serverCheckApiKeyCache.getOrWait(["user", options.apiKey], "write-only")) as UserApiKeysCrud['Server']['Read'] | null;
    return crud ? this._serverApiKeyFromCrud(crud) : null;
  }

  protected async _getTeamApiKey(options: { apiKey: string }): Promise<ApiKey<"team"> | null> {
    const crud = Result.orThrow(await this._serverCheckApiKeyCache.getOrWait(["team", options.apiKey], "write-only")) as TeamApiKeysCrud['Server']['Read'] | null;
    return crud ? this._serverApiKeyFromCrud(crud) : null;
  }
  // IF_PLATFORM react-like
  protected _useUserApiKey(options: { apiKey: string }): ApiKey<"user"> | null {
    const crud = useAsyncCache(this._serverCheckApiKeyCache, ["user", options.apiKey] as const, "useUserApiKey()") as UserApiKeysCrud['Server']['Read'] | null;
    return useMemo(() => crud ? this._serverApiKeyFromCrud(crud) : null, [crud]);
  }
  // END_PLATFORM
  // IF_PLATFORM react-like
  protected _useTeamApiKey(options: { apiKey: string }): ApiKey<"team"> | null {
    const crud = useAsyncCache(this._serverCheckApiKeyCache, ["team", options.apiKey] as const, "useTeamApiKey()") as TeamApiKeysCrud['Server']['Read'] | null;
    return useMemo(() => crud ? this._serverApiKeyFromCrud(crud) : null, [crud]);
  }
  // END_PLATFORM
  protected async _getUserByApiKey(apiKey: string): Promise<ServerUser | null> {
    const apiKeyObject = await this._getUserApiKey({ apiKey });
    if (apiKeyObject === null) {
      return null;
    }
    return await this.getServerUserById(apiKeyObject.userId);
  }

  protected async _getUserByConvex(ctx: ConvexCtx, includeAnonymous: boolean): Promise<ServerUser | null> {
    const identity = await ctx.auth.getUserIdentity();
    if (identity === null) {
      return null;
    }
    const user = await this.getServerUserById(identity.subject);
    if (user?.isAnonymous && !includeAnonymous) {
      return null;
    }
    return user;
  }
  // IF_PLATFORM react-like
  protected _useUserByConvex(ctx: ConvexCtx, includeAnonymous: boolean): ServerUser | null {
    const subject = useAsyncCache(this._convexIdentitySubjectCache, [ctx] as const, "useUserByConvex()");
    if (subject === null) {
      return null;
    }
    const user = this.useUserById(subject);
    if (user?.isAnonymous && !includeAnonymous) {
      return null;
    }
    return user;
  }
  // END_PLATFORM
  // IF_PLATFORM react-like
  protected _useUserByApiKey(apiKey: string): ServerUser | null {
    const apiKeyObject = this._useUserApiKey({ apiKey });
    if (apiKeyObject === null) {
      return null;
    }
    return this.useUserById(apiKeyObject.userId);
  }
  // END_PLATFORM

  protected async _getTeamByApiKey(apiKey: string): Promise<ServerTeam | null> {
    const apiKeyObject = await this._getTeamApiKey({ apiKey });
    if (apiKeyObject === null) {
      return null;
    }
    return await this.getTeam(apiKeyObject.teamId);
  }
  // IF_PLATFORM react-like
  protected _useTeamByApiKey(apiKey: string): ServerTeam | null {
    const apiKeyObject = this._useTeamApiKey({ apiKey });
    if (apiKeyObject === null) {
      return null;
    }
    return this.useTeam(apiKeyObject.teamId);
  }
  // END_PLATFORM

  async createUser(options: ServerUserCreateOptions): Promise<ServerUser> {
    const crud = await this._interface.createServerUser(serverUserCreateOptionsToCrud(options));
    await this._refreshUsers();
    return this._serverUserFromCrud(crud);
  }

  async getUser(options: GetCurrentUserOptions<HasTokenStore> & { or: 'redirect' }): Promise<ProjectCurrentServerUser<ProjectId>>;
  async getUser(options: GetCurrentUserOptions<HasTokenStore> & { or: 'throw' }): Promise<ProjectCurrentServerUser<ProjectId>>;
  async getUser(options: GetCurrentUserOptions<HasTokenStore> & { or: 'anonymous' }): Promise<ProjectCurrentServerUser<ProjectId>>;
  async getUser(options?: GetCurrentUserOptions<HasTokenStore>): Promise<ProjectCurrentServerUser<ProjectId> | null>;
  async getUser(id: string): Promise<ServerUser | null>;
  async getUser(options: { apiKey: string }): Promise<ServerUser | null>;
  async getUser(options: { from: "convex", ctx: ConvexCtx, or?: "return-null" | "anonymous" }): Promise<ServerUser | null>;
  async getUser(options?: string | GetCurrentUserOptions<HasTokenStore> | { apiKey: string } | { from: "convex", ctx: ConvexCtx }): Promise<ProjectCurrentServerUser<ProjectId> | ServerUser | null> {
    if (typeof options === "string") {
      return await this.getServerUserById(options);
    } else if (typeof options === "object" && "apiKey" in options) {
      return await this._getUserByApiKey(options.apiKey);
    } else if (typeof options === "object" && "from" in options && options.from as string === "convex") {
      return await this._getUserByConvex(options.ctx, "or" in options && options.or === "anonymous");
    } else {
      options = options as GetCurrentUserOptions<HasTokenStore> | undefined;
      // TODO this code is duplicated from the client app; fix that
      this._ensurePersistentTokenStore(options?.tokenStore);
      const session = await this._getSession(options?.tokenStore);
      let crud = Result.orThrow(await this._currentServerUserCache.getOrWait([session], "write-only"));
      if (crud?.is_anonymous && options?.or !== "anonymous" && options?.or !== "anonymous-if-exists[deprecated]") {
        crud = null;
      }

      if (crud === null) {
        switch (options?.or) {
          case 'redirect': {
            await this.redirectToSignIn({ replace: true });
            break;
          }
          case 'throw': {
            throw new Error("User is not signed in but getUser was called with { or: 'throw' }");
          }
          case 'anonymous': {
            const tokens = await this._signUpAnonymously();
            return await this.getUser({ tokenStore: tokens, or: "anonymous-if-exists[deprecated]" }) ?? throwErr("Something went wrong while signing up anonymously");
          }
          case undefined:
          case "anonymous-if-exists[deprecated]":
          case "return-null": {
            return null;
          }
        }
      }

      return crud && this._currentUserFromCrud(crud, session);
    }
  }

  async getServerUser(): Promise<ProjectCurrentServerUser<ProjectId> | null> {
    console.warn("stackServerApp.getServerUser is deprecated; use stackServerApp.getUser instead");
    return await this.getUser();
  }

  async getServerUserById(userId: string): Promise<ServerUser | null> {
    const crud = Result.orThrow(await this._serverUserCache.getOrWait([userId], "write-only"));
    return crud && this._serverUserFromCrud(crud);
  }

  // IF_PLATFORM react-like
  useUser(options: GetCurrentUserOptions<HasTokenStore> & { or: 'redirect' }): ProjectCurrentServerUser<ProjectId>;
  useUser(options: GetCurrentUserOptions<HasTokenStore> & { or: 'throw' }): ProjectCurrentServerUser<ProjectId>;
  useUser(options: GetCurrentUserOptions<HasTokenStore> & { or: 'anonymous' }): ProjectCurrentServerUser<ProjectId>;
  useUser(options?: GetCurrentUserOptions<HasTokenStore>): ProjectCurrentServerUser<ProjectId> | null;
  useUser(id: string): ServerUser | null;
  useUser(options: { apiKey: string }): ServerUser | null;
  useUser(options: { from: "convex", ctx: ConvexCtx, or?: "return-null" | "anonymous" }): ServerUser | null;
  useUser(options?: GetCurrentUserOptions<HasTokenStore> | string | { apiKey: string } | { from: "convex", ctx: ConvexCtx }): ProjectCurrentServerUser<ProjectId> | ServerUser | null {
    if (typeof options === "string") {
      return this.useUserById(options);
    } else if (typeof options === "object" && "apiKey" in options) {
      return this._useUserByApiKey(options.apiKey);
    } else if (typeof options === "object" && "from" in options && options.from as string === "convex") {
      return this._useUserByConvex(options.ctx, "or" in options && options.or === "anonymous");
    } else {
      options = options as GetCurrentUserOptions<HasTokenStore> | undefined;
      // TODO this code is duplicated from the client app; fix that
      this._ensurePersistentTokenStore(options?.tokenStore);

      const session = this._useSession(options?.tokenStore);
      let crud = useAsyncCache(this._currentServerUserCache, [session] as const, "useUser()");
      if (crud?.is_anonymous && options?.or !== "anonymous" && options?.or !== "anonymous-if-exists[deprecated]") {
        crud = null;
      }

      if (crud === null) {
        switch (options?.or) {
          case 'redirect': {
            runAsynchronously(this.redirectToSignIn({ replace: true }));
            suspend();
            throw new StackAssertionError("suspend should never return");
          }
          case 'throw': {
            throw new Error("User is not signed in but useUser was called with { or: 'throw' }");
          }
          case 'anonymous': {
            // TODO we should think about the behavior when calling useUser (or getUser) in anonymous with a custom token store. signUpAnonymously always sets the current token store on app level, instead of the one passed to this function
            // TODO we shouldn't reload & suspend here, instead we should use a promise that resolves to the new anonymous user
            runAsynchronously(async () => {
              await this._signUpAnonymously();
              if (typeof window !== "undefined") {
                window.location.reload();
              }
            });
            suspend();
            throw new StackAssertionError("suspend should never return");
          }
          case undefined:
          case "anonymous-if-exists[deprecated]":
          case "return-null": {
            // do nothing
          }
        }
      }

      return useMemo(() => {
        return crud && this._currentUserFromCrud(crud, session);
      }, [crud, session, options?.or]);
    }
  }
  // END_PLATFORM
  // IF_PLATFORM react-like
  useUserById(userId: string): ServerUser | null {
    const crud = useAsyncCache(this._serverUserCache, [userId], "useUserById()");
    return useMemo(() => {
      return crud && this._serverUserFromCrud(crud);
    }, [crud]);
  }
  // END_PLATFORM

  async listUsers(options?: ServerListUsersOptions): Promise<ServerUser[] & { nextCursor: string | null }> {
    const crud = Result.orThrow(await this._serverUsersCache.getOrWait([options?.cursor, options?.limit, options?.orderBy, options?.desc, options?.query, options?.includeAnonymous], "write-only"));
    const result: any = crud.items.map((j) => this._serverUserFromCrud(j));
    result.nextCursor = crud.pagination?.next_cursor ?? null;
    return result as any;
  }

  // IF_PLATFORM react-like
  useUsers(options?: ServerListUsersOptions): ServerUser[] & { nextCursor: string | null } {
    const crud = useAsyncCache(this._serverUsersCache, [options?.cursor, options?.limit, options?.orderBy, options?.desc, options?.query] as const, "useServerUsers()");
    const result: any = crud.items.map((j) => this._serverUserFromCrud(j));
    result.nextCursor = crud.pagination?.next_cursor ?? null;
    return result as any;
  }
  // END_PLATFORM

  _serverPermissionFromCrud(crud: TeamPermissionsCrud['Server']['Read'] | ProjectPermissionsCrud['Server']['Read']): AdminTeamPermission {
    return {
      id: crud.id,
    };
  }

  _serverTeamPermissionDefinitionFromCrud(crud: TeamPermissionDefinitionsCrud['Admin']['Read']): AdminTeamPermissionDefinition {
    return {
      id: crud.id,
      description: crud.description,
      containedPermissionIds: crud.contained_permission_ids,
    };
  }

  _serverProjectPermissionDefinitionFromCrud(crud: ProjectPermissionDefinitionsCrud['Admin']['Read']): AdminProjectPermissionDefinition {
    return {
      id: crud.id,
      description: crud.description,
      containedPermissionIds: crud.contained_permission_ids,
    };
  }

  async listTeams(): Promise<ServerTeam[]> {
    const teams = Result.orThrow(await this._serverTeamsCache.getOrWait([undefined], "write-only"));
    return teams.map((t) => this._serverTeamFromCrud(t));
  }

  async getItem(options: { itemId: string, userId: string } | { itemId: string, teamId: string } | { itemId: string, customCustomerId: string }): Promise<ServerItem> {
    if ("userId" in options) {
      const result = Result.orThrow(await this._serverUserItemsCache.getOrWait([options.userId, options.itemId], "write-only"));
      return this._serverItemFromCrud({ type: "user", id: options.userId }, result);
    } else if ("teamId" in options) {
      const result = Result.orThrow(await this._serverTeamItemsCache.getOrWait([options.teamId, options.itemId], "write-only"));
      return this._serverItemFromCrud({ type: "team", id: options.teamId }, result);
    } else {
      const result = Result.orThrow(await this._serverCustomItemsCache.getOrWait([options.customCustomerId, options.itemId], "write-only"));
      return this._serverItemFromCrud({ type: "custom", id: options.customCustomerId }, result);
    }
  }

  // IF_PLATFORM react-like
  useItem(options: { itemId: string, userId: string } | { itemId: string, teamId: string } | { itemId: string, customCustomerId: string }): ServerItem {
    let type: "user" | "team" | "custom";
    let id: string;
    let cache: AsyncCache<[string, string], Result<ItemCrud['Client']['Read']>>;
    if ("userId" in options) {
      type = "user";
      id = options.userId;
      cache = this._serverUserItemsCache;
    } else if ("teamId" in options) {
      type = "team";
      id = options.teamId;
      cache = this._serverTeamItemsCache;
    } else {
      type = "custom";
      id = options.customCustomerId;
      cache = this._serverCustomItemsCache;
    }

    const cacheKey = [id, options.itemId] as [string, string];
    const debugLabel = `app.useItem(${type})`;
    const result = useAsyncCache(cache, cacheKey, debugLabel);
    return useMemo(() => this._serverItemFromCrud({ type, id }, result), [result]);
  }
  // END_PLATFORM

  async createTeam(data: ServerTeamCreateOptions): Promise<ServerTeam> {
    const team = await this._interface.createServerTeam(serverTeamCreateOptionsToCrud(data));
    await this._serverTeamsCache.refresh([undefined]);
    return this._serverTeamFromCrud(team);
  }

  // IF_PLATFORM react-like
  useTeams(): ServerTeam[] {
    const teams = useAsyncCache(this._serverTeamsCache, [undefined], "useServerTeams()");
    return useMemo(() => {
      return teams.map((t) => this._serverTeamFromCrud(t));
    }, [teams]);
  }
  // END_PLATFORM

  async getTeam(options: { apiKey: string }): Promise<ServerTeam | null>;
  async getTeam(teamId: string): Promise<ServerTeam | null>;
  async getTeam(options?: { apiKey: string } | string): Promise<ServerTeam | null> {
    if (typeof options === "object" && "apiKey" in options) {
      return await this._getTeamByApiKey(options.apiKey);
    } else {
      const teamId = options;
      const teams = await this.listTeams();
      return teams.find((t) => t.id === teamId) ?? null;
    }
  }

  // IF_PLATFORM react-like
  useTeam(options: { apiKey: string }): ServerTeam | null;
  useTeam(teamId: string): ServerTeam | null;
  useTeam(options?: { apiKey: string } | string): ServerTeam | null {
    if (typeof options === "object" && "apiKey" in options) {
      return this._useTeamByApiKey(options.apiKey);
    } else {
      const teamId = options;
      const teams = this.useTeams();
      return useMemo(() => {
        return teams.find((t) => t.id === teamId) ?? null;
      }, [teams, teamId]);
    }
  }
  // END_PLATFORM

  protected _createServerDataVaultStore(id: string): DataVaultStore {
    const validateOptions = (options: { secret: string }) => {
      if (typeof options.secret !== "string") throw new Error("secret must be a string, got " + typeof options.secret);
    };
    return {
      id,
      setValue: async (key, value, options) => {
        validateOptions(options);
        await this._interface.setDataVaultStoreValue(options.secret, id, key, value);
      },
      getValue: async (key, options) => {
        validateOptions(options);
        return Result.orThrow(await this._serverDataVaultStoreValueCache.getOrWait([id, key, options.secret], "write-only"));
      },
      // IF_PLATFORM react-like
      useValue: (key, options) => {
        validateOptions(options);
        return useAsyncCache(this._serverDataVaultStoreValueCache, [id, key, options.secret] as const, `app.useDataVaultStoreValue()`);
      },
      // END_PLATFORM
    };
  }

  async getDataVaultStore(id: string): Promise<DataVaultStore> {
    return this._createServerDataVaultStore(id);
  }

  // IF_PLATFORM react-like
  useDataVaultStore(id: string): DataVaultStore {
    return useMemo(() => this._createServerDataVaultStore(id), [id]);
  }
  // END_PLATFORM

  async sendEmail(options: SendEmailOptions): Promise<void> {
    await this._interface.sendEmail(options);
  }

  protected override async _refreshSession(session: InternalSession) {
    await Promise.all([
      super._refreshUser(session),
      this._currentServerUserCache.refresh([session]),
    ]);
  }

  protected override async _refreshUsers() {
    await Promise.all([
      super._refreshUsers(),
      this._serverUserCache.refreshWhere(() => true),
      this._serverUsersCache.refreshWhere(() => true),
      this._serverContactChannelsCache.refreshWhere(() => true),
      this._serverOAuthProvidersCache.refreshWhere(() => true),
    ]);
  }

  async createOAuthProvider(options: {
    userId: string,
    providerConfigId: string,
    accountId: string,
    email: string,
    allowSignIn: boolean,
    allowConnectedAccounts: boolean,
  }): Promise<Result<ServerOAuthProvider, InstanceType<typeof KnownErrors.OAuthProviderAccountIdAlreadyUsedForSignIn>>> {
    try {
      const crud = await this._interface.createServerOAuthProvider({
        user_id: options.userId,
        provider_config_id: options.providerConfigId,
        account_id: options.accountId,
        email: options.email,
        allow_sign_in: options.allowSignIn,
        allow_connected_accounts: options.allowConnectedAccounts,
      });

      await this._serverOAuthProvidersCache.refresh([options.userId]);
      return Result.ok(this._serverOAuthProviderFromCrud(crud));
    } catch (error) {
      if (KnownErrors.OAuthProviderAccountIdAlreadyUsedForSignIn.isInstance(error)) {
        return Result.error(error);
      }
      throw error;
    }
  }
}
